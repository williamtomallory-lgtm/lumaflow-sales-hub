// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const fixtures = vi.hoisted(() => {
  const page = {
    path: "index.md",
    title: "知识维基索引",
    kind: "index" as const,
    markdown: "# LumaFlow 知识维基",
  };
  return {
    page,
    pages: [page],
    matches: [{ path: page.path, title: page.title, kind: page.kind, excerpt: "LumaFlow 知识维基", score: 100 }],
  };
});

vi.mock("@/lib/knowledge/store", () => ({ listKnowledgeRecords: vi.fn(async () => []) }));
vi.mock("@/lib/knowledge/wiki", () => ({
  compileWiki: vi.fn(() => fixtures.pages),
  readWikiPage: vi.fn(async () => fixtures.page.markdown),
  saveWikiPages: vi.fn(async () => undefined),
  searchWikiPages: vi.fn(() => fixtures.matches),
}));

const { GET } = await import("./route");

afterEach(() => vi.unstubAllEnvs());

describe("knowledge wiki route", () => {
  it("returns query and traceable page matches while preserving selected page data", async () => {
    const response = await GET(new Request("http://127.0.0.1:3000/api/v1/knowledge/wiki?q=轨道灯", {
      headers: { origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" },
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.query).toBe("轨道灯");
    expect(body.data.pages).toEqual([{ path: "index.md", title: "知识维基索引", kind: "index" }]);
    expect(body.data.selected).toEqual(fixtures.page);
    expect(body.data.matches).toEqual(fixtures.matches);
  });
});
