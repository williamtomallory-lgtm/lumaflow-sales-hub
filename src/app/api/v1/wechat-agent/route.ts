import { ApiHttpError, apiError, apiJson, authorizeAssistantRequest, authorizeLocalKnowledgeRead, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { requestWechatAgent } from "@/lib/server/cowagent-client";
import { wechatAgentActionSchema, wechatAgentConfigPatchSchema, wechatAgentQuerySchema } from "@/lib/contracts/wechat-conversation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorize(request: Request, mutation = false) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) throw new ApiHttpError(403, "LOCAL_WECHAT_ONLY", "微信会话仅在本机工作区开放。");
  authorizeLocalKnowledgeRead(request);
  if (mutation) authorizeAssistantRequest(request);
  enforceRateLimit(request, mutation ? 60 : 240);
}
export async function GET(request: Request) {
  const id = requestId(request);
  try {
    authorize(request);
    const url = new URL(request.url);
    const query = wechatAgentQuerySchema.parse({ action: url.searchParams.get("action") || "state", ...Object.fromEntries([...url.searchParams].filter(([key]) => key !== "action")) });
    return apiJson({ data: await requestWechatAgent({ query }) }, 200, id);
  } catch (error) { return apiError(error, id); }
}
export async function POST(request: Request) {
  const id = requestId(request);
  try {
    authorize(request, true);
    const body = await readValidatedJson(request, wechatAgentActionSchema);
    return apiJson({ data: await requestWechatAgent({ method: "POST", body }) }, 200, id);
  } catch (error) { return apiError(error, id); }
}
export async function PATCH(request: Request) {
  const id = requestId(request);
  try {
    authorize(request, true);
    const body = await readValidatedJson(request, wechatAgentConfigPatchSchema);
    return apiJson({ data: await requestWechatAgent({ method: "PATCH", body }) }, 200, id);
  } catch (error) { return apiError(error, id); }
}
