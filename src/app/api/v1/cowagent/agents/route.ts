import { apiError, apiJson, authorizeAssistantRequest, authorizeLocalKnowledgeRead, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { cowAgentCreateSchema } from "@/lib/contracts/cowagent-agent";
import { createCowAgentProfile, getCowAgentRoster } from "@/lib/server/cowagent-client";

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
    return apiJson({ data: await createCowAgentProfile(body) }, 201, id);
  } catch (error) { return apiError(error, id); }
}
