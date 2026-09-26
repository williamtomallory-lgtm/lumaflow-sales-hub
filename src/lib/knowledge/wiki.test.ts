// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredKnowledgeRecord } from "./contracts";

vi.mock("server-only", () => ({}));

const { compileWiki, searchWikiPages } = await import("./wiki");
afterEach(() => vi.unstubAllEnvs());

describe("LLM Wiki source compilation", () => {
  it("keeps a traceable raw-source link and labels unconfirmed model suggestions", () => {
    const record = {
      id: "11111111-1111-4111-8111-111111111111",
      originalName: "产品说明.md",
      title: "轨道灯说明",
      summary: "由模型建议的摘要",
      category: "产品知识",
      classificationStatus: "classified",
      classificationSource: "model",
      parseStatus: "parsed",
      extractedText: "这是来自原件解析正文的轨道灯检索关键词。",
      uploadedAt: "2026-09-23T12:00:00.000Z",
      sha256Prefix: "a".repeat(12),
      downloadUrl: "/api/v1/knowledge/11111111-1111-4111-8111-111111111111/download",
    } as StoredKnowledgeRecord;
    const pages = compileWiki([record]);
    expect(pages.find((page) => page.path === "index.md")?.markdown).toContain("共 1 份来源");
    expect(pages.find((page) => page.kind === "topic")?.markdown).toContain("模型建议待确认");
    expect(pages.find((page) => page.kind === "source")?.markdown).toContain(record.downloadUrl);
    expect(pages.find((page) => page.kind === "source")?.markdown).toContain("原件解析正文的轨道灯检索关键词");
    expect(pages.find((page) => page.path === "log.md")?.markdown).toContain(`source: ${record.id}`);
    expect(pages.find((page) => page.path === "index.md")?.markdown).toContain("不会自动生成跨文档综合结论");
    expect(pages.find((page) => page.path === "lint.md")?.markdown).toContain("失效 Wiki 链接：0 条");
    expect(pages.find((page) => page.path === "lint.md")?.markdown).toContain("孤立页面：0 页");

    const matches = searchWikiPages(pages, "轨道灯");
    const sourceMatch = matches.find((match) => match.kind === "source");
    expect(sourceMatch).toMatchObject({ path: "sources/11111111-1111-4111-8111-111111111111.md", kind: "source" });
    expect(sourceMatch?.excerpt).toContain("轨道灯");
  });

  it("reports same-name files with different digests for human review", () => {
    const base = {
      id: "11111111-1111-4111-8111-111111111111",
      originalName: "重复说明.txt",
      title: "重复说明",
      summary: "正文摘要",
      category: "产品知识",
      classificationStatus: "classified",
      classificationSource: "manual",
      parseStatus: "parsed",
      uploadedAt: "2026-09-23T12:00:00.000Z",
      sha256Prefix: "a".repeat(12),
      sha256: "a".repeat(64),
      downloadUrl: "/api/v1/knowledge/11111111-1111-4111-8111-111111111111/download",
    } as StoredKnowledgeRecord;
    const second = {
      ...base,
      id: "22222222-2222-4222-8222-222222222222",
      uploadedAt: "2026-09-23T13:00:00.000Z",
      sha256Prefix: "b".repeat(12),
      sha256: "b".repeat(64),
      downloadUrl: "/api/v1/knowledge/22222222-2222-4222-8222-222222222222/download",
    } as StoredKnowledgeRecord;
    const lint = compileWiki([base, second]).find((page) => page.path === "lint.md")?.markdown;
    expect(lint).toContain("同名不同原件：1 组");
    expect(lint).toContain("重复说明.txt");
  });

  it("finds hyphenated model numbers in a source excerpt", () => {
    const record = {
      id: "44444444-4444-4444-8444-444444444444",
      originalName: "lamp.txt",
      title: "测试灯具",
      summary: "产品资料",
      category: "产品知识",
      extractedText: "测试灯具 QA-LIGHT-2026 的功率为 12W。",
      uploadedAt: "2026-09-23T12:00:00.000Z",
      sha256Prefix: "d".repeat(12),
      downloadUrl: "/api/v1/knowledge/44444444-4444-4444-8444-444444444444/download",
    } as StoredKnowledgeRecord;
    const matches = searchWikiPages(compileWiki([record]), "QA-LIGHT-2026");
    expect(matches[0]).toMatchObject({ kind: "source", score: 5 });
    expect(matches[0].excerpt).toContain("QA-LIGHT-2026");
  });

  it("keeps the ingest history stable when classification changes later", () => {
    const pending = {
      id: "33333333-3333-4333-8333-333333333333",
      originalName: "分类后确认.txt",
      title: "待分类 · 分类后确认.txt",
      summary: "等待分类",
      category: null,
      tags: ["文本", "待分类"],
      classificationStatus: "pending",
      classificationSource: "none",
      parseStatus: "parsed",
      uploadedAt: "2026-09-23T14:00:00.000Z",
      sha256Prefix: "c".repeat(12),
      sha256: "c".repeat(64),
      downloadUrl: "/api/v1/knowledge/33333333-3333-4333-8333-333333333333/download",
    } as StoredKnowledgeRecord;
    const confirmed = {
      ...pending,
      title: "已确认分类",
      summary: "人工确认后的摘要",
      category: "产品知识",
      tags: ["产品"],
      classificationStatus: "classified",
      classificationSource: "manual",
    } as StoredKnowledgeRecord;
    const before = compileWiki([pending]).find((page) => page.path === "log.md")?.markdown;
    const after = compileWiki([confirmed]).find((page) => page.path === "log.md")?.markdown;
    expect(after).toBe(before);
    expect(before).toContain("sha256: " + "c".repeat(64));
    expect(before).not.toContain("pending");
    expect(before).not.toContain("classified");
  });
});
