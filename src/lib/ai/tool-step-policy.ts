import type { ModelMessage } from "ai";

/** Reserve the last model call for an answer using the evidence already read. */
export function prepareToolStep(input: {
  messages: ModelMessage[];
  stepNumber: number;
  maxSteps: number;
  instructions: string;
  weatherLookup: boolean;
  workTask?: boolean;
}) {
  if (input.weatherLookup) {
    return {
      messages: input.messages,
      toolChoice: input.stepNumber === 0 ? { type: "tool" as const, toolName: "currentWeather" as const } : "none" as const,
    };
  }
  if (input.workTask) {
    const calls = input.messages.flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "tool-call").map((part) => JSON.stringify([part.toolName, part.input])) : []);
    const recent = calls.slice(-3);
    if (recent.length === 3 && recent.every((call) => call === recent[0])) return {
      messages: input.messages, toolChoice: "none" as const,
      instructions: `${input.instructions}\n同一工具参数已连续执行三次，本轮停止重复操作。依据已有回执说明已完成部分和具体阻碍；不要声称未执行的部分已经成功。`,
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
