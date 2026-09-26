import { ApiHttpError, apiError, apiJson, authorizeAssistantRequest, authorizeLocalKnowledgeRead, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { cowAgentCreateSchema, cowAgentDeleteSchema } from "@/lib/contracts/cowagent-agent";
import { createCowAgentProfile, updateCowAgentProfile, deleteCowAgentProfile, getCowAgentRoster } from "@/lib/server/cowagent-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    authorizeLocalKnowledgeRead(request);
    enforceRateLimit(request, 60);
    return apiJson({ data: await getCowAgentRoster() }, 200, id);
  } catch (error) { return apiError(error, id); }
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    authorizeLocalKnowledgeRead(request);
    authorizeAssistantRequest(request);
    enforceRateLimit(request, 20);
    const body = await readValidatedJson(request, cowAgentCreateSchema);
    if (body.type === "wechat") throw new ApiHttpError(409, "WECHAT_SINGLETON", "系统只有一个微信 Agent，请在微信 Agent 页面配置或创建新对话。");
    return apiJson({ data: await createCowAgentProfile(body) }, 201, id);
  } catch (error) { return apiError(error, id); }
}

export async function DELETE(request: Request) {
  const id = requestId(request);
  try {
    authorizeLocalKnowledgeRead(request);
    authorizeAssistantRequest(request);
    enforceRateLimit(request, 20);
    const body = await readValidatedJson(request, cowAgentDeleteSchema);
    if ((await getCowAgentRoster()).agents.find((agent) => agent.id === body.id)?.type === "wechat") throw new ApiHttpError(409, "WECHAT_SINGLETON", "微信 Agent 保留为唯一执行者；请使用解绑微信。");
    return apiJson({ data: await deleteCowAgentProfile(body) }, 200, id);
  } catch (error) { return apiError(error, id); }
}

export async function PATCH(request: Request) {
  const id = requestId(request);
  try {
    authorizeLocalKnowledgeRead(request);
    authorizeAssistantRequest(request);
    enforceRateLimit(request, 20);
    const body = await readValidatedJson(request, cowAgentCreateSchema);
    if (body.type === "wechat") throw new ApiHttpError(409, "WECHAT_SINGLETON_CONFIG", "请在微信 Agent 的配置页面修改，任务通过独立 Conversation 管理。");
    return apiJson({ data: await updateCowAgentProfile(body) }, 200, id);
  } catch (error) { return apiError(error, id); }
}
