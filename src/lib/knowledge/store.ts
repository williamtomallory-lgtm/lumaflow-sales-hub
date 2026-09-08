import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { KnowledgeCategory } from "../business";
import {
  formatKnowledgeSize,
  KNOWLEDGE_MAX_FILE_BYTES,
  KNOWLEDGE_MAX_FILE_COUNT,
  KNOWLEDGE_CLASSIFICATION_MAX_CHARS,
  KNOWLEDGE_MAX_NAME_CHARS,
  KNOWLEDGE_MAX_TEXT_CHARS,
  KNOWLEDGE_MAX_TOTAL_BYTES,
  knowledgeClassificationSourceSchema,
  knowledgeClassificationStatusSchema,
  knowledgeCategorySchema,
  knowledgeParseStatusSchema,
  knowledgeStorageSourceSchema,
  type KnowledgeClassification,
  type KnowledgeEntry,
  type KnowledgeParseStatus,
  type StoredKnowledgeRecord,
} from "./contracts";

// Tests may opt into an isolated ignored directory; production always uses the
// fixed project-local archive and never accepts a user-controlled storage path.
const testDirectory = process.env.NODE_ENV === "test" ? process.env.LUMAFLOW_KNOWLEDGE_TEST_DIR?.trim() : undefined;
const KNOWLEDGE_DIRECTORY = path.resolve(testDirectory || path.join(process.cwd(), ".local-data", "knowledge"));
const KNOWLEDGE_FILES_DIRECTORY = path.join(KNOWLEDGE_DIRECTORY, "files");
const KNOWLEDGE_METADATA_DIRECTORY = path.join(KNOWLEDGE_DIRECTORY, "metadata");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const storedKnowledgeRecordSchema: z.ZodType<StoredKnowledgeRecord> = z.object({
  id: z.string().regex(UUID_PATTERN),
  originalName: z.string().min(1).max(KNOWLEDGE_MAX_NAME_CHARS),
  mimeType: z.string().min(1).max(200),
  extension: z.string().max(40),
  sizeBytes: z.number().int().nonnegative().max(KNOWLEDGE_MAX_FILE_BYTES),
  sizeLabel: z.string().min(1).max(40),
  sha256Prefix: z.string().regex(/^[0-9a-f]{12}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  uploadedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  classificationStatus: knowledgeClassificationStatusSchema,
  classificationSource: knowledgeClassificationSourceSchema,
  category: knowledgeCategorySchema.nullable(),
  title: z.string().min(1).max(240),
  summary: z.string().max(1_200),
  tags: z.array(z.string().min(1).max(80)).max(12),
  confidence: z.number().finite().min(0).max(1).nullable(),
  classificationError: z.string().max(500).nullable(),
  parseStatus: knowledgeParseStatusSchema,
  parseError: z.string().max(500).nullable(),
  characters: z.number().int().nonnegative().max(KNOWLEDGE_MAX_FILE_BYTES),
  classificationCharacters: z.number().int().nonnegative().max(KNOWLEDGE_CLASSIFICATION_MAX_CHARS),
  pages: z.number().int().positive().nullable(),
  truncated: z.boolean(),
  hasText: z.boolean(),
  source: knowledgeStorageSourceSchema,
  version: z.string().min(1).max(40),
  owner: z.string().min(1).max(120),
  downloadUrl: z.string().regex(/^\/api\/v1\/knowledge\/[0-9a-f-]+\/download$/i),
  textPreview: z.string().max(1_200),
  storageFileName: z.string().regex(/^[0-9a-f-]+\.bin$/i),
  extractedText: z.string().max(KNOWLEDGE_MAX_TEXT_CHARS).nullable(),
}).strict();

export class KnowledgeStoreError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "KnowledgeStoreError";
  }
}

export type KnowledgeParseInput = {
  status: KnowledgeParseStatus;
  text?: string;
  characters?: number;
  pages?: number;
  truncated?: boolean;
  error?: string;
};

export type KnowledgeDownload = {
  stream: ReturnType<typeof createReadStream>;
  sizeBytes: number;
  mimeType: string;
  originalName: string;
};

const globalKnowledgeState = globalThis as typeof globalThis & {
  lumaflowKnowledgeMutationQueue?: Promise<void>;
};

function withMutationLock<T>(operation: () => Promise<T>) {
  const previous = globalKnowledgeState.lumaflowKnowledgeMutationQueue ?? Promise.resolve();
  const run = previous.then(operation);
  globalKnowledgeState.lumaflowKnowledgeMutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function ensureDirectories() {
  await mkdir(KNOWLEDGE_FILES_DIRECTORY, { recursive: true });
  await mkdir(KNOWLEDGE_METADATA_DIRECTORY, { recursive: true });
}

function safeId(id: string) {
  if (!UUID_PATTERN.test(id)) throw new KnowledgeStoreError(400, "INVALID_KNOWLEDGE_ID", "Invalid knowledge document id.");
  return id.toLowerCase();
}

function metadataPath(id: string) {
  return path.join(KNOWLEDGE_METADATA_DIRECTORY, `${safeId(id)}.json`);
}

function filePath(id: string) {
  return path.join(KNOWLEDGE_FILES_DIRECTORY, `${safeId(id)}.bin`);
}

function normalizeOriginalName(name: string) {
  const normalized = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "_")
    .trim()
    .slice(0, KNOWLEDGE_MAX_NAME_CHARS);
  return normalized || "未命名文件";
}

function normalizeMimeType(mimeType: string) {
  const normalized = mimeType.trim().slice(0, 200);
  return /^[\w.+-]+\/[\w.+-]+(?:\s*;.*)?$/i.test(normalized) ? normalized : "application/octet-stream";
}

function extensionOf(name: string) {
  const value = name.split(".").pop()?.toLowerCase() ?? "";
  return /^[a-z0-9]{1,32}$/.test(value) ? value : "";
}

function safeText(value: string | undefined) {
  return (value ?? "").replace(/\0/g, "").slice(0, KNOWLEDGE_MAX_TEXT_CHARS);
}

function friendlyParseError(error: string | undefined) {
  if (!error) return null;
  // Parser messages are intentionally reduced before being persisted/displayed.
  if (/暂不支持|扫描版|没有提取|OCR|解析|格式|超时/i.test(error)) return error.slice(0, 500);
  return "文件已保存，但当前版本未能提取可读文本。";
}

function friendlyClassificationError() {
  return "模型分类失败，文件已保存；可以稍后点击“重试分类”。";
}

function makeInitialRecord(input: {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  parse: KnowledgeParseInput;
  now: string;
}) : StoredKnowledgeRecord {
  const originalName = normalizeOriginalName(input.originalName);
  const extension = extensionOf(originalName);
  const parsedText = input.parse.status === "parsed" ? safeText(input.parse.text) : "";
  const hasText = Boolean(parsedText);
  const isArchiveOnly = input.parse.status !== "parsed" || !hasText;
  const parseError = friendlyParseError(input.parse.error);
  return {
    id: input.id,
    originalName,
    mimeType: normalizeMimeType(input.mimeType),
    extension,
    sizeBytes: input.sizeBytes,
    sizeLabel: formatKnowledgeSize(input.sizeBytes),
    sha256Prefix: input.sha256.slice(0, 12),
    sha256: input.sha256,
    uploadedAt: input.now,
    updatedAt: input.now,
    classificationStatus: isArchiveOnly ? "archived" : "pending",
    classificationSource: "none",
    category: null,
    title: isArchiveOnly ? originalName : `待分类 · ${originalName}`,
    summary: isArchiveOnly
      ? "仅归档未理解：当前版本没有提取可读正文，因此没有声称模型已经理解该文件。"
      : "正文已提取，等待所选模型自动分类。",
    tags: isArchiveOnly ? [extension || "未知格式", "仅归档"] : [extension || "文本", "待分类"],
    confidence: null,
    classificationError: null,
    parseStatus: input.parse.status,
    parseError,
    // `characters` records how much text the parser saw; the stored body is
    // still bounded separately at KNOWLEDGE_MAX_TEXT_CHARS.
    characters: Math.max(0, Math.min(KNOWLEDGE_MAX_FILE_BYTES, input.parse.characters ?? parsedText.length)),
    classificationCharacters: Math.min(KNOWLEDGE_CLASSIFICATION_MAX_CHARS, parsedText.length),
    pages: input.parse.pages ? Math.max(1, Math.floor(input.parse.pages)) : null,
    truncated: Boolean(input.parse.truncated),
    hasText,
    source: "uploaded",
    version: "v1",
    owner: "本地知识库",
    downloadUrl: `/api/v1/knowledge/${input.id}/download`,
    textPreview: parsedText.slice(0, 1_200),
    storageFileName: `${input.id}.bin`,
    extractedText: hasText ? parsedText : null,
  };
}

async function writeJsonAtomic(target: string, value: unknown) {
  const temporary = path.join(KNOWLEDGE_METADATA_DIRECTORY, `.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, target);
}

async function readRecordByPath(target: string) {
  try {
    const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
    const result = storedKnowledgeRecordSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function readAllRecords() {
  await ensureDirectories();
  const names = await readdir(KNOWLEDGE_METADATA_DIRECTORY, { withFileTypes: true });
  const records = await Promise.all(names
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
    .map((entry) => readRecordByPath(path.join(KNOWLEDGE_METADATA_DIRECTORY, entry.name))));
  return records
    .filter((record): record is StoredKnowledgeRecord => Boolean(record))
    .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
}

export async function readFileWithLimit(file: File, maxBytes = KNOWLEDGE_MAX_FILE_BYTES) {
  if (file.size > maxBytes) throw new KnowledgeStoreError(413, "FILE_TOO_LARGE", `单个文件不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      total += chunk.byteLength;
      if (total > maxBytes) throw new KnowledgeStoreError(413, "FILE_TOO_LARGE", `单个文件不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function saveUploadedKnowledge(input: {
  originalName: string;
  mimeType: string;
  bytes: Buffer;
  parse: KnowledgeParseInput;
}) {
  if (input.bytes.byteLength > KNOWLEDGE_MAX_FILE_BYTES) {
    throw new KnowledgeStoreError(413, "FILE_TOO_LARGE", `单个文件不能超过 ${Math.round(KNOWLEDGE_MAX_FILE_BYTES / 1024 / 1024)} MB。`);
  }
  return withMutationLock(async () => {
    const records = await readAllRecords();
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    const duplicate = records.find((record) => record.sha256 === digest);
    if (duplicate) return { record: duplicate, deduplicated: true };
    const totalBytes = records.reduce((total, record) => total + record.sizeBytes, 0);
    if (records.length >= KNOWLEDGE_MAX_FILE_COUNT) throw new KnowledgeStoreError(413, "FILE_COUNT_LIMIT", "本地知识库文件数量已达到上限。请先清理旧文件。 ");
    if (totalBytes + input.bytes.byteLength > KNOWLEDGE_MAX_TOTAL_BYTES) throw new KnowledgeStoreError(413, "STORAGE_LIMIT", "本地知识库容量已达到上限。请先清理旧文件。 ");

    const id = randomUUID();
    const record = makeInitialRecord({
      id,
      originalName: input.originalName,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      sha256: digest,
      parse: input.parse,
      now: new Date().toISOString(),
    });
    await ensureDirectories();
    try {
      await writeFile(filePath(id), input.bytes, { flag: "wx" });
      await writeJsonAtomic(metadataPath(id), record);
    } catch (error) {
      await rm(filePath(id), { force: true }).catch(() => undefined);
      throw error;
    }
    return { record, deduplicated: false };
  });
}

export async function listKnowledgeRecords() {
  return readAllRecords();
}

export async function getKnowledgeRecord(id: string) {
  await ensureDirectories();
  return readRecordByPath(metadataPath(id));
}

export async function getKnowledgeTextById(id: string) {
  const record = await getKnowledgeRecord(id);
  if (!record?.extractedText) return null;
  return record.extractedText.slice(0, KNOWLEDGE_MAX_TEXT_CHARS);
}

export async function getKnowledgeDownload(id: string): Promise<KnowledgeDownload> {
  const record = await getKnowledgeRecord(id);
  if (!record) throw new KnowledgeStoreError(404, "KNOWLEDGE_NOT_FOUND", "知识文件不存在。");
  const target = filePath(record.id);
  try {
    const fileStats = await stat(target);
    return { stream: createReadStream(target), sizeBytes: fileStats.size, mimeType: record.mimeType, originalName: record.originalName };
  } catch {
    throw new KnowledgeStoreError(404, "KNOWLEDGE_FILE_MISSING", "知识原文件不存在，但元数据仍然保留。");
  }
}

export async function saveModelClassification(id: string, classification: KnowledgeClassification) {
  return withMutationLock(async () => {
    const record = await getKnowledgeRecord(id);
    if (!record) throw new KnowledgeStoreError(404, "KNOWLEDGE_NOT_FOUND", "知识文件不存在。");
    // A human confirmation wins even if a queued model request completes later.
    if (record.classificationSource === "manual" && record.classificationStatus === "classified") return record;
    const now = new Date().toISOString();
    const next: StoredKnowledgeRecord = {
      ...record,
      updatedAt: now,
      classificationStatus: "classified",
      classificationSource: "model",
      category: classification.category,
      title: classification.title,
      summary: classification.summary,
      tags: classification.tags,
      confidence: classification.confidence,
      classificationError: null,
    };
    await writeJsonAtomic(metadataPath(record.id), next);
    return next;
  });
}

export async function markClassificationFailed(id: string) {
  return withMutationLock(async () => {
    const record = await getKnowledgeRecord(id);
    if (!record) throw new KnowledgeStoreError(404, "KNOWLEDGE_NOT_FOUND", "知识文件不存在。");
    // A manual confirmation is authoritative. A later retry must never erase
    // a human decision because a model endpoint happened to be unavailable.
    if (record.classificationSource === "manual" && record.classificationStatus === "classified") return record;
    const now = new Date().toISOString();
    // Keep the last valid model classification visible when a later retry
    // fails. Initial uploads without a classification remain pending.
    const hasPreviousClassification = record.classificationStatus === "classified" && Boolean(record.category);
    const next: StoredKnowledgeRecord = hasPreviousClassification
      ? { ...record, updatedAt: now, classificationError: friendlyClassificationError() }
      : {
          ...record,
          updatedAt: now,
          classificationStatus: record.hasText ? "pending" : "archived",
          classificationSource: "none",
          category: record.hasText ? null : record.category,
          title: record.hasText ? `待分类 · ${record.originalName}` : record.title,
          summary: record.hasText ? "正文已保存，但模型分类没有完成；可以稍后重试。" : record.summary,
          tags: record.hasText ? [record.extension || "文本", "待分类"] : record.tags,
          confidence: null,
          classificationError: record.hasText ? friendlyClassificationError() : record.classificationError,
        };
    await writeJsonAtomic(metadataPath(record.id), next);
    return next;
  });
}

export async function updateKnowledgeRecord(id: string, patch: {
  category?: KnowledgeCategory;
  title?: string;
  summary?: string;
  tags?: string[];
  status?: "classified" | "archived";
}) {
  return withMutationLock(async () => {
    const record = await getKnowledgeRecord(id);
    if (!record) throw new KnowledgeStoreError(404, "KNOWLEDGE_NOT_FOUND", "知识文件不存在。");
    const category = patch.category ?? record.category;
    if (patch.status === "classified" && !category) throw new KnowledgeStoreError(422, "CATEGORY_REQUIRED", "发布分类前必须选择一个分类。");
    const now = new Date().toISOString();
    const next: StoredKnowledgeRecord = {
      ...record,
      updatedAt: now,
      classificationStatus: patch.status ?? (category ? "classified" : record.classificationStatus),
      classificationSource: category ? "manual" : record.classificationSource,
      category,
      title: patch.title ?? record.title,
      summary: patch.summary ?? record.summary,
      tags: patch.tags ?? record.tags,
      confidence: category ? null : record.confidence,
      classificationError: null,
    };
    await writeJsonAtomic(metadataPath(record.id), next);
    return next;
  });
}

export function toPublicKnowledgeEntry(record: StoredKnowledgeRecord): KnowledgeEntry {
  const publicRecord = { ...record } as Partial<StoredKnowledgeRecord>;
  delete publicRecord.storageFileName;
  delete publicRecord.extractedText;
  delete publicRecord.sha256;
  return publicRecord as KnowledgeEntry;
}

export function buildKnowledgeSummary(records: StoredKnowledgeRecord[]) {
  const byCategory = new Map<KnowledgeCategory, number>();
  for (const record of records) {
    if (record.category) byCategory.set(record.category, (byCategory.get(record.category) ?? 0) + 1);
  }
  return {
    total: records.length,
    classified: records.filter((record) => record.classificationStatus === "classified").length,
    pending: records.filter((record) => record.classificationStatus === "pending").length,
    archived: records.filter((record) => record.classificationStatus === "archived").length,
    byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })),
    storageBytes: records.reduce((total, record) => total + record.sizeBytes, 0),
    storageLimitBytes: KNOWLEDGE_MAX_TOTAL_BYTES,
    fileLimit: KNOWLEDGE_MAX_FILE_COUNT,
  };
}
