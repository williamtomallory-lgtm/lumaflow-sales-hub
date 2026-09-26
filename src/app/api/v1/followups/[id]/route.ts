import { resourceIdSchema, updateFollowupSchema } from "@/lib/contracts/api";
import { ApiHttpError, apiError, apiJson, authorizeWrite, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { deleteFollowup, getDataSnapshot, updateFollowupStatus } from "@/lib/server/data-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request, 120);
    const id = resourceIdSchema.parse((await context.params).id);
    const task = (await getDataSnapshot()).followupTasks.find((item) => item.id === id);
    if (!task) throw new ApiHttpError(404, "FOLLOWUP_NOT_FOUND", "跟进任务不存在。");
    return apiJson({ data: task, meta: { apiVersion: "v1", requestId: requestIdentifier } }, 200, requestIdentifier);
  } catch (error) { return apiError(error, requestIdentifier); }
}

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

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request, 30);
    if (process.env.VERCEL === "1") throw new ApiHttpError(403, "FOLLOWUP_DELETE_LOCAL_ONLY", "当前部署的客户任务暂不支持直接删除；共享事件可由创建人在日历详情删除。");
    authorizeWrite(request);
    const id = resourceIdSchema.parse((await context.params).id);
    const task = await deleteFollowup(id, requestIdentifier);
    if (!task) throw new ApiHttpError(404, "FOLLOWUP_NOT_FOUND", "跟进任务不存在或已删除。");
    return apiJson({ data: { id }, meta: { apiVersion: "v1", requestId: requestIdentifier } }, 200, requestIdentifier);
  } catch (error) { return apiError(error, requestIdentifier); }
}
