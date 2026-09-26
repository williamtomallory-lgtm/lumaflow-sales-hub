import { completeAnswerResponse } from "@/lib/ai/complete-answer-stream";
import { authorizeWechatModel } from "@/lib/server/wechat-desktop";
import { assistantRequestSchema } from "@/lib/contracts/api";
import { assertModelConfigured, configuredSupportedModes, getAssistantTimeoutMs, getModelConfig, getModelHealth } from "@/lib/ai/model-config";
import { chooseAutoInferenceMode } from "@/lib/ai/auto-inference";
import { ApiHttpError, apiError, authorizeAssistantRequest, authorizeKnowledgeSession, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { getDataSnapshot } from "@/lib/server/data-repository";
import { loadSalesProfile } from "@/lib/ai/skill-profile";
import { attachmentTextTransform } from "@/lib/ai/attachment-text";
import { loadAgentRole, loadCowAgentRole } from "@/lib/ai/agent-roles";
import { getCowAgentProfile, getCowAgentRoster } from "@/lib/server/cowagent-client";
import { buildKnowledgeContext } from "@/lib/ai/knowledge-context";
import { buildProjectContext } from "@/lib/server/projects";
import { getModelGenerationOptions } from "@/lib/ai/model-options";
import { runLocalAgentTeam } from "@/lib/ai/agent-team";
import { inferCollaborationMode } from "@/lib/contracts/agent-progress";
import { requestsCodeArtifact } from "@/lib/ai/code-artifact";
import { isCurrentWeatherLookup, isSimpleBrowserLookup } from "@/lib/ai/browser-intent";
import { InferencePolicyError, inputBudgetDetailsHeader, inputBudgetHeader, resolveInferencePolicy, withModelOutputBudget } from "@/lib/ai/inference-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const id = requestId(request);
  const startedAt = Date.now();
  try {
    enforceRateLimit(request, 20);
    authorizeAssistantRequest(request);
    await authorizeKnowledgeSession(request);
    const body = await readValidatedJson(request, assistantRequestSchema, 4 * 1024 * 1024);
    const textPart = body.messages[0].parts.find((part) => part.type === "text");
    if (!textPart) throw new ApiHttpError(422, "TEXT_PROMPT_REQUIRED", "Please include a text prompt with your message.");
    const userText = textPart.text;
    if (body.projectId && (process.env.VERCEL === "1" || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname))) throw new ApiHttpError(403, "LOCAL_PROJECTS_ONLY", "项目上下文目前仅在本机开放。");
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
    const autoConfig = body.autoMode ? assertModelConfigured(body.modelProfileId ?? "configured") : null;
    if (autoConfig && body.experience === "work") {
      let autoHost = "";
      try { autoHost = new URL(autoConfig.baseURL).hostname; } catch { /* fail closed */ }
      if (!["localhost", "127.0.0.1", "[::1]"].includes(autoHost)) {
        throw new ApiHttpError(403, "LOCAL_MODEL_REQUIRED", "Work 的自动推理强度只允许本机模型判断。");
      }
    }
    const autoModes = body.modelProfileId === "configured" || !body.modelProfileId ? configuredSupportedModes() : ["light", "medium", "ultra"];
    const selectedMode = autoConfig ? await chooseAutoInferenceMode({ text: userText, model: autoConfig, supportedModes: autoModes, signal: request.signal }) : body.mode;
    const requestedModelContextTokens = getModelConfig(body.modelProfileId ?? "configured").contextTokens;
    let policy;
    try {
      policy = resolveInferencePolicy({
        mode: selectedMode,
        modelProfileId: body.modelProfileId,
        configuredTimeoutMs: process.env.LLM_TIMEOUT_MS?.trim() ? getAssistantTimeoutMs() : undefined,
        modelContextTokens: requestedModelContextTokens,
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
    const codeArtifact = requestsCodeArtifact(userText);
    const weatherLookup = body.workflowMode === "normal" && body.collaboratorAgentIds.length === 0
      && body.knowledgeDocumentIds.length === 0 && !body.wechatSnapshotId && isCurrentWeatherLookup(userText);
    const browserLookup = body.experience === "work" && body.workflowMode === "normal"
      && body.collaboratorAgentIds.length === 0 && body.knowledgeDocumentIds.length === 0
      && !body.wechatSnapshotId && isSimpleBrowserLookup(userText);
    const generationOptions = getModelGenerationOptions(policy.resolvedMode, modelConfig.backend, modelConfig.maxOutputTokens, codeArtifact, modelConfig.contextTokens);
    const basePolicy = withModelOutputBudget(policy, modelConfig.maxOutputTokens);
    const resolvedPolicy = {
      ...basePolicy,
      maxOutputTokens: generationOptions.maxOutputTokens,
    };
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
    if (body.experience === "work" && backendAgent?.type !== "local") throw new ApiHttpError(403, "LOCAL_AGENT_REQUIRED", "微信 Agent 不支持本机文件操作，请选择本地 Agent。");
    const roster = body.collaboratorAgentIds.length ? await getCowAgentRoster() : null;
    const collaborators = body.collaboratorAgentIds.map((agentId) => {
      const agent = roster?.agents.find((candidate) => candidate.id === agentId);
      if (!agent?.enabled || (agent.type !== "local" && agent.type !== "wechat")) throw new ApiHttpError(422, "INVALID_COLLABORATOR", "协作成员必须是已启用的本地或微信 Agent。");
      return agent;
    });
    const role = backendAgent ? loadCowAgentRole(backendAgent) : body.agentRoleId ? loadAgentRole(body.agentRoleId) : undefined;
    const profile = role ? {
      ...baseProfile,
      id: role.id,
      name: role.name,
      instructions: role.instructions + (body.workflowMode === "plan" ? "\n本轮是计划模式：只给出分步骤计划、验证方法与待确认事项，不执行工具、文件或电脑操作，也不要声称已经执行。" : "") + (body.wechatSnapshotId ? "\n本轮含用户确认的本机微信桌面只读快照。只能分析提交的条目，不代表全部历史；身份和附件正文未经解析，切勿声称自己登录、发送或读取了数据库。" : ""),
      toolNames: body.workflowMode === "plan" ? [] : baseProfile.toolNames.filter((name) => role.toolNames.includes(name)),
    } : body.workflowMode === "plan" ? {
      ...baseProfile,
      instructions: baseProfile.instructions + "\n本轮是计划模式：只给出分步骤计划、验证方法与待确认事项，不执行工具、文件或电脑操作，也不要声称已经执行。",
      toolNames: [],
    } : baseProfile;
    // Local 8K models need space for role instructions, tool schemas and output.
    // Selected file正文 may be excerpted to the remaining bounded budget, but
    // user text itself has already been rejected above rather than truncated.
    const assignedKnowledgeIds = backendAgent?.knowledgeBaseIds;
    if (assignedKnowledgeIds && body.knowledgeDocumentIds.some((documentId) => !assignedKnowledgeIds.includes(documentId))) {
      throw new ApiHttpError(403, "KNOWLEDGE_NOT_ASSIGNED", "这份资料未分配给所选 Agent。");
    }
    const knowledgeIds = assignedKnowledgeIds && !body.knowledgeDocumentIds.length ? assignedKnowledgeIds : body.knowledgeDocumentIds;
    const projectContext = body.projectId ? await buildProjectContext(body.projectId, body.currentChatId, Math.max(0, resolvedPolicy.inputBudget.maxContextCharacters - userText.length)) : null;
    if (projectContext) profile.instructions += projectContext.instructions;
    const knowledge = projectContext ? { text: projectContext.text, coverage: projectContext.coverage } : await buildKnowledgeContext(knowledgeIds, Math.max(0, resolvedPolicy.inputBudget.maxContextCharacters - userText.length));
    const uiMessages = knowledge.text ? body.messages.map((message) => {
      let contextAdded = false;
      return {
        ...message,
        parts: message.parts.map((part) => {
          if (part.type !== "text" || contextAdded) return part;
          contextAdded = true;
          return { ...part, text: part.text + knowledge.text };
        }),
      };
    }) : body.messages;
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
      ...(body.experience === "work" && backendAgent ? { leadProgress: { agentId: backendAgent.id, name: backendAgent.name, ...(backendAgent.avatar === "image" ? { avatarUrl: `/api/v1/cowagent/agents/${encodeURIComponent(backendAgent.id)}/avatar?v=${encodeURIComponent(backendAgent.avatarRev || "0")}` } : {}) } } : {}),
      ...(collaborators.length ? { prepare: (onProgress: (progress: import("@/lib/contracts/agent-progress").AgentProgress) => void, signal: AbortSignal) => runLocalAgentTeam({ collaborators, lead: backendAgent, model: modelConfig, userText, ...(projectContext ? { projectContext: { instructions: projectContext.instructions, text: projectContext.text, projectOnly: projectContext.project.memoryMode === "project-only" } } : {}), signal, collaborationMode: body.collaborationMode ?? inferCollaborationMode(userText), planOnly: body.workflowMode === "plan", onProgress }) } : {}),
      options: { mode: policy.resolvedMode, customer, profile, modelProfileId: modelConfig.profileId, projectOnly: projectContext?.project.memoryMode === "project-only",
        codeArtifact, browserLookup, weatherLookup, continuation: false, ...(body.workflowMode !== "plan" && body.experience === "work" && backendAgent ? { workAgentId: backendAgent.id, workAgentPermissions: backendAgent.permissions ?? { read: true, create: false, modify: false, delete: false, tools: false } } : {}) },
      abortSignal: request.signal,
      timeoutMs: Math.max(30_000, resolvedPolicy.timeoutMs - (Date.now() - startedAt)),
      transform: codeArtifact ? undefined : attachmentTextTransform(),
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": id,
        "X-Model-Id": modelConfig.model,
        "X-Agent-Team": [backendAgent?.id, ...collaborators.map((agent) => agent.id)].filter(Boolean).join(","),
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
