export const INFERENCE_MODES = [
  { id: "instant", label: "Instant", subtitle: "快速回答", detail: "关闭思考，优先响应速度。" },
  { id: "medium", label: "Medium", subtitle: "标准推理", detail: "开启思考，使用标准生成预算。" },
  { id: "high", label: "High", subtitle: "更长推理", detail: "开启思考，提高生成预算，等待更久。" },
  { id: "extra-high", label: "Extra High", subtitle: "最高预算", detail: "使用本机支持的最高推理与输出预算，减少可放入的资料长度。" },
  { id: "pro", label: "Pro", subtitle: "较大模型", detail: "明确切换至本机 Qwen3 14B，以较高预算处理；不会调用收费云模型。" },
] as const;
export type InferenceMode = typeof INFERENCE_MODES[number]["id"];
export const inferenceModeLabel = (mode: string) => INFERENCE_MODES.find((item) => item.id === mode)?.label ?? mode;
export function savedInferenceMode(): InferenceMode {
  try {
    const saved = localStorage.getItem("lumaflow.inference.mode");
    return INFERENCE_MODES.find((item) => item.id === saved)?.id ?? "instant";
  } catch { return "instant"; }
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
