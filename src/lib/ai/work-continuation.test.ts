import { describe, expect, it } from "vitest";
import { buildWorkContinuationPrompt } from "./work-continuation";

describe("Work requirements added to the current task", () => {
  it("preserves the full original task and all added requirements", () => {
    const original = "三位 Agent 辩论 AI 发展，BibleDog 为裁判。" + "任务范围。".repeat(70);
    const prompt = buildWorkContinuationPrompt([
      { user: original, assistant: "第一轮辩论结果" },
      { user: "保留双方反驳记录", assistant: "双方已经完成反驳" },
    ], "最后一定要给出成果", 4000);
    expect(prompt).toContain(original);
    expect(prompt).toContain("保留双方反驳记录");
    expect(prompt).toContain("最后一定要给出成果");
    expect(prompt).toContain("双方已经完成反驳");
    expect(prompt).toContain("新增要求追加到原任务");
  });

  it("shortens result excerpts within budget while retaining user instructions", () => {
    const prompt = buildWorkContinuationPrompt([{ user: "原始工作目标", assistant: "已有成果".repeat(3000) }], "输出最终结论", 700);
    expect(prompt.length).toBeLessThanOrEqual(700);
    expect(prompt).toContain("原始工作目标");
    expect(prompt).toContain("输出最终结论");
    expect(prompt).toContain("成果摘录已截短");
  });

  it("refuses to silently cut an oversized original task", () => {
    expect(() => buildWorkContinuationPrompt([{ user: "原始要求".repeat(1000), assistant: "" }], "新增要求", 600)).toThrow("原任务和追加要求超过");
  });
});
