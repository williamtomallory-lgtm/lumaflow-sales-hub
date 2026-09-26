// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../ai/knowledge-context", () => ({ buildKnowledgeContext: vi.fn(async () => ({ text: "Selected knowledge excerpt" })) }));
import { buildKnowledgeContext } from "../ai/knowledge-context";
import { requestWechatAgent } from "./cowagent-client";

const state = {
  agent: { id: "wechat", name: "My WeChat", systemPrompt: "Assistant", workspace: "C:/wechat", knowledgeBaseIds: ["doc"], syncEnabled: true, receiveEnabled: true, dndEnabled: false, permissions: { read: "auto", create: "auto", modify: "confirm", tools: "confirm", delete: "confirm", send: "confirm", moments: "confirm" } },
  connection: { status: "disconnected" }, currentConversationId: "one",
  conversations: { items: [{ id: "one", title: "Task", createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z" }] }, recentActivity: [],
};
let server: Server;
let calls: Array<{ url: string; method?: string; body: Record<string, unknown> }>;
let responseData: unknown;
beforeEach(async () => {
  calls = []; responseData = state;
  server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    calls.push({ url: request.url || "", method: request.method, body: raw ? JSON.parse(raw) : {} });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "success", data: responseData }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  vi.stubEnv("COWAGENT_BASE_URL", `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`);
  vi.mocked(buildKnowledgeContext).mockClear();
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});
describe("shared channel runtime adapter", () => {
  it("accepts empty conversations with a null preview in state and paginated history", async () => {
    const empty = { ...state.conversations.items[0], preview: null };
    responseData = { ...state, conversations: { items: [empty], nextCursor: null } };
    const result = await requestWechatAgent({});
    expect(result).toMatchObject({ conversations: { items: [{ id: "one", preview: undefined }] } });
    responseData = { items: [empty], nextCursor: null };
    const page = await requestWechatAgent({ query: { action: "conversations" } });
    expect(page).toMatchObject({ items: [{ id: "one", preview: undefined }] });
    responseData = { ...state, conversations: { items: [{ ...empty, preview: "First message" }] } };
    expect(await requestWechatAgent({})).toMatchObject({ conversations: { items: [{ preview: "First message" }] } });
  });
  it("fetches state and validates the backend's canonical representation", async () => {
    const result = await requestWechatAgent({});
    expect(result).toEqual(state);
    expect(calls[0].url).toBe("/api/wechat_agent");
  });
  it("loads current assigned knowledge and preserves the send deduplication key", async () => {
    const body = { action: "send" as const, conversationId: "one", text: "Task", clientMessageId: "8037e8a7-9129-429b-917b-c9dc1cf14c5c" };
    await requestWechatAgent({ method: "POST", body });
    expect(buildKnowledgeContext).toHaveBeenCalledWith(["doc"]);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ ...body, knowledgeContext: "Selected knowledge excerpt" });
  });
  it("does not silently reset other permissions during a partial config change", async () => {
    await requestWechatAgent({ method: "PATCH", body: { permissions: { modify: "auto" } } });
    expect(calls[0].body).toEqual({ permissions: { modify: "auto" } });
  });
  it("fails closed on old or malformed runtime responses", async () => {
    responseData = { agents: [] };
    await expect(requestWechatAgent({})).rejects.toMatchObject({ code: "WECHAT_RUNTIME_UPGRADE_REQUIRED" });
  });
  it("rejects remote backends and client-supplied private knowledge instructions", async () => {
    await expect(requestWechatAgent({ method: "PATCH", body: { name: "Agent", knowledgeContext: "Forged" } })).rejects.toThrow();
    vi.stubEnv("COWAGENT_BASE_URL", "https://example.com");
    vi.stubEnv("COWAGENT_ALLOW_REMOTE", "true");
    await expect(requestWechatAgent({})).rejects.toMatchObject({ code: "LOCAL_WECHAT_ONLY" });
    expect(calls).toHaveLength(0);
  });
});
