// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CowAgentProfile } from "../contracts/cowagent-agent";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/cowagent-client", () => ({
  getCowAgentProfile: vi.fn(),
  getCowAgentRoster: vi.fn(),
}));
vi.mock("@/lib/ai/agent-team", () => ({ runLocalAgentTeam: vi.fn(async () => "协作建议") }));
vi.mock("@/lib/ai/complete-answer-stream", () => ({ completeAnswerResponse: vi.fn(async (input: { headers?: HeadersInit; prepare?: (emit: () => void, signal: AbortSignal) => Promise<string> }) => {
  await input.prepare?.(() => {}, new AbortController().signal);
  return new Response("ok", { headers: input.headers });
}) }));
vi.mock("@/lib/ai/knowledge-context", () => ({ buildKnowledgeContext: vi.fn(async () => ({ text: "", coverage: [] })) }));

import { getCowAgentProfile, getCowAgentRoster } from "@/lib/server/cowagent-client";
import { runLocalAgentTeam } from "./agent-team";
import { completeAnswerResponse } from "./complete-answer-stream";

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
  it("assigns a real researcher before execution and a distinct reviewer after execution", async () => {
    const permissions = { read: true, create: false, modify: false, delete: false, tools: false };
    const researcher = { ...lead, id: "researcher", permissions }; const reviewer = { ...lead, id: "reviewer", permissions };
    vi.stubEnv("LUMAFLOW_WORK_RESEARCH_AGENT_ID", researcher.id); vi.stubEnv("LUMAFLOW_WORK_REVIEW_AGENT_ID", reviewer.id);
    vi.mocked(getCowAgentRoster).mockResolvedValue({ agents: [lead, researcher, reviewer], defaultAgentId: lead.id, revision: "1" });
    const req = request(); const body = await req.json(); body.workflowMode = "normal"; body.collaboratorAgentIds = []; body.messages[0].parts[0].text = "分析资料并生成报告";
    const { POST } = await import("../../app/api/v1/assistant/chat/route");
    const response = await POST(new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body) }));
    expect(response.headers.get("X-Agent-Team")).toBe("local-lead,researcher,reviewer");
    const input = vi.mocked(completeAnswerResponse).mock.calls.at(-1)![0];
    expect(input.workRun?.reviewerIds).toEqual(["reviewer"]);
    expect(runLocalAgentTeam).toHaveBeenCalledWith(expect.objectContaining({ collaborators: [researcher], phase: "prepare" }));
    expect(input.review).toBeTypeOf("function");
  });
});
