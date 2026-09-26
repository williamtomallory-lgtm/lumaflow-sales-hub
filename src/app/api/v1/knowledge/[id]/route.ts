import { knowledgePatchSchema } from "@/lib/knowledge/contracts";
import { deleteKnowledgeRecord, getKnowledgeRecord, KnowledgeStoreError, toPublicKnowledgeEntry, updateKnowledgeRecord } from "@/lib/knowledge/store";
import { refreshWiki } from "@/lib/knowledge/wiki";
import { apiJson, authorizeAssistantRequest, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { authorizeKnowledgeRead, knowledgeError } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type KnowledgeRouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: KnowledgeRouteContext) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request, 120);
    await authorizeKnowledgeRead(request);
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
    await authorizeKnowledgeRead(request);
    authorizeAssistantRequest(request);
    const { id } = await context.params;
    const patch = await readValidatedJson(request, knowledgePatchSchema);
    const updated = await updateKnowledgeRecord(id, patch);
    await refreshWiki(updated.id).catch(() => console.warn("Wiki refresh failed after manual knowledge update."));
    return apiJson({ data: toPublicKnowledgeEntry(updated), meta: { apiVersion: "v1" as const, requestId: requestIdentifier } }, 200, requestIdentifier);
  } catch (error) {
    return knowledgeError(error, requestIdentifier);
  }
}

export async function DELETE(request: Request, context: KnowledgeRouteContext) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request, 30);
    await authorizeKnowledgeRead(request);
    authorizeAssistantRequest(request);
    const { id } = await context.params;
    const deleted = await deleteKnowledgeRecord(id);
    let wikiStatus: "updated" | "failed" = "updated";
    try {
      // Passing the deleted source ID also removes its generated Wiki page.
      await refreshWiki(deleted.id);
    } catch {
      wikiStatus = "failed";
      console.warn("Wiki refresh failed after knowledge deletion.");
    }
    return apiJson({
      data: { id: deleted.id, originalName: deleted.originalName },
      meta: { apiVersion: "v1" as const, requestId: requestIdentifier, wikiStatus },
    }, 200, requestIdentifier);
  } catch (error) {
    return knowledgeError(error, requestIdentifier);
  }
}
