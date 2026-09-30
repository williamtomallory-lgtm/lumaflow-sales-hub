import { describe, expect, it } from "vitest";
import { knowledgeClassificationSchema } from "./contracts";

describe("knowledge classification contract", () => {
  it("accepts a bounded, enumerated model result", () => {
    const result = knowledgeClassificationSchema.parse({
      category: "销售话术",
      title: "轨道灯客户沟通话术",
      summary: "整理客户询问轨道灯时的标准沟通要点。",
      tags: ["轨道灯", "话术"],
      confidence: 0.82,
    });
    expect(result.category).toBe("销售话术");
    expect(result.confidence).toBe(0.82);
  });

  it("rejects arbitrary categories, confidence outside 0..1, and extra fields", () => {
    expect(knowledgeClassificationSchema.safeParse({ category: "客户私密", title: "x", summary: "x", tags: [], confidence: 0.8 }).success).toBe(false);
    expect(knowledgeClassificationSchema.safeParse({ category: "FAQ", title: "x", summary: "x", tags: [], confidence: 1.2 }).success).toBe(false);
    expect(knowledgeClassificationSchema.safeParse({ category: "FAQ", title: "x", summary: "x", tags: [], confidence: 0.8, execute: "delete files" }).success).toBe(false);
  });
});
