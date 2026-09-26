// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/cowagent-client", () => ({ getCowAgentRoster: vi.fn(), requestWechatAgent: vi.fn(), uploadCowAgentAvatar: vi.fn(), readCowAgentAvatar: vi.fn() }));
import { getCowAgentRoster, requestWechatAgent, uploadCowAgentAvatar } from "@/lib/server/cowagent-client";
import { wechatAgentStateSchema } from "@/lib/contracts/wechat-conversation";
import { POST } from "./route";

function state(status: "connected" | "disconnected") {
  return wechatAgentStateSchema.parse({
    agent: { id: "avatar-test", name: "我的微信 Agent", systemPrompt: "助手", workspace: "C:/work", knowledgeBaseIds: [], syncEnabled: true, receiveEnabled: true, dndEnabled: false, permissions: { read: "auto", create: "auto", modify: "confirm", tools: "confirm", delete: "confirm", send: "confirm", moments: "confirm" } },
    connection: { status }, conversations: { items: [] }, recentActivity: [],
  });
}
function request() {
  const form = new FormData();
  form.set("avatar", new File(["fixture image"], "avatar.png", { type: "image/png" }));
  return new Request("http://localhost:3000/api/v1/cowagent/agents/avatar-test/avatar", { method: "POST", headers: { origin: "http://localhost:3000" }, body: form });
}
const context = { params: Promise.resolve({ id: "avatar-test" }) };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCowAgentRoster).mockResolvedValue({ agents: [{ id: "avatar-test", name: "Agent", enabled: true, type: "wechat", workspace: "C:/work", knowledgeMode: "shared" }], defaultAgentId: "avatar-test", revision: "1" });
});
describe("WeChat avatar connection requirement", () => {
  it("blocks an upload before connecting", async () => {
    vi.mocked(requestWechatAgent).mockResolvedValue(state("disconnected"));
    expect((await POST(request(), context)).status).toBe(409);
    expect(uploadCowAgentAvatar).not.toHaveBeenCalled();
  });
  it("allows the connected singleton to update its avatar", async () => {
    vi.mocked(requestWechatAgent).mockResolvedValue(state("connected"));
    expect((await POST(request(), context)).status).toBe(200);
    expect(uploadCowAgentAvatar).toHaveBeenCalledOnce();
  });
  it("keeps avatar editing available for a disabled local Agent", async () => {
    vi.mocked(getCowAgentRoster).mockResolvedValue({ agents: [{ id: "avatar-test", name: "Local", enabled: false, type: "local", workspace: "C:/work", knowledgeMode: "shared" }], defaultAgentId: "avatar-test", revision: "1" });
    expect((await POST(request(), context)).status).toBe(200);
    expect(requestWechatAgent).not.toHaveBeenCalled();
  });
});
