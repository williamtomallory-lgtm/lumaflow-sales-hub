// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/cowagent-client", () => ({ requestWechatAgent: vi.fn(async () => ({ currentConversationId: "one" })) }));
import { requestWechatAgent } from "@/lib/server/cowagent-client";
import { GET, PATCH, POST } from "./route";
const address = "http://localhost:3000/api/v1/wechat-agent";
function request(method = "GET", body?: unknown, query = "") {
  return new Request(address + query, { method, headers: { origin: "http://localhost:3000", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
beforeEach(() => vi.mocked(requestWechatAgent).mockClear());
describe("canonical WeChat conversations API", () => {
  it("does not let automatic history polling consume the submission limit", async () => {
    const pollingUrl = "http://localhost:3000/api/v1/wechat-agent";
    for (let index = 0; index < 70; index++) {
      const read = new Request(pollingUrl, { headers: { origin: "http://localhost:3000", "x-forwarded-for": "rate-test-client" } });
      expect((await GET(read)).status).toBe(200);
    }
    const submit = new Request(address, { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json", "x-forwarded-for": "rate-test-client" }, body: JSON.stringify({ action: "activate", conversationId: "one" }) });
    expect((await POST(submit)).status).toBe(200);
  });
  it("forwards conversation metadata and rejects identity edits", async () => {
    const body = { action: "updateConversation", conversationId: "one", title: "Renamed", pinned: true, archived: false };
    expect((await POST(request("POST", body))).status).toBe(200);
    expect(requestWechatAgent).toHaveBeenCalledWith({ method: "POST", body });
    vi.mocked(requestWechatAgent).mockClear();
    expect((await PATCH(request("PATCH", { name: "Other name" }))).status).toBe(422);
    expect((await POST(request("POST", { action: "updateConversation", conversationId: "one" }))).status).toBe(422);
    expect(requestWechatAgent).not.toHaveBeenCalled();
  });
  it("reads a selected conversation cursor from the runtime without using local chat storage", async () => {
    expect((await GET(request("GET", undefined, "?action=messages&conversationId=one&cursor=7"))).status).toBe(200);
    expect(requestWechatAgent).toHaveBeenCalledWith({ query: { action: "messages", conversationId: "one", cursor: "7" } });
  });
  it("preserves a stable client message ID for runtime deduplication", async () => {
    const body = { action: "send", conversationId: "one", text: "Task", clientMessageId: "8037e8a7-9129-429b-917b-c9dc1cf14c5c" };
    expect((await POST(request("POST", body))).status).toBe(200);
    expect(requestWechatAgent).toHaveBeenCalledWith({ method: "POST", body });
  });
  it("rejects cross-origin and remote runtime access before forwarding", async () => {
    const remote = new Request("https://example.com/api/v1/wechat-agent", { headers: { origin: "https://example.com" } });
    expect((await GET(remote)).status).toBe(403);
    const crossOrigin = new Request(address, { method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" }, body: JSON.stringify({ action: "connect" }) });
    expect((await POST(crossOrigin)).status).toBe(403);
    expect(requestWechatAgent).not.toHaveBeenCalled();
  });
  it("accepts explicitly selected automatic permissions", async () => {
    for (const key of ["send", "delete", "moments"]) {
      expect((await PATCH(request("PATCH", { permissions: { [key]: "auto" } }))).status).toBe(200);
    }
    expect(requestWechatAgent).toHaveBeenCalledTimes(3);
  });
  it("does not accept client-controlled recipients, channel credentials or Agent creation", async () => {
    for (const body of [{ action: "createAgent", name: "Extra" }, { action: "send", conversationId: "one", text: "Task", clientMessageId: "8037e8a7-9129-429b-917b-c9dc1cf14c5c", receiver: "forged" }, { token: "not-a-real-token" }]) {
      expect((await POST(request("POST", body))).status).toBe(422);
    }
    expect(requestWechatAgent).not.toHaveBeenCalled();
  });
});
