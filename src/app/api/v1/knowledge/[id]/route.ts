import { knowledgePatchSchema } from "@/lib/knowledge/contracts";
import { getKnowledgeRecord, KnowledgeStoreError, toPublicKnowledgeEntry, updateKnowledgeRecord } from "@/lib/knowledge/store";
import { apiJson, authorizeAssistantRequest, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { authorizeKnowledgeRead, knowledgeError } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type KnowledgeRouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: KnowledgeRouteContext) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request, 120);
    authorizeKnowledgeRead(request);
    const { id } = await context.params;
    const record = await getKnowledgeRecord(id);
    if (!record) return knowledgeError(new KnowledgeStoreError(404, "KNOWLEDGE_NOT_FOUND", "知识文件不存在。"), requestIdentifier);
    return apiJson({ data: toPublicKnowledgeEntry(record), meta: { apiVersion: "v1" as const, requestId: requestIdentifier } }, 200, requestIdentifier);
  } catch (error) {
    return knowledgeError(error, requestIdentifier);
  }
}

export async function PATCH(request: Request, context: KnowledgeRouteContext) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request, 30);
    authorizeKnowledgeRead(request);
    authorizeAssistantRequest(request);
    const { id } = await context.params;
    const patch = await readValidatedJson(request, knowledgePatchSchema);
    const updated = await updateKnowledgeRecord(id, patch);
    return apiJson({ data: toPublicKnowledgeEntry(updated), meta: { apiVersion: "v1" as const, requestId: requestIdentifier } }, 200, requestIdentifier);
  } catch (error) {
    return knowledgeError(error, requestIdentifier);
  }
}
