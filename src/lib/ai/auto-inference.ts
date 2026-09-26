import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

export type AutoInferenceChoice = "light" | "medium" | "ultra";
const choices: AutoInferenceChoice[] = ["light", "medium", "ultra"];

function fallbackChoice(text: string): AutoInferenceChoice {
  if (/(?:完整|复杂|多步骤|深入|长文|报告|论文|文档|网页|网站|代码|程序|分析|计划|debug|refactor|html|javascript)/i.test(text) || text.length > 650) return "ultra";
  if (text.length > 140 || /(?:比较|解释|整理|总结|写一篇|怎么做)/.test(text)) return "medium";
  return "light";
}

/** A closed-set local model judgment; code validates the answer and retains the fallback. */
export async function chooseAutoInferenceMode(input: {
  text: string;
  model: { baseURL: string; apiKey?: string; model: string };
  supportedModes: string[];
  signal: AbortSignal;
}): Promise<AutoInferenceChoice> {
  const available = choices.filter((choice) => input.supportedModes.includes(choice));
  if (!available.length) return "light";
  if (available.length === 1) return available[0];
  const fallback = available.includes(fallbackChoice(input.text)) ? fallbackChoice(input.text) : available[available.length - 1];
  try {
    const provider = createOpenAICompatible({ name: "lumaflow-auto", baseURL: input.model.baseURL, apiKey: input.model.apiKey || "local" });
    const response = await generateText({
      model: provider.chatModel(input.model.model),
      system: `你只做一个选择题。根据任务需要的推理与输出长度，从 ${available.join("、")} 中选一个；只输出一个英文选项。light=简短直接答复；medium=需要解释和整理；ultra=代码、长文、复杂计划和多约束任务。不要解答用户问题。`,
      prompt: input.text.slice(0, 1_600),
      maxOutputTokens: 20,
      timeout: { totalMs: 12_000 },
      abortSignal: input.signal,
    });
    const answer = response.text.trim().toLowerCase().match(/\b(light|medium|ultra)\b/)?.[1] as AutoInferenceChoice | undefined;
    return answer && available.includes(answer) ? answer : fallback;
  } catch {
    return fallback;
  }
}
