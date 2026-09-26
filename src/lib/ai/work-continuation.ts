export type WorkContextTurn = { user: string; assistant: string };

/** Keep user requirements intact; only shorten the model's public result excerpts. */
export function buildWorkContinuationPrompt(
  turns: readonly WorkContextTurn[],
  requirement: string,
  characterBudget: number,
): string {
  if (!turns.length) return requirement;
  const original = turns[0].user;
  const additions = turns.slice(1).map((turn, index) => `${index + 1}. ${turn.user}`).join("\n\n");
  const instructions = [
    "继续当前同一项工作。以下新增要求追加到原任务，保留原任务目标、已有成果和仍然有效的要求。根据已有成果继续完成工作，并给出结果。",
    `原始任务：\n${original}`,
    ...(additions ? [`此前追加的要求：\n${additions}`] : []),
    `当前请求（新增要求）：\n${requirement}`,
  ].join("\n\n");
  if (instructions.length > characterBudget) {
    throw new Error("原任务和追加要求超过当前模型上下文上限；消息已保留，请缩小任务或开始新对话。");
  }
  const resultsHeader = "\n\n此前实际产生的公开成果（仅作上下文）：\n";
  let remaining = characterBudget - instructions.length - resultsHeader.length;
  const excerpts: string[] = [];
  for (let index = turns.length - 1; index >= 0 && remaining > 40; index -= 1) {
    const answer = turns[index].assistant.trim();
    if (!answer) continue;
    const prefix = `第 ${index + 1} 轮：\n`;
    const room = remaining - prefix.length - 2;
    if (room <= 20) break;
    const shortened = answer.length > room;
    const body = shortened ? `${answer.slice(0, Math.max(0, room - 12))}\n[成果摘录已截短]` : answer;
    const excerpt = prefix + body;
    excerpts.unshift(excerpt);
    remaining -= excerpt.length + 2;
  }
  return instructions + (excerpts.length ? resultsHeader + excerpts.join("\n\n") : "");
}
