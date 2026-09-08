import "server-only";

import { assistantModelProfileIdSchema, type AssistantModelProfileId } from "../contracts/api";
import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_MAX_OUTPUT_TOKENS, MIN_MAX_OUTPUT_TOKENS, type ModelBackend } from "./model-options";

export const QWEN_PROVIDER_NAME = "vllm";
export const DEFAULT_MODEL_PROFILE_ID: AssistantModelProfileId = "local-qwen3-8b";
export const LOCAL_QWEN3_8B_MODEL_ID = "lumaflow-qwen3-8b:latest";
// Keep the official Ollama tag for 14B so setup can pull it without creating a
// second alias or duplicating the roughly 9 GB base weight on disk.
export const LOCAL_QWEN3_14B_MODEL_ID = "qwen3:14b";
// Backwards-compatible name used by the existing verification script/tests.
export const LOCAL_MODEL_ID = LOCAL_QWEN3_8B_MODEL_ID;

// Server-owned allowlist: requests select an ID, never a URL, credential, or model name.
const MODEL_PROFILES = {
  "local-qwen3-8b": {
    label: "Qwen3 8B · 本机演示",
    description: "Ollama 本地 4-bit 模型，8K 上下文；适用于 16GB 内存、8GB 显存笔记本。",
    family: "Qwen3",
    parameterSizeB: 8,
    supportedModes: ["instant", "medium", "high", "extra-high"] as const,
  },
  "local-qwen3-14b": {
    label: "Qwen3 14B · 本机演示",
    description: "官方 Ollama Qwen3:14b；约 9GB Q4 权重，8K 上下文，8GB 显存将使用 CPU/GPU 混合，16GB 内存可能较慢或不足。",
    family: "Qwen3",
    parameterSizeB: 14,
    supportedModes: ["instant", "medium", "high", "extra-high", "pro"] as const,
  },
  configured: {
    description: "由服务器 LLM_* 环境变量配置的模型服务。",
    family: "custom",
    parameterSizeB: null,
    supportedModes: ["instant"] as const,
  },
} as const;

function configurationError(message: string) {
  const error = new Error(message);
  error.name = "ModelNotConfiguredError";
  return error;
}

export function getModelConfig(profileId: AssistantModelProfileId = "configured") {
  assistantModelProfileIdSchema.parse(profileId);
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
  const baseURL = process.env.LLM_BASE_URL?.trim().replace(/\/$/, "") || null;
  const backend = process.env.LLM_BACKEND?.trim() || "vllm";
  if (backend !== "vllm" && backend !== "openai-compatible" && backend !== "ollama") {
    throw configurationError("LLM_BACKEND must be vllm or openai-compatible or ollama.");
  }
  const configuredBudget = process.env.LLM_MAX_OUTPUT_TOKENS?.trim();
  const maxOutputTokens = configuredBudget ? Number(configuredBudget) : DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < MIN_MAX_OUTPUT_TOKENS || maxOutputTokens > MAX_MAX_OUTPUT_TOKENS) {
    throw configurationError(`LLM_MAX_OUTPUT_TOKENS must be an integer from ${MIN_MAX_OUTPUT_TOKENS} to ${MAX_MAX_OUTPUT_TOKENS}.`);
  }
  const model = process.env.LLM_MODEL?.trim() || "lumaflow-qwen";
  return {
    profileId,
    label: `${model} · 自定义服务`,
    description: MODEL_PROFILES.configured.description,
    baseURL,
    backend: backend as ModelBackend,
    maxOutputTokens,
    apiKey: process.env.LLM_API_KEY?.trim() || "local",
    model,
    connectionKind: process.env.LLM_CONNECTION_KIND === "protocol-mock" ? "protocol-mock" as const : "live" as const,
    contextTokens: null,
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
  };
  if (!config.baseURL) {
    return { ...publicConfig, configured: false, reachable: false, latencyMs: null };
  }
  const startedAt = performance.now();
  try {
    const response = await fetch(`${config.baseURL}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`Model server returned ${response.status}`);
    const payload: unknown = await response.json();
    const advertisedModels = payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data)
      ? payload.data.flatMap((item: unknown) => item && typeof item === "object" && "id" in item && typeof item.id === "string" ? [item.id] : [])
      : [];
    const reachable = advertisedModels.includes(config.model);
    return { ...publicConfig, configured: true, reachable, latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    return { ...publicConfig, configured: true, reachable: false, latencyMs: null };
  }
}

export async function getModelOptions() {
  return Promise.all(assistantModelProfileIdSchema.options.map(async (id) => {
    try {
      const config = getModelConfig(id);
      const health = await getModelHealth(id);
      return {
        id,
        label: config.label,
        model: config.model,
        description: config.description,
        configured: health.configured,
        reachable: health.reachable,
        connectionKind: config.connectionKind,
        contextTokens: config.contextTokens,
        family: MODEL_PROFILES[id].family,
        parameterSizeB: MODEL_PROFILES[id].parameterSizeB,
        supportedModes: [...MODEL_PROFILES[id].supportedModes],
      };
    } catch (error) {
      // A broken optional custom profile must not hide the independent local model.
      if (id !== "configured" || !(error instanceof Error) || error.name !== "ModelNotConfiguredError") throw error;
      const model = process.env.LLM_MODEL?.trim() || "lumaflow-qwen";
      return {
        id,
        label: `${model} · 自定义服务`,
        model,
        description: "自定义服务配置无效，请检查服务器 LLM_* 环境变量。",
        configured: false,
        reachable: false,
        connectionKind: process.env.LLM_CONNECTION_KIND === "protocol-mock" ? "protocol-mock" as const : "live" as const,
        contextTokens: null,
        family: MODEL_PROFILES.configured.family,
        parameterSizeB: MODEL_PROFILES.configured.parameterSizeB,
        supportedModes: [...MODEL_PROFILES.configured.supportedModes],
      };
    }
  }));
}
