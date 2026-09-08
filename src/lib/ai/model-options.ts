import type { AssistantReasoningMode } from "../contracts/api";

export type ModelBackend = "vllm" | "openai-compatible";

export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const MIN_MAX_OUTPUT_TOKENS = 256;
export const MAX_MAX_OUTPUT_TOKENS = 32_768;

/** Pure options adapter. Generic mode names set output budgets, not thinking state. */
export function getModelGenerationOptions(
  mode: AssistantReasoningMode,
  backend: ModelBackend,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
) {
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < MIN_MAX_OUTPUT_TOKENS || maxOutputTokens > MAX_MAX_OUTPUT_TOKENS) {
    throw new RangeError(`maxOutputTokens must be an integer from ${MIN_MAX_OUTPUT_TOKENS} to ${MAX_MAX_OUTPUT_TOKENS}.`);
  }

  if (backend === "openai-compatible") {
    const budget = mode === "fast" ? 2_048 : mode === "normal" ? 4_096 : maxOutputTokens;
    return {
      temperature: 0.7,
      topP: 0.8,
      maxOutputTokens: Math.min(budget, maxOutputTokens),
    };
  }

  if (backend !== "vllm") throw new Error(`Unsupported model backend: ${backend}`);

  const thinkingEnabled = mode !== "fast";
  const budget = mode === "fast" ? 2_048 : mode === "normal" ? DEFAULT_MAX_OUTPUT_TOKENS : maxOutputTokens;
  return {
    temperature: thinkingEnabled ? 1 : 0.7,
    topP: thinkingEnabled ? 0.95 : 0.8,
    maxOutputTokens: Math.min(budget, maxOutputTokens),
    providerOptions: {
      vllm: {
        reasoningEffort: mode === "deep" ? "xhigh" : mode === "normal" ? "medium" : "low",
        top_k: 20,
        chat_template_kwargs: { enable_thinking: thinkingEnabled },
      },
    },
  };
}
