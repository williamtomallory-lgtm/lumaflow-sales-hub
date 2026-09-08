import "server-only";

import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_MAX_OUTPUT_TOKENS, MIN_MAX_OUTPUT_TOKENS, type ModelBackend } from "./model-options";

export const QWEN_PROVIDER_NAME = "vllm";

function configurationError(message: string) {
  const error = new Error(message);
  error.name = "ModelNotConfiguredError";
  return error;
}

export function getModelConfig() {
  const baseURL = process.env.LLM_BASE_URL?.trim().replace(/\/$/, "") || null;
  const backend = process.env.LLM_BACKEND?.trim() || "vllm";
  if (backend !== "vllm" && backend !== "openai-compatible") {
    throw configurationError("LLM_BACKEND must be vllm or openai-compatible.");
  }
  const configuredBudget = process.env.LLM_MAX_OUTPUT_TOKENS?.trim();
  const maxOutputTokens = configuredBudget ? Number(configuredBudget) : DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < MIN_MAX_OUTPUT_TOKENS || maxOutputTokens > MAX_MAX_OUTPUT_TOKENS) {
    throw configurationError(`LLM_MAX_OUTPUT_TOKENS must be an integer from ${MIN_MAX_OUTPUT_TOKENS} to ${MAX_MAX_OUTPUT_TOKENS}.`);
  }
  return {
    baseURL,
    backend: backend as ModelBackend,
    maxOutputTokens,
    apiKey: process.env.LLM_API_KEY?.trim() || "local",
    model: process.env.LLM_MODEL?.trim() || "lumaflow-qwen",
    connectionKind: process.env.LLM_CONNECTION_KIND === "protocol-mock" ? "protocol-mock" as const : "live" as const,
  };
}

export function getAssistantTimeoutMs() {
  const configured = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(configured) ? Math.min(300_000, Math.max(5_000, configured)) : 120_000;
}

export function assertModelConfigured() {
  const config = getModelConfig();
  if (!config.baseURL) {
    throw configurationError("The local model is not configured. Set LLM_BACKEND, LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL on the server.");
  }
  return { ...config, baseURL: config.baseURL };
}

export async function getModelHealth() {
  const config = getModelConfig();
  if (!config.baseURL) {
    return { configured: false, reachable: false, provider: "vllm-openai-compatible" as const, connectionKind: config.connectionKind, model: config.model, latencyMs: null };
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
    return { configured: true, reachable, provider: "vllm-openai-compatible" as const, connectionKind: config.connectionKind, model: config.model, latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    return { configured: true, reachable: false, provider: "vllm-openai-compatible" as const, connectionKind: config.connectionKind, model: config.model, latencyMs: null };
  }
}
