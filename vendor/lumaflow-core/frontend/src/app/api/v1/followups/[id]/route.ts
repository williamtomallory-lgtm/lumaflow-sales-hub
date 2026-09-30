import { resourceIdSchema, updateFollowupSchema } from "@/lib/contracts/api";
import { ApiHttpError, apiError, apiJson, authorizeWrite, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { updateFollowupStatus } from "@/lib/server/data-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request, 60);
    authorizeWrite(request);
    const id = resourceIdSchema.parse((await context.params).id);
    const input = await readValidatedJson(request, updateFollowupSchema);
    const task = await updateFollowupStatus(id, input.status, requestIdentifier);
    if (!task) throw new ApiHttpError(404, "FOLLOWUP_NOT_FOUND", "Follow-up task not found.");
    return apiJson({ data: task, meta: { apiVersion: "v1", requestId: requestIdentifier } }, 200, requestIdentifier);
  } catch (error) {
    return apiError(error, requestIdentifier);
  }
}
