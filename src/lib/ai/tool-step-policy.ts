import type { ModelMessage } from "ai";

/** Reserve the last model call for an answer using the evidence already read. */
export function prepareToolStep(input: {
  messages: ModelMessage[];
  stepNumber: number;
  maxSteps: number;
  instructions: string;
  weatherLookup: boolean;
}) {
  if (input.weatherLookup) {
    return {
      messages: input.messages,
      toolChoice: input.stepNumber === 0 ? { type: "tool" as const, toolName: "currentWeather" as const } : "none" as const,
    };
  }
  if (input.stepNumber >= input.maxSteps - 1) {
    return {
      messages: input.messages,
      toolChoice: "none" as const,
      instructions: `${input.instructions}\n本轮工具查询已结束。现在必须直接给出最终答复，只使用本轮已经返回的资料和执行回执；无匹配或缺少证据时明确说明，不编造型号、规格或成功状态。不要继续查询，也不要只说“我再找一下”。`,
    };
  }
  return { messages: input.messages };
}
