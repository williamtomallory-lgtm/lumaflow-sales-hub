import { parseDocumentBuffer } from "@/lib/document-parser";
import { assistantModelProfileIdSchema, type AssistantModelProfileId } from "@/lib/contracts/api";
import { parse as parsePath } from "node:path";
import {
  buildKnowledgeSummary,
  cloudKnowledgeArchiveAvailable,
  listKnowledgeRecords,
  readFileWithLimit,
  saveModelClassification,
  saveUploadedKnowledge,
  toPublicKnowledgeEntry,
  markClassificationFailed,
  KnowledgeStoreError,
} from "@/lib/knowledge/store";
import { classifyKnowledgeText } from "@/lib/knowledge/classification";
import { classifyKnowledgeWithTypeSafe } from "@/lib/knowledge/typesafe-classification";
import { refreshWiki } from "@/lib/knowledge/wiki";
import { KNOWLEDGE_CLOUD_MAX_FILE_BYTES, KNOWLEDGE_MAX_FILE_BYTES, knowledgeListQuerySchema } from "@/lib/knowledge/contracts";
import { ApiHttpError, apiJson, authorizeAssistantRequest, enforceRateLimit, requestId } from "@/lib/server/api-security";
import { authorizeKnowledgeRead, knowledgeError } from "./_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const parseableExtensions = new Set([
  "txt", "csv", "tsv", "md", "markdown", "json", "jsonl", "log", "xml", "html", "htm",
  "pdf", "docx", "xlsx", "pptx",
]);
const uploadLimit = () => process.env.VERCEL === "1" ? KNOWLEDGE_CLOUD_MAX_FILE_BYTES : KNOWLEDGE_MAX_FILE_BYTES;

/**
 * Limit the multipart stream before calling Request.formData(). Content-Length
 * is only an early rejection hint: the reader remains the authoritative cap.
 */
function boundedMultipartRequest(request: Request) {
  const maxRequestBytes = uploadLimit() + 256 * 1024;
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxRequestBytes) {
    throw new KnowledgeStoreError(413, "PAYLOAD_TOO_LARGE", `上传请求超过单文件 ${Math.round(uploadLimit() / 1024 / 1024)} MB 限制。`);
  }
  if (!request.body) return request;
  const reader = request.body.getReader();
  let total = 0;
  const bounded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
        return;
      }
      total += result.value.byteLength;
      if (total > maxRequestBytes) {
        await reader.cancel();
        controller.error(new KnowledgeStoreError(413, "PAYLOAD_TOO_LARGE", `上传请求超过单文件 ${Math.round(uploadLimit() / 1024 / 1024)} MB 限制。`));
        return;
      }
      controller.enqueue(result.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bounded,
    // Node's Request requires duplex for a streaming request body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function mayParse(name: string, mimeType: string) {
  const extension = parsePath(name).ext.replace(/^\./, "").toLowerCase();
  return parseableExtensions.has(extension) || mimeType.toLowerCase().startsWith("text/") || mimeType === "application/json";
}

function asArrayBuffer(bytes: Buffer) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function classifyIfPossible(id: string, originalName: string, text: string, modelProfileId?: AssistantModelProfileId) {
  try {
    let classification = null;
    try { classification = await classifyKnowledgeWithTypeSafe({ text, originalName }); }
    catch { console.warn("TypeSafe category judgment unavailable; trying the configured model."); }
    // Cloud uploads must complete even when the selected inference endpoint is unreachable.
    // Keep the original and let the user retry classification after the short attempt.
    classification ??= await classifyKnowledgeText({
      text,
      originalName,
      modelProfileId,
      abortSignal: process.env.VERCEL === "1" ? AbortSignal.timeout(12_000) : undefined,
    });
    return { record: await saveModelClassification(id, classification), classified: true };
  } catch {
    console.warn("Knowledge classification failed; original file retained.");
    return { record: await markClassificationFailed(id), classified: false };
  }
}

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 120);
    await authorizeKnowledgeRead(request);
    const query = knowledgeListQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    if (process.env.VERCEL === "1" && !cloudKnowledgeArchiveAvailable()) {
      return apiJson({
        data: [],
        summary: buildKnowledgeSummary([]),
        meta: { apiVersion: "v1" as const, requestId: id, source: "local-files" as const, demoEntriesExcluded: true as const, archiveAvailable: false, uploadLimitBytes: uploadLimit(), limit: query.limit, offset: query.offset },
      }, 200, id);
    }
    const allRecords = await listKnowledgeRecords();
    const normalized = query.q.toLowerCase();
    const filtered = allRecords.filter((record) => {
      const categoryMatches = !query.category || record.category === query.category;
      const statusMatches = !query.status || record.classificationStatus === query.status;
      const queryMatches = !normalized || `${record.originalName} ${record.title} ${record.summary} ${record.tags.join(" ")} ${record.textPreview}`.toLowerCase().includes(normalized);
      return categoryMatches && statusMatches && queryMatches;
    });
    const data = filtered.slice(query.offset, query.offset + query.limit).map(toPublicKnowledgeEntry);
    return apiJson({
      data,
      summary: buildKnowledgeSummary(allRecords),
      meta: { apiVersion: "v1" as const, requestId: id, source: "local-files" as const, demoEntriesExcluded: true as const, archiveAvailable: true, uploadLimitBytes: uploadLimit(), limit: query.limit, offset: query.offset },
    }, 200, id);
  } catch (error) {
    return knowledgeError(error, id);
  }
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 10);
    await authorizeKnowledgeRead(request);
    authorizeAssistantRequest(request);
    if (process.env.VERCEL === "1" && !cloudKnowledgeArchiveAvailable()) throw new ApiHttpError(503, "CLOUD_ARCHIVE_UNAVAILABLE", "云端尚未配置私有持久文件存储。请先连接知识库存储。");
    const formData = await boundedMultipartRequest(request).formData();
    const file = formData.get("file");
    if (!(file instanceof File)) throw new ApiHttpError(400, "FILE_REQUIRED", "请选择一个文件。");
    const modelProfileValue = formData.get("modelProfileId");
    const modelProfileId = modelProfileValue === null
      ? undefined
      : typeof modelProfileValue === "string"
        ? assistantModelProfileIdSchema.parse(modelProfileValue)
        : (() => { throw new ApiHttpError(422, "INVALID_MODEL_PROFILE", "modelProfileId 必须是模型配置 ID。"); })();
    const bytes = await readFileWithLimit(file, uploadLimit());
    let parseResult: Parameters<typeof saveUploadedKnowledge>[0]["parse"];
    if (!mayParse(file.name, file.type)) {
      parseResult = { status: "archive_only", error: "当前文件类型仅归档未理解；未接入该类型的文本/OCR解析。" };
    } else {
      try {
        const parsed = await parseDocumentBuffer(file.name, file.type, asArrayBuffer(bytes));
        parseResult = { status: "parsed", text: parsed.text, characters: parsed.characters, pages: parsed.pages, truncated: parsed.truncated };
      } catch (error) {
        const message = error instanceof Error ? error.message : "文件解析失败";
        parseResult = { status: /暂不支持/i.test(message) ? "archive_only" : "parse_failed", error: message };
      }
    }
    const saved = await saveUploadedKnowledge({ originalName: file.name, mimeType: file.type, bytes, parse: parseResult });
    let result = saved.record;
    let classified = false;
    let classificationAttempted = false;
    if (result.hasText && result.classificationStatus === "pending" && result.extractedText) {
      classificationAttempted = true;
      const classification = await classifyIfPossible(result.id, result.originalName, result.extractedText, modelProfileId);
      result = classification.record;
      classified = classification.classified;
    }
    let wikiStatus: "updated" | "failed" = "updated";
    try {
      await refreshWiki(result.id);
    } catch {
      wikiStatus = "failed";
      console.warn("Wiki refresh failed; source file remains available.");
    }
    return apiJson({
      data: toPublicKnowledgeEntry(result),
      meta: { apiVersion: "v1" as const, requestId: id, deduplicated: saved.deduplicated, classificationAttempted, classified, wikiStatus },
    }, saved.deduplicated ? 200 : 201, id, { Location: `/api/v1/knowledge/${result.id}` });
  } catch (error) {
    return knowledgeError(error, id);
  }
}
