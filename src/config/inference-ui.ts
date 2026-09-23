export const INFERENCE_MODES = [
  { id: "light", label: "Light", subtitle: "快速回答", detail: "直接回答，使用较短的生成预算。" },
  { id: "medium", label: "Medium", subtitle: "标准处理", detail: "检查主要要求，使用中等生成预算。" },
  { id: "ultra", label: "Ultra", subtitle: "深度处理", detail: "逐项核对要求，使用更长的生成预算与等待时间。" },
] as const;
export type InferenceMode = typeof INFERENCE_MODES[number]["id"];
export const inferenceModeLabel = (mode: string) => INFERENCE_MODES.find((item) => item.id === mode)?.label ?? mode;
export function savedInferenceMode(): InferenceMode {
  try {
    const saved = localStorage.getItem("lumaflow.inference.mode");
    const migrated = saved === "instant" ? "light" : saved === "high" || saved === "extra-high" || saved === "pro" ? "ultra" : saved;
    return INFERENCE_MODES.find((item) => item.id === migrated)?.id ?? "light";
  } catch { return "light"; }
}
export function persistInferenceMode(mode: InferenceMode) {
  try { localStorage.setItem("lumaflow.inference.mode", mode); } catch { /* Optional local preference. */ }
}

export type InferenceReceipt = { model: string; mode: string; thinking: boolean | null; outputBudget: number; inputBudget: number };
export function parseInferenceReceipt(headers: Headers): InferenceReceipt | null {
  const model = headers.get("X-Model-Id");
  const mode = headers.get("X-Inference-Mode");
  const thinking = headers.get("X-Thinking-Enabled");
  const outputBudget = Number(headers.get("X-Output-Budget"));
  const inputBudget = Number(headers.get("X-Input-Budget"));
  if (!model || !mode || !INFERENCE_MODES.some((item) => item.id === mode) || !["true", "false", "unknown"].includes(thinking ?? "") || !Number.isInteger(outputBudget) || outputBudget < 1 || !Number.isInteger(inputBudget) || inputBudget < 1) return null;
  return { model, mode, thinking: thinking === "unknown" ? null : thinking === "true", outputBudget, inputBudget };
}
