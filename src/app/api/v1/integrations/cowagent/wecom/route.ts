import { apiError, apiJson, authorizeAssistantRequest, authorizeLocalKnowledgeRead, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { cowAgentWecomActionSchema, cowAgentWecomIdentitySchema } from "@/lib/contracts/cowagent-wecom";
import { connectCowAgentWecom, createCowAgentWecomTask, disconnectCowAgentWecom, getCowAgentWecomState, toggleCowAgentWecomTask, updateCowAgentWecomPolicy } from "@/lib/server/cowagent-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    authorizeLocalKnowledgeRead(request);
    enforceRateLimit(request, 60);
    const url = new URL(request.url);
    const identity = cowAgentWecomIdentitySchema.parse({ agentId: url.searchParams.get("agentId"), instanceId: url.searchParams.get("instanceId") });
    return apiJson({ data: await getCowAgentWecomState(identity.agentId, identity.instanceId) }, 200, id);
  } catch (error) { return apiError(error, id); }
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    authorizeLocalKnowledgeRead(request);
    authorizeAssistantRequest(request);
    enforceRateLimit(request, 20);
    const body = await readValidatedJson(request, cowAgentWecomActionSchema);
    const data = body.action === "connect" ? await connectCowAgentWecom(body)
      : body.action === "disconnect" ? await disconnectCowAgentWecom(body.agentId, body.instanceId)
        : body.action === "update-policy" ? await updateCowAgentWecomPolicy(body)
          : body.action === "create-task" ? await createCowAgentWecomTask(body)
            : await toggleCowAgentWecomTask(body.agentId, body.instanceId, body.taskId, body.enabled);
    return apiJson({ data }, 200, id);
  } catch (error) { return apiError(error, id); }
}
