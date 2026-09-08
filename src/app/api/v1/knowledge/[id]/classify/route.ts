import { assistantModelProfileIdSchema } from "@/lib/contracts/api";
import { classifyKnowledgeText } from "@/lib/knowledge/classification";
import { knowledgeClassificationRequestSchema } from "@/lib/knowledge/contracts";
import { getKnowledgeRecord, markClassificationFailed, saveModelClassification, toPublicKnowledgeEntry } from "@/lib/knowledge/store";
import { ApiHttpError, apiJson, authorizeAssistantRequest, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { authorizeKnowledgeRead, knowledgeError } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ClassifyRouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: ClassifyRouteContext) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request, 20);
    authorizeKnowledgeRead(request);
    authorizeAssistantRequest(request);
    const { id } = await context.params;
    const input = await readValidatedJson(request, knowledgeClassificationRequestSchema);
    const record = await getKnowledgeRecord(id);
    if (!record) throw new ApiHttpError(404, "KNOWLEDGE_NOT_FOUND", "知识文件不存在。");
    if (record.classificationSource === "manual" && record.classificationStatus === "classified") {
      return apiJson({ data: toPublicKnowledgeEntry(record), meta: { apiVersion: "v1" as const, requestId: requestIdentifier, classified: false, reason: "MANUAL_CLASSIFICATION" as const } }, 200, requestIdentifier);
    }
    if (!record.extractedText) {
      return apiJson({ data: toPublicKnowledgeEntry(record), meta: { apiVersion: "v1" as const, requestId: requestIdentifier, classified: false, reason: "NO_EXTRACTED_TEXT" as const } }, 200, requestIdentifier);
    }
    try {
      const modelProfileId = input.modelProfileId === undefined ? undefined : assistantModelProfileIdSchema.parse(input.modelProfileId);
      const classification = await classifyKnowledgeText({ text: record.extractedText, originalName: record.originalName, modelProfileId });
      const updated = await saveModelClassification(record.id, classification);
      return apiJson({ data: toPublicKnowledgeEntry(updated), meta: { apiVersion: "v1" as const, requestId: requestIdentifier, classified: true } }, 200, requestIdentifier);
    } catch {
      console.warn("Knowledge classification retry failed; original file retained.");
      const pending = await markClassificationFailed(record.id);
      return apiJson({ data: toPublicKnowledgeEntry(pending), meta: { apiVersion: "v1" as const, requestId: requestIdentifier, classified: false, reason: "MODEL_FAILED" as const } }, 200, requestIdentifier);
    }
  } catch (error) {
    return knowledgeError(error, requestIdentifier);
  }
}
