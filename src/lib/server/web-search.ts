import "server-only";
import { ApiHttpError } from "./api-security";

export type WebSearchResult = { title: string; url: string; content: string };

export function parseSearchResults(text: string): WebSearchResult[] {
  return text.split(/\n---\n/).flatMap((section) => {
    const title = section.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    const url = section.match(/^URL:\s*(https?:\/\/\S+)$/m)?.[1];
    if (!title || !url) return [];
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return [];
    const content = section.split(/\n(?:Highlights|Text|Content):\s*\n/)[1]?.trim() || "";
    return [{ title, url, content: content.slice(0, 3000) }];
  }).slice(0, 5);
}

/** Fixed public search endpoint: queries cannot select a server or local URL. */
export async function searchWeb(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const response = await fetch("https://mcp.exa.ai/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "web_search_exa", arguments: { query, numResults: 5, objective: "Find relevant reliable sources for this query. Prefer primary sources and return source URLs and useful excerpts." },
    } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
    cache: "no-store",
  });
  if (!response.ok) throw new ApiHttpError(502, "SEARCH_UNAVAILABLE", "网上搜索暂时不可用，请稍后重试。");
  const raw = await response.text();
  if (raw.length > 1_000_000) throw new ApiHttpError(502, "SEARCH_RESPONSE_TOO_LARGE", "搜索返回过大，请缩小查询范围。");
  const packets = response.headers.get("content-type")?.includes("text/event-stream")
    ? raw.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))
    : [JSON.parse(raw)];
  const reply = packets.find((packet) => packet.id === 1);
  if (!reply?.result || reply.error || reply.result.isError) throw new ApiHttpError(502, "SEARCH_FAILED", "网上搜索未成功，请稍后重试。");
  const text = (reply.result.content ?? []).filter((item: { type: string }) => item.type === "text").map((item: { text: string }) => item.text).join("\n");
  return parseSearchResults(text);
}
