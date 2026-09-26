// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CowAgentProfile } from "../contracts/cowagent-agent";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/cowagent-client", () => ({
  getCowAgentProfile: vi.fn(),
  getCowAgentRoster: vi.fn(),
}));
vi.mock("@/lib/ai/agent-team", () => ({ runLocalAgentTeam: vi.fn(async () => "协作建议") }));
vi.mock("@/lib/ai/complete-answer-stream", () => ({ completeAnswerResponse: vi.fn(async (input: { prepare?: (emit: () => void, signal: AbortSignal) => Promise<string> }) => {
  await input.prepare?.(() => {}, new AbortController().signal);
  return new Response("ok");
}) }));
vi.mock("@/lib/ai/knowledge-context", () => ({ buildKnowledgeContext: vi.fn(async () => ({ text: "", coverage: [] })) }));

import { getCowAgentProfile, getCowAgentRoster } from "@/lib/server/cowagent-client";
import { runLocalAgentTeam } from "./agent-team";

const lead: CowAgentProfile = { id: "local-lead", name: "本地执行", enabled: true, type: "local", workspace: "C:/work", knowledgeMode: "own" };
const wechat: CowAgentProfile = { id: "wechat-helper", name: "微信助手", enabled: true, type: "wechat", agentType: "weixin_personal", workspace: "C:/wechat", knowledgeMode: "own" };

function request() {
  return new Request("http://localhost:3000/api/v1/assistant/chat", {
    method: "POST",
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ id: "task", role: "user", parts: [{ type: "text", text: "整理工作计划" }] }],
      experience: "work",
      workflowMode: "plan",
      mode: "light",
      agentId: lead.id,
      collaboratorAgentIds: [wechat.id],
      modelProfileId: "configured",
    }),
  });
}

beforeEach(() => {
  vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:8787/v1");
  vi.stubEnv("LLM_MODEL", "local-test");
  vi.stubEnv("LLM_BACKEND", "openai-compatible");
  vi.stubEnv("LLM_API_KEY", "test-only");
  vi.mocked(getCowAgentProfile).mockResolvedValue(lead);
  vi.mocked(getCowAgentRoster).mockResolvedValue({ agents: [lead, wechat], defaultAgentId: lead.id, revision: "1" });
  vi.mocked(runLocalAgentTeam).mockClear();
});

afterEach(() => vi.unstubAllEnvs());

describe("Work collaboration route", () => {
  it("accepts an enabled WeChat advisor with a local lead", async () => {
    const { POST } = await import("../../app/api/v1/assistant/chat/route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(runLocalAgentTeam).toHaveBeenCalledWith(expect.objectContaining({ collaborators: [wechat], planOnly: true }));
  });

  it("rejects a disabled WeChat advisor before model generation", async () => {
    vi.mocked(getCowAgentRoster).mockResolvedValue({ agents: [lead, { ...wechat, enabled: false }], defaultAgentId: lead.id, revision: "1" });
    const { POST } = await import("../../app/api/v1/assistant/chat/route");
    const response = await POST(request());
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("INVALID_COLLABORATOR");
    expect(runLocalAgentTeam).not.toHaveBeenCalled();
  });
});
