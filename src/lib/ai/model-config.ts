import "server-only";

import { assistantInferenceProfileSchema, assistantModelProfileIdSchema, builtinModelProfileIdSchema, type AssistantModelProfileId } from "../contracts/api";
import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_MAX_OUTPUT_TOKENS, MIN_MAX_OUTPUT_TOKENS, type ModelBackend } from "./model-options";
import { getLocalModelProfile, getLocalModelProfiles } from "./local-model-registry";

export const QWEN_PROVIDER_NAME = "vllm";
export const DEFAULT_MODEL_PROFILE_ID: AssistantModelProfileId = "local-qwen3-8b";
export const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
export const LOCAL_QWEN3_8B_MODEL_ID = "lumaflow-qwen3-8b:latest";
// Keep the official Ollama tag for 14B so setup can pull it without creating a
// second alias or duplicating the roughly 9 GB base weight on disk.
export const LOCAL_QWEN3_14B_MODEL_ID = "qwen3:14b";
// Backwards-compatible name used by the existing verification script/tests.
export const LOCAL_MODEL_ID = LOCAL_QWEN3_8B_MODEL_ID;

export function isManagedLocalModel(profileId: string) {
  if (process.env.LOCAL_MODEL_SWITCHING !== "true" || process.platform !== "win32" || process.env.VERCEL === "1") return false;
  const local = getLocalModelProfile(profileId);
  if (local) return local.runtime === "strata" && local.installationStatus === "ready";
  return profileId === "configured" && process.env.LLM_MODEL?.trim() === "ternary-bonsai-2-27b"
    && process.env.LLM_BASE_URL?.trim().replace(/\/$/, "") === "http://127.0.0.1:8081/v1";
}

export function getDefaultModelProfileId(): AssistantModelProfileId {
  const configured = assistantModelProfileIdSchema.safeParse(process.env.LLM_DEFAULT_PROFILE?.trim());
  const visible = process.env.LLM_VISIBLE_PROFILES?.split(",").map((id) => id.trim());
  const known = (id: string) => builtinModelProfileIdSchema.safeParse(id).success || Boolean(getLocalModelProfile(id));
  if (configured.success && known(configured.data) && (!visible || visible.includes(configured.data))) return configured.data;
  if (visible && !visible.includes(DEFAULT_MODEL_PROFILE_ID)) {
    const firstReady = visible.map((id) => assistantModelProfileIdSchema.safeParse(id)).find((item) => item.success && known(item.data));
    if (firstReady?.success) return firstReady.data;
  }
  return DEFAULT_MODEL_PROFILE_ID;
}

function configuredModelMetadata() {
  const size = Number(process.env.LLM_PARAMETER_SIZE_B);
  const context = Number(process.env.LLM_CONTEXT_TOKENS);
  return {
    family: process.env.LLM_FAMILY?.trim().slice(0, 80) || "custom",
    parameterSizeB: Number.isFinite(size) && size > 0 && size <= 10_000 ? size : null,
    contextTokens: Number.isInteger(context) && context >= 512 && context <= 10_000_000 ? context : null,
  };
}

export function configuredSupportedModes() {
  const values = process.env.LLM_SUPPORTED_MODES?.split(",") ?? ["light"];
  return [...new Set(values.flatMap((value) => {
    const parsed = assistantInferenceProfileSchema.safeParse(value.trim());
    if (!parsed.success || parsed.data === "pro") return [];
    // Older deployments used the former mode names while the UI now exposes
    // Light / Medium / Ultra. Keep those existing settings usable after upgrade.
    const currentMode = parsed.data === "instant" ? "light" : parsed.data === "high" ? "medium" : parsed.data === "extra-high" ? "ultra" : parsed.data;
    return [currentMode];
  }))];
}

function remoteOpenAIKeyRequired(baseURL: string | null, backend: string) {
  if (!baseURL || backend !== "openai-compatible") return false;
  try {
    return !LOOPBACK_MODEL_HOSTS.has(new URL(baseURL).hostname);
  } catch {
    return true;
  }
}

const LOOPBACK_MODEL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Server-owned allowlist: requests select an ID, never a URL, credential, or model name.
const MODEL_PROFILES = {
  "local-qwen3-8b": {
    label: "Qwen3 8B · 本机演示",
    description: "Ollama 本地 4-bit 模型，8K 上下文；适用于 16GB 内存、8GB 显存笔记本。",
    family: "Qwen3",
    parameterSizeB: 8,
    supportedModes: ["light", "medium", "ultra", "instant", "high", "extra-high"] as const,
  },
  "local-qwen3-14b": {
    label: "Qwen3 14B · 本机演示",
    description: "官方 Ollama Qwen3:14b；约 9GB Q4 权重，8K 上下文，8GB 显存将使用 CPU/GPU 混合，16GB 内存可能较慢或不足。",
    family: "Qwen3",
    parameterSizeB: 14,
    supportedModes: ["light", "medium", "ultra", "instant", "high", "extra-high", "pro"] as const,
  },
  configured: {
    description: "由服务器 LLM_* 环境变量配置的远程模型服务。",
    family: "custom",
    parameterSizeB: null,
    supportedModes: ["light"] as const,
  },
} as const;

function configurationError(message: string) {
  const error = new Error(message);
  error.name = "ModelNotConfiguredError";
  return error;
}

export function getModelConfig(profileId: AssistantModelProfileId = "configured") {
  assistantModelProfileIdSchema.parse(profileId);
  if (profileId.startsWith("local:")) {
    const local = getLocalModelProfile(profileId);
    if (!local) throw configurationError("The requested local model is not registered on this computer.");
    return {
      profileId, label: local.label, description: local.description,
      baseURL: local.baseURL.replace(/\/$/, ""), backend: local.backend as ModelBackend,
      maxOutputTokens: local.maxOutputTokens,
      apiKey: local.apiKeyEnv ? process.env[local.apiKeyEnv]?.trim() || "" : "local",
      model: local.model, connectionKind: "live" as const, contextTokens: local.contextTokens,
    };
  }
  if (profileId === "local-qwen3-8b" || profileId === "local-qwen3-14b") {
    const is14b = profileId === "local-qwen3-14b";
    return {
      profileId,
      label: MODEL_PROFILES[profileId].label,
      description: MODEL_PROFILES[profileId].description,
      baseURL: "http://127.0.0.1:11434/v1",
      backend: "ollama" as ModelBackend,
      // New thinking profiles need their full completion budget (thinking
      // plus answer); old modes still apply their own historical ceilings in
      // getModelGenerationOptions.
      maxOutputTokens: 4_096,
      apiKey: "ollama-local",
      model: is14b ? LOCAL_QWEN3_14B_MODEL_ID : LOCAL_QWEN3_8B_MODEL_ID,
      connectionKind: "live" as const,
      contextTokens: 8_192,
    };
  }
  const configuredBaseURL = process.env.LLM_BASE_URL?.trim().replace(/\/$/, "") || null;
  const backend = process.env.LLM_BACKEND?.trim() || "vllm";
  if (backend !== "vllm" && backend !== "openai-compatible" && backend !== "ollama" && backend !== "vercel-ai-gateway") {
    throw configurationError("LLM_BACKEND must be vllm, openai-compatible, ollama, or vercel-ai-gateway.");
  }
  const baseURL = backend === "vercel-ai-gateway" ? configuredBaseURL || VERCEL_AI_GATEWAY_BASE_URL : configuredBaseURL;
  const configuredBudget = process.env.LLM_MAX_OUTPUT_TOKENS?.trim();
  const maxOutputTokens = configuredBudget ? Number(configuredBudget) : DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < MIN_MAX_OUTPUT_TOKENS || maxOutputTokens > MAX_MAX_OUTPUT_TOKENS) {
    throw configurationError(`LLM_MAX_OUTPUT_TOKENS must be an integer from ${MIN_MAX_OUTPUT_TOKENS} to ${MAX_MAX_OUTPUT_TOKENS}.`);
  }
  const model = process.env.LLM_MODEL?.trim() || "lumaflow-qwen";
  const explicitApiKey = process.env.LLM_API_KEY?.trim() || "";
  const metadata = configuredModelMetadata();
  return {
    profileId,
    label: process.env.LLM_DISPLAY_NAME?.trim().slice(0, 120) || (backend === "vercel-ai-gateway" ? `${model} · Vercel AI Gateway` : `${model} · 自定义服务`),
    description: process.env.LLM_DESCRIPTION?.trim().slice(0, 500) || (backend === "vercel-ai-gateway" ? "Vercel 托管的远程推理服务；凭据由部署环境的 OIDC 管理。" : MODEL_PROFILES.configured.description),
    baseURL,
    backend: backend as ModelBackend,
    maxOutputTokens,
    apiKey: explicitApiKey || (remoteOpenAIKeyRequired(baseURL, backend) || backend === "vercel-ai-gateway" ? "" : "local"),
    model,
    connectionKind: process.env.LLM_CONNECTION_KIND === "protocol-mock" ? "protocol-mock" as const : "live" as const,
    contextTokens: metadata.contextTokens,
  };
}

export function getAssistantTimeoutMs() {
  const configured = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(configured) ? Math.min(300_000, Math.max(5_000, configured)) : 120_000;
}

export function assertModelConfigured(profileId?: AssistantModelProfileId) {
  const config = getModelConfig(profileId);
  if (!config.baseURL) {
    throw configurationError("The local model is not configured. Set LLM_BACKEND, LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL on the server.");
  }
  if ((remoteOpenAIKeyRequired(config.baseURL, config.backend) || getLocalModelProfile(config.profileId)?.apiKeyEnv) && !config.apiKey) {
    throw configurationError("A remote OpenAI-compatible model requires LLM_API_KEY on the server.");
  }
  return { ...config, baseURL: config.baseURL };
}

export async function getModelHealth(profileId?: AssistantModelProfileId) {
  const config = getModelConfig(profileId);
  const publicConfig = {
    provider: "vllm-openai-compatible" as const,
    connectionKind: config.connectionKind,
    model: config.model,
    profileId: config.profileId,
    contextTokens: config.contextTokens,
    runtimeManaged: isManagedLocalModel(config.profileId),
  };
  if (!config.baseURL) {
    return { ...publicConfig, configured: false, reachable: false, latencyMs: null };
  }
  if ((remoteOpenAIKeyRequired(config.baseURL, config.backend) || getLocalModelProfile(config.profileId)?.apiKeyEnv) && !config.apiKey) {
    return { ...publicConfig, configured: false, reachable: false, latencyMs: null };
  }
  const startedAt = performance.now();
  try {
    const response = await fetch(`${config.baseURL}/models`, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`Model server returned ${response.status}`);
    const payload: unknown = await response.json();
    const advertisedModels = payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data)
      ? payload.data.flatMap((item: unknown) => item && typeof item === "object" && "id" in item && typeof item.id === "string" ? [item.id] : [])
      : [];
    let reachable = advertisedModels.includes(config.model);
    if (reachable && config.backend === "strata") {
      const health = await fetch(`${config.baseURL.replace(/\/v1$/, "")}/health`, {
        cache: "no-store", signal: AbortSignal.timeout(3_000),
      });
      const state = health.ok ? await health.json() : null;
      reachable = state?.service === "strata" && state?.loaded === true && state?.model === config.model;
    }
    return { ...publicConfig, configured: true, reachable, latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    return { ...publicConfig, configured: true, reachable: false, latencyMs: null };
  }
}

export async function getModelOptions() {
  const visibleSetting = process.env.LLM_VISIBLE_PROFILES?.trim();
  const requestedIds = visibleSetting ? visibleSetting.split(",").map((id) => id.trim()) : undefined;
  const registered = getLocalModelProfiles();
  const visibleIds = [...builtinModelProfileIdSchema.options, ...registered.map((entry) => entry.id)].filter((id) => !requestedIds || requestedIds.includes(id));
  if (visibleIds.length === 0) throw configurationError("LLM_VISIBLE_PROFILES must include a known model profile.");
  return Promise.all(visibleIds.map(async (id) => {
    try {
      const config = getModelConfig(id);
      const health = await getModelHealth(id);
      const local = registered.find((entry) => entry.id === id);
      const metadata = id === "configured" ? configuredModelMetadata() : local ?? MODEL_PROFILES[id as "local-qwen3-8b" | "local-qwen3-14b"];
      return {
        id,
        label: config.label,
        model: config.model,
        description: config.description,
        configured: health.configured,
        reachable: health.reachable,
        connectionKind: config.connectionKind,
        contextTokens: config.contextTokens,
        family: metadata.family,
        parameterSizeB: metadata.parameterSizeB,
        supportedModes: id === "configured" ? configuredSupportedModes() : local ? ["light", "medium", "ultra"] as const : [...MODEL_PROFILES[id as "local-qwen3-8b" | "local-qwen3-14b"].supportedModes],
        installationStatus: health.reachable ? "ready" as const : local?.installationStatus ?? "ready" as const,
        runtimeManaged: isManagedLocalModel(id),
      };
    } catch (error) {
      // A broken optional custom profile must not hide the independent local model.
      if (id !== "configured" || !(error instanceof Error) || error.name !== "ModelNotConfiguredError") throw error;
      const model = process.env.LLM_MODEL?.trim() || "lumaflow-qwen";
      return {
        id,
        label: process.env.LLM_DISPLAY_NAME?.trim().slice(0, 120) || `${model} · 自定义服务`,
        model,
        description: "自定义服务配置无效，请检查服务器 LLM_* 环境变量。",
        configured: false,
        reachable: false,
        connectionKind: process.env.LLM_CONNECTION_KIND === "protocol-mock" ? "protocol-mock" as const : "live" as const,
        contextTokens: null,
        family: MODEL_PROFILES.configured.family,
        parameterSizeB: MODEL_PROFILES.configured.parameterSizeB,
        supportedModes: configuredSupportedModes(),
        installationStatus: "ready" as const,
      };
    }
  }));
}
