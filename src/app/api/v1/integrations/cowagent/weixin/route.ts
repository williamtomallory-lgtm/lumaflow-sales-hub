import { apiError, apiJson, authorizeAssistantRequest, authorizeLocalKnowledgeRead, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { cowAgentWeixinActionSchema, cowAgentWeixinIdentitySchema } from "@/lib/contracts/cowagent-weixin";
import { createCowAgentWeixinQr, disconnectCowAgentWeixin, getCowAgentWeixinState, pollCowAgentWeixinQr } from "@/lib/server/cowagent-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    authorizeLocalKnowledgeRead(request);
    enforceRateLimit(request, 60);
    const url = new URL(request.url);
    const identity = cowAgentWeixinIdentitySchema.parse({ agentId: url.searchParams.get("agentId"), instanceId: url.searchParams.get("instanceId") });
    return apiJson({ data: await getCowAgentWeixinState(identity.agentId, identity.instanceId) }, 200, id);
  } catch (error) {
    return apiError(error, id);
  }
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    authorizeLocalKnowledgeRead(request);
    authorizeAssistantRequest(request);
    enforceRateLimit(request, 60);
    const body = await readValidatedJson(request, cowAgentWeixinActionSchema);
    const data = body.action === "create-qr"
      ? await createCowAgentWeixinQr(body.agentId, body.instanceId)
      : body.action === "poll"
        ? await pollCowAgentWeixinQr(body.agentId, body.instanceId)
        : await disconnectCowAgentWeixin(body.agentId, body.instanceId);
    return apiJson({ data }, 200, id);
  } catch (error) {
    return apiError(error, id);
  }
}
