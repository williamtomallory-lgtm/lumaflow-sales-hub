// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSalesKitArchive, csvCell } from "./sales-kit";
import { testProducts } from "@/test/fixtures";
import type { KnowledgeEntry } from "./knowledge/contracts";
afterEach(() => vi.unstubAllGlobals());
const entry = { id: "qa", originalName: "../资料.txt", sizeBytes: 5, source: "uploaded", sizeLabel: "5 B", category: "产品知识" } as KnowledgeEntry;
describe("sales kit real originals", () => {
  it("embeds selected original bytes and edited text, not internal costs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("hello")); vi.stubGlobal("fetch", fetchMock);
    const zip = await buildSalesKitArchive(testProducts[0], "修改后的话术", [entry]);
    expect(await zip.file("附件/1-__资料.txt")?.async("string")).toBe("hello");
    expect(await zip.file("01-客户推荐话术.txt")?.async("string")).toBe("修改后的话术");
    expect(await zip.file("02-产品参数.csv")?.async("string")).not.toContain("内部成本");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/knowledge/qa/download", { cache: "no-store" });
  });
  it("fails the whole export if a selected file is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));
    await expect(buildSalesKitArchive(testProducts[0], "text", [entry])).rejects.toThrow("未生成资料包");
  });
  it("rejects changed file sizes, demo originals and oversized exports", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("different")));
    await expect(buildSalesKitArchive(testProducts[0], "text", [entry])).rejects.toThrow("大小已变更");
    await expect(buildSalesKitArchive(testProducts[0], "text", [{ ...entry, source: "demo" as never }])).rejects.toThrow("真实上传");
    await expect(buildSalesKitArchive(testProducts[0], "text", [{ ...entry, sizeBytes: 101 * 1024 * 1024 }])).rejects.toThrow("100 MB");
  });
  it("escapes delimiters, quotes and spreadsheet formulas", () => {
    expect(csvCell('a,"b')).toBe('"a,""b"');
    expect(csvCell("=1+1")).toBe('"\'=1+1"');
  });
});
