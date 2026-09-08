import { createAgentUIStreamResponse } from "ai";
import { assistantRequestSchema } from "@/lib/contracts/api";
import { salesAgent } from "@/lib/ai/sales-agent";
import { assertModelConfigured, getAssistantTimeoutMs, getModelHealth } from "@/lib/ai/model-config";
import { ApiHttpError, apiError, authorizeAssistantRequest, authorizeLocalKnowledgeRead, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { getDataSnapshot } from "@/lib/server/data-repository";
import { loadSalesProfile } from "@/lib/ai/skill-profile";
import { attachmentTextTransform } from "@/lib/ai/attachment-text";
import { loadAgentRole } from "@/lib/ai/agent-roles";
import { buildKnowledgeContext } from "@/lib/ai/knowledge-context";
import { getModelGenerationOptions } from "@/lib/ai/model-options";
import { InferencePolicyError, inputBudgetDetailsHeader, inputBudgetHeader, resolveInferencePolicy, withModelOutputBudget } from "@/lib/ai/inference-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 20);
    authorizeAssistantRequest(request);
    authorizeLocalKnowledgeRead(request);
    const body = await readValidatedJson(request, assistantRequestSchema);
    let policy;
    try {
      policy = resolveInferencePolicy({
        mode: body.mode,
        modelProfileId: body.modelProfileId,
        configuredTimeoutMs: process.env.LLM_TIMEOUT_MS?.trim() ? getAssistantTimeoutMs() : undefined,
      });
    } catch (error) {
      if (error instanceof InferencePolicyError) throw new ApiHttpError(error.status, error.code, error.message);
      throw error;
    }
    const modelConfig = assertModelConfigured(policy.resolvedModelProfileId);
    const generationOptions = getModelGenerationOptions(policy.resolvedMode, modelConfig.backend, modelConfig.maxOutputTokens);
    const resolvedPolicy = withModelOutputBudget(policy, modelConfig.maxOutputTokens);
    // The generic OpenAI-compatible backend does not advertise thinking. The
    // old Ollama path intentionally kept thinking off; current Ollama Qwen3
    // profiles use reasoning_effort to enable it without vLLM-only options.
    const thinkingEnabled: boolean | "unknown" = modelConfig.backend === "vllm"
      ? policy.thinkingEnabled
      : modelConfig.backend === "ollama" && policy.requestedProfile !== null
        ? policy.thinkingEnabled
        : modelConfig.backend === "openai-compatible" && policy.requestedProfile === "instant"
          ? "unknown"
          : false;
    const outputBudget = generationOptions.maxOutputTokens;
    const userText = body.messages[0].parts[0].text;
    if (userText.length > resolvedPolicy.inputBudget.maxUserCharacters) {
      throw new ApiHttpError(422, "CONTEXT_TOO_LONG", `当前推理档位单次用户文字最多 ${resolvedPolicy.inputBudget.maxUserCharacters} 字符；请缩短正文或拆分任务。`);
    }

    if (policy.resolvedProfile === "pro") {
      const health = await getModelHealth(policy.resolvedModelProfileId);
      if (!health.reachable) {
        throw new ApiHttpError(503, "MODEL_NOT_AVAILABLE", `Pro requires the installed local ${modelConfig.model} model; the exact model is not reachable.`);
      }
    }
    const baseProfile = await loadSalesProfile();
    const role = body.agentRoleId ? loadAgentRole(body.agentRoleId) : undefined;
    const profile = role ? {
      ...baseProfile,
      id: role.id,
      name: role.name,
      instructions: role.instructions,
      toolNames: baseProfile.toolNames.filter((name) => role.toolNames.includes(name)),
    } : baseProfile;
    // Local 8K models need space for role instructions, tool schemas and output.
    // Selected file正文 may be excerpted to the remaining bounded budget, but
    // user text itself has already been rejected above rather than truncated.
    const knowledge = await buildKnowledgeContext(body.knowledgeDocumentIds, Math.max(0, resolvedPolicy.inputBudget.maxContextCharacters - userText.length));
    const uiMessages = knowledge.text ? body.messages.map((message) => ({ ...message, parts: [{ type: "text" as const, text: message.parts[0].text + knowledge.text }] })) : body.messages;
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
      uiMessages,
      options: { mode: policy.resolvedMode, customer, profile, modelProfileId: modelConfig.profileId },
      abortSignal: request.signal,
      timeout: { totalMs: resolvedPolicy.timeoutMs },
      experimental_transform: attachmentTextTransform(),
      sendReasoning: false,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": id,
        "X-Model-Id": modelConfig.model,
        "X-Model-Profile": modelConfig.profileId,
        "X-Requested-Model-Profile": body.modelProfileId ?? "configured",
        "X-Inference-Mode": policy.resolvedMode,
        "X-Inference-Profile": policy.resolvedProfile,
        "X-Thinking-Enabled": String(thinkingEnabled),
        "X-Output-Budget": String(outputBudget),
        "X-Inference-Timeout-Ms": String(resolvedPolicy.timeoutMs),
        "X-Input-Budget": inputBudgetHeader(resolvedPolicy),
        "X-Input-Budget-Details": inputBudgetDetailsHeader(resolvedPolicy),
        "X-Output-Policy": "attachment-names-v1",
        "X-Agent-Profile": `${profile.id}@${profile.version}`,
        "X-Agent-Role": role?.id ?? "sales-consultant",
        "X-Knowledge-Coverage": encodeURIComponent(JSON.stringify(knowledge.coverage)),
        "X-Agent-Skills": profile.skills.map((skill) => `${skill.id}@${skill.version}`).join(","),
      },
    });
  } catch (error) {
    return apiError(error, id);
  }
}
