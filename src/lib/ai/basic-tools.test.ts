// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../server/web-search", () => ({ searchWeb: vi.fn(async () => [{ title: "Source", url: "https://example.com", content: "Evidence" }]) }));
vi.mock("../server/cowagent-client", () => ({
  getCowAgentProfile: vi.fn(),
  executeCowAgentComputer: vi.fn(async () => ({ exitCode: 0, saved: true })),
}));
vi.mock("../server/chat-history", () => ({
  listChatSessions: vi.fn(async () => [{ id: "11111111-1111-4111-8111-111111111111", experience: "work", title: "分析", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", turnCount: 1 }]),
  readChatSession: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111", experience: "work", title: "分析", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", turns: [{ id: "22222222-2222-4222-8222-222222222222", user: "读取报告", assistant: "已读取", createdAt: "2026-01-01T00:00:00.000Z", attachments: [] }] })),
}));
vi.mock("../knowledge/store", () => ({ getKnowledgeTextById: vi.fn(async () => "知识正文") }));
vi.mock("./knowledge-retrieval", () => ({ searchConfirmedKnowledge: vi.fn(async () => [{ id: "doc", title: "资料", excerpt: "正文" }]) }));

import { searchWeb } from "../server/web-search";
import { executeCowAgentComputer } from "../server/cowagent-client";
import { basicTools, cowAgentBasicTools } from "./basic-tools";

const read = { read: true, create: false, modify: false, delete: false, tools: false } as const;
const full = { read: true, create: true, modify: true, delete: true, tools: true } as const;
const run = (value: { execute?: unknown }, input: object) => (value.execute as (input: object) => Promise<unknown>)(input);

beforeEach(() => vi.clearAllMocks());
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("CowAgent basic tools", () => {
  it("keeps public search and local history in the Chat-safe tool set", async () => {
    await expect(run(basicTools.webSearch, { query: "LumaFlow" })).resolves.toMatchObject({ source: "Exa web search" });
    await expect(run(basicTools.searchChatHistory, { query: "读取", limit: 10 })).resolves.toMatchObject({ source: "本机对话记录", results: [{ matches: expect.arrayContaining([expect.objectContaining({ excerpt: "读取报告" })]) }] });
    expect(searchWeb).toHaveBeenCalledWith("LumaFlow", undefined);
  });

  it("uses only the explicit place for location lookup and does not infer a city", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ display_name: "Toronto, Ontario, Canada", lat: "43.65", lon: "-79.38", type: "city" }]), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await run(basicTools.resolveLocation, { place: "Toronto", limit: 3 }) as { requestedPlace: string; matches: Array<{ latitude: number }> };
    expect(result.requestedPlace).toBe("Toronto");
    expect(result.matches[0].latitude).toBe(43.65);
    expect(String(fetcher.mock.calls[0][0])).toContain("q=Toronto");
  });

  it("composes explicit-place weather with the provider timezone and never returns a raw IP", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ display_name: "Toronto, Ontario, Canada", lat: "43.65", lon: "-79.38", type: "city" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ timezone: "America/Toronto", current: { time: "2026-09-26T12:00", temperature_2m: 20, weather_code: 1 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await run(basicTools.currentWeather, { place: "Toronto" }) as Record<string, unknown>;
    expect(result.source).toContain("Open-Meteo");
    expect(result).toHaveProperty("time.timeZone", "America/Toronto");
    expect(result).toHaveProperty("location.timezone", "America/Toronto");
    expect(JSON.stringify(result)).not.toContain("203.0.113.10");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed instead of treating a Vercel server IP as the user's location", async () => {
    vi.stubEnv("VERCEL", "1");
    await expect(run(basicTools.currentLocation, {})).rejects.toThrow("不能用服务器 IP");
  });

  it("parses ipwho.is without exposing its raw IP address", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, ip: "203.0.113.10", city: "Toronto", region: "Ontario", country_name: "Canada", latitude: 43.65, longitude: -79.38, timezone: { id: "America/Toronto" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await run(basicTools.currentLocation, {}) as { source: string; location: Record<string, unknown> };
    expect(result.source).toBe("ipwho.is");
    expect(result.location).toMatchObject({ city: "Toronto", timezone: "America/Toronto", approximate: true });
    expect(JSON.stringify(result)).not.toContain("203.0.113.10");
  });

  it("runs file operations and Python only through CowAgent with resolved Work permissions", async () => {
    const tools = cowAgentBasicTools("local", full);
    await run(tools.readLocalFiles, { paths: ["notes.txt"], offsetCharacters: 0, maxCharacters: 4_000 });
    await run(tools.createLocalFile, { path: "report.md", content: "# report" });
    await run(tools.runPythonAnalysis, { script: "print(2 + 2)", timeoutSeconds: 10 });
    expect(executeCowAgentComputer).toHaveBeenCalledWith("local", expect.objectContaining({ action: "read_file", path: "notes.txt" }));
    expect(executeCowAgentComputer).toHaveBeenCalledWith("local", expect.objectContaining({ action: "write_file", path: "report.md" }));
    expect(executeCowAgentComputer).toHaveBeenCalledWith("local", expect.objectContaining({ action: "command", command: expect.stringContaining("lumaflow-python-") }));
  });

  it("rejects Work file writes and Python when the selected Agent is read-only", async () => {
    const tools = cowAgentBasicTools("local", read);
    await expect(run(tools.createLocalFile, { path: "report.md", content: "# report" })).rejects.toThrow("工作间写入");
    await expect(run(tools.runPythonAnalysis, { script: "print(2 + 2)", timeoutSeconds: 10 })).rejects.toThrow("完全访问");
    expect(executeCowAgentComputer).not.toHaveBeenCalled();
  });

  it("builds a Word file and saves it with a CowAgent command", async () => {
    const tools = cowAgentBasicTools("local", full);
    const result = await run(tools.createOfficeFile, { format: "docx", content: "# 报告\n\n正文", path: "report.docx" }) as { source: string; filename: string; bytes: number };
    expect(result.source).toBe("CowAgent");
    expect(result.filename).toMatch(/\.docx$/);
    expect(result.bytes).toBeGreaterThan(0);
    expect(executeCowAgentComputer).toHaveBeenCalledWith("local", expect.objectContaining({ action: "command" }));
  });
});
