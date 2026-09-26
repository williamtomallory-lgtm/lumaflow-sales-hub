// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseSearchResults, searchWeb } from "./web-search";

afterEach(() => vi.unstubAllGlobals());
describe("public web search", () => {
  it("keeps only sourced results and bounds excerpt length", () => {
    expect(parseSearchResults("Title: Primary source\nURL: https://example.com/doc\nPublished: N/A\nHighlights:\nhello\n---\nTitle: invalid\nURL: file:///C:/private\nHighlights:\nsecret")).toEqual([{ title: "Primary source", url: "https://example.com/doc", content: "hello" }]);
  });
  it("reads MCP event responses and reports provider failures", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('event: message\ndata: {"id":1,"result":{"content":[{"type":"text","text":"Title: Source\\nURL: https://example.com\\nHighlights:\\nEvidence"}]}}\n\n', { headers: { "content-type": "text/event-stream" } })).mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await searchWeb("test")).toEqual([{ title: "Source", url: "https://example.com", content: "Evidence" }]);
    expect(fetcher.mock.calls[0][0]).toBe("https://mcp.exa.ai/mcp");
    await expect(searchWeb("test")).rejects.toThrow("暂时不可用");
  });
});
