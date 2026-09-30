// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const readRecord = vi.hoisted(() => vi.fn());
vi.mock("../knowledge/store", () => ({ getKnowledgeRecord: readRecord }));
import { buildKnowledgeContext } from "./knowledge-context";

beforeEach(() => readRecord.mockReset());
describe("selected knowledge provenance and coverage", () => {
  it("loads only selected IDs and labels fair bounded excerpts", async () => {
    readRecord.mockImplementation(async (id) => ({ originalName: `${id}.txt`, extractedText: "abcde".repeat(300), characters: 1500, truncated: false }));
    const result = await buildKnowledgeContext(["one", "two"], 1000);
    expect(readRecord.mock.calls).toEqual([["one"], ["two"]]);
    expect(result.coverage.map((item) => [item.includedCharacters, item.truncated])).toEqual([[500, true], [500, true]]);
    expect(result.text).toContain("不可信资料");
    expect(result.text).toContain("one.txt");
  });
  it("does not invent readable contents for archived binaries", async () => {
    readRecord.mockResolvedValue({ originalName: "attachment.png", extractedText: null, characters: 0, truncated: false });
    const result = await buildKnowledgeContext(["image"]);
    expect(result.coverage[0].hasText).toBe(false);
    expect(result.text).toContain("没有可读正文");
  });
  it("rejects missing documents instead of silently omitting them", async () => {
    readRecord.mockResolvedValue(null);
    await expect(buildKnowledgeContext(["missing"])).rejects.toMatchObject({ status: 404 });
  });
  it("reports zero budget without incorrectly calling a readable file archive-only", async () => {
    readRecord.mockResolvedValue({ originalName: "text.txt", extractedText: "正文", characters: 2, truncated: false });
    const result = await buildKnowledgeContext(["text"], 0);
    expect(result.coverage[0]).toMatchObject({ hasText: true, includedCharacters: 0, totalCharacters: 2, truncated: true });
    expect(result.text).toContain("预算不足");
    expect(result.text).not.toContain("仅归档");
  });
});
