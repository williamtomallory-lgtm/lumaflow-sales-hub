import { completeAnswerResponse } from "@/lib/ai/complete-answer-stream";
import { authorizeWechatModel } from "@/lib/server/wechat-desktop";
import { assistantRequestSchema } from "@/lib/contracts/api";
import { assertModelConfigured, configuredSupportedModes, getAssistantTimeoutMs, getModelHealth } from "@/lib/ai/model-config";
import { ApiHttpError, apiError, authorizeAssistantRequest, authorizeLocalKnowledgeRead, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { getDataSnapshot } from "@/lib/server/data-repository";
import { loadSalesProfile } from "@/lib/ai/skill-profile";
import { attachmentTextTransform } from "@/lib/ai/attachment-text";
import { loadAgentRole, loadCowAgentRole } from "@/lib/ai/agent-roles";
import { getCowAgentProfile } from "@/lib/server/cowagent-client";
import { buildKnowledgeContext } from "@/lib/ai/knowledge-context";
import { getModelGenerationOptions } from "@/lib/ai/model-options";
import { requestsCodeArtifact } from "@/lib/ai/code-artifact";
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
    // Public Vercel pages have no per-user account authentication. A same-origin
    // browser request is not sufficient authority to run arbitrary PC commands.
    if (body.experience === "work") {
      const requestHost = new URL(request.url).hostname;
      let backendHost = "";
      try { backendHost = new URL(process.env.COWAGENT_BASE_URL?.trim() || "http://127.0.0.1:9876").hostname; } catch { /* fail closed */ }
      if (!["localhost", "127.0.0.1", "[::1]"].includes(requestHost) || !["localhost", "127.0.0.1", "[::1]"].includes(backendHost)) {
        throw new ApiHttpError(403, "LOCAL_WORK_ONLY", "电脑执行仅在已授权的本机网站与本机 CowAgent 后端开放；公共 Vercel 网站不能执行电脑命令。");
      }
    }
    let policy;
    try {
      policy = resolveInferencePolicy({
        mode: body.mode,
        modelProfileId: body.modelProfileId,
        configuredTimeoutMs: process.env.LLM_TIMEOUT_MS?.trim() ? getAssistantTimeoutMs() : undefined,
        configuredSupportedModes: configuredSupportedModes(),
      });
    } catch (error) {
      if (error instanceof InferencePolicyError) throw new ApiHttpError(error.status, error.code, error.message);
      throw error;
    }
    if (body.wechatSnapshotId) authorizeWechatModel(body.wechatSnapshotId, policy.resolvedModelProfileId);
    const modelConfig = assertModelConfigured(policy.resolvedModelProfileId);
    if (body.experience === "work") {
      let modelHost = "";
      try { modelHost = new URL(modelConfig.baseURL).hostname; } catch { /* fail closed */ }
      if (!["localhost", "127.0.0.1", "[::1]"].includes(modelHost)) {
        throw new ApiHttpError(403, "LOCAL_MODEL_REQUIRED", "Work 的电脑操作只允许本机模型；远程模型不能接收本机命令与文件回执。");
      }
    }
    const userText = body.messages[0].parts[0].text;
    const codeArtifact = requestsCodeArtifact(userText);
    const generationOptions = getModelGenerationOptions(policy.resolvedMode, modelConfig.backend, modelConfig.maxOutputTokens, codeArtifact);
    const basePolicy = withModelOutputBudget(policy, modelConfig.maxOutputTokens);
    const resolvedPolicy = modelConfig.backend === "openai-compatible" || modelConfig.backend === "vercel-ai-gateway" ? {
      ...basePolicy,
      maxOutputTokens: generationOptions.maxOutputTokens,
      timeoutMs: 290_000,
      inputBudget: { maxContextCharacters: 4_000, maxUserCharacters: 4_000, maxFileCharacters: 4_000 },
    } : basePolicy;
    // The generic OpenAI-compatible backend does not advertise thinking. The
    // old Ollama path intentionally kept thinking off; current Ollama Qwen3
    // profiles use reasoning_effort to enable it without vLLM-only options.
    const thinkingEnabled: boolean | "unknown" = modelConfig.backend === "vllm"
      ? policy.thinkingEnabled
      : modelConfig.backend === "ollama" && policy.requestedProfile !== null
        ? policy.thinkingEnabled
        : modelConfig.backend === "openai-compatible" || modelConfig.backend === "vercel-ai-gateway"
          ? "unknown"
          : false;
    const outputBudget = generationOptions.maxOutputTokens;
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
    const backendAgent = body.agentId ? await getCowAgentProfile(body.agentId) : undefined;
    if (body.experience === "work" && !backendAgent) throw new ApiHttpError(422, "WORK_AGENT_REQUIRED", "请先在 Work 中选择可用 Agent。");
    const role = backendAgent ? loadCowAgentRole(backendAgent) : body.agentRoleId ? loadAgentRole(body.agentRoleId) : undefined;
    const profile = role ? {
      ...baseProfile,
      id: role.id,
      name: role.name,
      instructions: role.instructions + (body.wechatSnapshotId ? "\n本轮含用户确认的本机微信桌面只读快照。只能分析提交的条目，不代表全部历史；身份和附件正文未经解析，切勿声称自己登录、发送或读取了数据库。" : ""),
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
    return await completeAnswerResponse({
      uiMessages,
      options: { mode: policy.resolvedMode, customer, profile, modelProfileId: modelConfig.profileId,
        codeArtifact, continuation: false, ...(body.experience === "work" && backendAgent ? { workAgentId: backendAgent.id } : {}) },
      abortSignal: request.signal,
      timeoutMs: resolvedPolicy.timeoutMs,
      transform: codeArtifact ? undefined : attachmentTextTransform(),
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
        "X-Wechat-Source": body.wechatSnapshotId ? "desktop-readonly" : "none",
        "X-Knowledge-Coverage": encodeURIComponent(JSON.stringify(knowledge.coverage)),
        "X-Agent-Skills": profile.skills.map((skill) => `${skill.id}@${skill.version}`).join(","),
      },
    });
  } catch (error) {
    return apiError(error, id);
  }
}
