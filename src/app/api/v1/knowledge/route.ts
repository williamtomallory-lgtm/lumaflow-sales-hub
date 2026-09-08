import { parseDocumentBuffer } from "@/lib/document-parser";
import { assistantModelProfileIdSchema } from "@/lib/contracts/api";
import { parse as parsePath } from "node:path";
import {
  buildKnowledgeSummary,
  listKnowledgeRecords,
  readFileWithLimit,
  saveModelClassification,
  saveUploadedKnowledge,
  toPublicKnowledgeEntry,
  markClassificationFailed,
  KnowledgeStoreError,
} from "@/lib/knowledge/store";
import { classifyKnowledgeText } from "@/lib/knowledge/classification";
import { KNOWLEDGE_MAX_FILE_BYTES, knowledgeListQuerySchema } from "@/lib/knowledge/contracts";
import { ApiHttpError, apiJson, authorizeAssistantRequest, enforceRateLimit, requestId } from "@/lib/server/api-security";
import { authorizeKnowledgeRead, knowledgeError } from "./_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const parseableExtensions = new Set([
  "txt", "csv", "tsv", "md", "markdown", "json", "jsonl", "log", "xml", "html", "htm",
  "pdf", "docx", "xlsx", "pptx",
]);
const MAX_MULTIPART_REQUEST_BYTES = KNOWLEDGE_MAX_FILE_BYTES + 1024 * 1024;

/**
 * Limit the multipart stream before calling Request.formData(). Content-Length
 * is only an early rejection hint: the reader remains the authoritative cap.
 */
function boundedMultipartRequest(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_MULTIPART_REQUEST_BYTES) {
    throw new KnowledgeStoreError(413, "PAYLOAD_TOO_LARGE", "上传请求超过单文件 25 MB 限制。");
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
      if (total > MAX_MULTIPART_REQUEST_BYTES) {
        await reader.cancel();
        controller.error(new KnowledgeStoreError(413, "PAYLOAD_TOO_LARGE", "上传请求超过单文件 25 MB 限制。"));
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

async function classifyIfPossible(id: string, originalName: string, text: string, modelProfileId?: "local-qwen3-8b" | "local-qwen3-14b" | "configured") {
  try {
    const classification = await classifyKnowledgeText({ text, originalName, modelProfileId });
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
    authorizeKnowledgeRead(request);
    const query = knowledgeListQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
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
      meta: { apiVersion: "v1" as const, requestId: id, source: "local-files" as const, demoEntriesExcluded: true as const, limit: query.limit, offset: query.offset },
    }, 200, id);
  } catch (error) {
    return knowledgeError(error, id);
  }
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 10);
    authorizeKnowledgeRead(request);
    authorizeAssistantRequest(request);
    const formData = await boundedMultipartRequest(request).formData();
    const file = formData.get("file");
    if (!(file instanceof File)) throw new ApiHttpError(400, "FILE_REQUIRED", "请选择一个文件。");
    const modelProfileValue = formData.get("modelProfileId");
    const modelProfileId = modelProfileValue === null
      ? undefined
      : typeof modelProfileValue === "string"
        ? assistantModelProfileIdSchema.parse(modelProfileValue)
        : (() => { throw new ApiHttpError(422, "INVALID_MODEL_PROFILE", "modelProfileId 必须是模型配置 ID。"); })();
    const bytes = await readFileWithLimit(file);
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
    return apiJson({
      data: toPublicKnowledgeEntry(result),
      meta: { apiVersion: "v1" as const, requestId: id, deduplicated: saved.deduplicated, classificationAttempted, classified },
    }, saved.deduplicated ? 200 : 201, id, { Location: `/api/v1/knowledge/${result.id}` });
  } catch (error) {
    return knowledgeError(error, id);
  }
}
