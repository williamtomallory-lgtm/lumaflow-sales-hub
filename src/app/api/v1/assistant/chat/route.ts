import { createAgentUIStreamResponse } from "ai";
import { assistantRequestSchema } from "@/lib/contracts/api";
import { salesAgent } from "@/lib/ai/sales-agent";
import { assertModelConfigured, getAssistantTimeoutMs } from "@/lib/ai/model-config";
import { ApiHttpError, apiError, authorizeAssistantRequest, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { getDataSnapshot } from "@/lib/server/data-repository";
import { loadSalesProfile } from "@/lib/ai/skill-profile";
import { attachmentTextTransform } from "@/lib/ai/attachment-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 20);
    authorizeAssistantRequest(request);
    const body = await readValidatedJson(request, assistantRequestSchema);
    const modelConfig = assertModelConfigured(body.modelProfileId);
    const profile = await loadSalesProfile();
    const snapshot = body.customerId ? await getDataSnapshot() : null;
    const customerRecord = body.customerId ? snapshot?.customers.find((customer) => customer.id === body.customerId) : undefined;
    if (body.customerId && !customerRecord) throw new ApiHttpError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    const customer = customerRecord ? {
      id: customerRecord.id,
      company: customerRecord.company,
      name: customerRecord.name,
      industry: customerRecord.industry,
      stage: customerRecord.stage,
    } : undefined;
    return await createAgentUIStreamResponse({
      agent: salesAgent,
      uiMessages: body.messages,
      options: { mode: body.mode, customer, profile, modelProfileId: modelConfig.profileId },
      abortSignal: request.signal,
      timeout: { totalMs: getAssistantTimeoutMs() },
      experimental_transform: attachmentTextTransform(),
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": id,
        "X-Model-Id": modelConfig.model,
        "X-Model-Profile": modelConfig.profileId,
        "X-Output-Policy": "attachment-names-v1",
        "X-Agent-Profile": `${profile.id}@${profile.version}`,
        "X-Agent-Skills": profile.skills.map((skill) => `${skill.id}@${skill.version}`).join(","),
      },
    });
  } catch (error) {
    return apiError(error, id);
  }
}
