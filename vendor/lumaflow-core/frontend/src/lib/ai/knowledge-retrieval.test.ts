// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const list = vi.hoisted(() => vi.fn());
vi.mock("../knowledge/store", () => ({ listKnowledgeRecords: list }));
import { searchConfirmedKnowledge } from "./knowledge-retrieval";
describe("confirmed file search", () => {
  it("does not silently publish unreviewed chats and only returns matched excerpts", async () => {
    const base = { title: "新灯具说明", originalName: "灯具.txt", tags: ["灯具"], extractedText: "新增灯具支持3000K色温。", classificationStatus: "classified", version: "v1", updatedAt: "2026-09-07", category: "产品知识" };
    list.mockResolvedValue([{ ...base, id: "manual", classificationSource: "manual" }, { ...base, id: "model", classificationSource: "model" }, { ...base, id: "archived", classificationSource: "manual", classificationStatus: "archived" }]);
    const results = await searchConfirmedKnowledge("灯具");
    expect(results.map((entry) => entry.id)).toEqual(["manual"]);
    expect(results[0].citation).toContain("人工确认分类");
    expect(await searchConfirmedKnowledge("不存在的参数")).toEqual([]);
  });
});
