import { describe, expect, it, vi } from "vitest";

vi.mock("ai", () => {
  const generateText = vi.fn(async ({ system }: { system: string }) => ({ text: system.includes("Reviewer") ? "检查文件内容" : "建议页面结构" }));
  return { isStepCount: () => () => false, generateText, streamText: vi.fn((options) => ({
    fullStream: (async function* () {
      const result = await generateText(options);
      yield { type: "text-delta", text: result.text };
    })(),
  })) };
});
vi.mock("./computer-tools", () => ({ computerTools: (id: string) => ({ localComputer: { agentId: id } }) }));
vi.mock("./basic-tools", () => ({ cowAgentBasicTools: (id: string) => ({ webSearch: { agentId: id } }) }));
vi.mock("./knowledge-context", () => ({ buildKnowledgeContext: vi.fn(async () => ({ text: "", coverage: [] })) }));
vi.mock("./agent-roles", () => ({ loadCowAgentRole: (agent: { name: string }) => ({ instructions: agent.name }) }));
vi.mock("./model-config", () => ({ QWEN_PROVIDER_NAME: "local-test" }));

import { generateText, streamText } from "ai";
import { runLocalAgentTeam } from "./agent-team";
import type { CowAgentProfile } from "../contracts/cowagent-agent";

const base = { enabled: true, type: "local" as const, workspace: "C:/work", knowledgeMode: "own" as const };

describe("local Agent collaboration", () => {
  it("runs the lead and every member in both rounds with the shared previous transcript", async () => {
    vi.mocked(generateText).mockClear();
    const lead: CowAgentProfile = { ...base, id: "lead", name: "Lead" };
    const collaborators: CowAgentProfile[] = [{ ...base, id: "one", name: "One" }, { ...base, id: "two", name: "Two" }];
    const notes = await runLocalAgentTeam({ lead, collaborators, model: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test", model: "local-test" }, userText: "讨论图书馆的规则", signal: new AbortController().signal });
    expect(generateText).toHaveBeenCalledTimes(6);
    for (const call of vi.mocked(generateText).mock.calls.slice(3)) {
      expect(call[0].prompt).toContain("【Lead / lead】");
      expect(call[0].prompt).toContain("【One / one】");
      expect(call[0].prompt).toContain("【Two / two】");
    }
    expect(notes).toContain("第二轮·相互回应");
    vi.mocked(generateText).mockClear();
  });
  it("runs each selected profile and passes their labeled reports to the lead", async () => {
    const collaborators: CowAgentProfile[] = [
      { ...base, id: "reviewer", name: "Reviewer", systemPrompt: "Check changes", roleIds: ["sales-review"] },
      { ...base, id: "designer", name: "Designer", systemPrompt: "Design UI", roleIds: ["sales-consultant"] },
    ];
    const notes = await runLocalAgentTeam({ collaborators, collaborationMode: "debate", model: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test", model: "local-test" }, userText: "创建网页", signal: new AbortController().signal });
    expect(generateText).toHaveBeenCalledTimes(4);
    expect(vi.mocked(generateText).mock.calls[2][0].prompt).toContain("第一轮讨论记录");
    expect(notes).toContain("【Reviewer / reviewer】检查文件内容");
    expect(notes).toContain("【Designer / designer】建议页面结构");
    expect(notes).toContain("未执行电脑操作");
    const planNotes = await runLocalAgentTeam({ collaborators, model: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test", model: "local-test" }, userText: "规划网页", signal: new AbortController().signal, planOnly: true });
    expect(planNotes).toContain("主 Agent 本轮也只制定计划");
    expect(planNotes).not.toContain("用真实工具回执核验执行结果");
  });

  it("uses a WeChat profile only as an advisory role without channel or computer tools", async () => {
    vi.mocked(generateText).mockClear();
    const collaborator: CowAgentProfile = {
      ...base,
      id: "wechat-helper",
      name: "微信好友助手",
      type: "wechat",
      agentType: "weixin_personal",
    };
    const notes = await runLocalAgentTeam({
      collaborators: [collaborator],
      model: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test", model: "local-test" },
      userText: "整理工作计划",
      collaborationMode: "debate",
      signal: new AbortController().signal,
    });
    const call = vi.mocked(generateText).mock.calls[0][0];
    expect(call.system).toContain("没有连接微信通道");
    expect(call.system).toContain("不能使用工作间、电脑文件或本地工具");
    expect(call).not.toHaveProperty("tools");
    expect(notes).toContain("【微信好友助手 / wechat-helper】");
    expect(notes).toContain("未执行电脑操作或调用微信通道");
  });
  it.each(["parallel", "sequential"] as const)("executes %s with each local member's own tools and hands off only in sequential mode", async (collaborationMode) => {
    vi.mocked(generateText).mockClear();
    const collaborators: CowAgentProfile[] = [{ ...base, id: "reviewer", name: "Reviewer" }, { ...base, id: "designer", name: "Designer" }];
    await runLocalAgentTeam({ collaborators, collaborationMode, model: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test", model: "local-test" }, userText: "制作文件", signal: new AbortController().signal });
    const calls = vi.mocked(generateText).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].tools).toEqual({ localComputer: { agentId: "reviewer" }, webSearch: { agentId: "reviewer" } });
    expect(calls[1][0].tools).toEqual({ localComputer: { agentId: "designer" }, webSearch: { agentId: "designer" } });
    expect(calls[0][0].tools).not.toHaveProperty("windowsDesktop");
    if (collaborationMode === "sequential") expect(calls[1][0].prompt).toContain("【Reviewer / reviewer】检查文件内容");
    else expect(calls[1][0].prompt).not.toContain("【Reviewer / reviewer】检查文件内容");
  });
  it("keeps plan work advisory and gives a requested judge a neutral role", async () => {
    vi.mocked(generateText).mockClear();
    const lead: CowAgentProfile = { ...base, id: "judge", name: "Judge" };
    await runLocalAgentTeam({ lead, collaborators: [{ ...base, id: "side", name: "Side" }], collaborationMode: "debate", model: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test", model: "local-test" }, userText: "辩论，由主Agent当裁判", signal: new AbortController().signal, planOnly: true });
    expect(vi.mocked(generateText).mock.calls[0][0].system).toContain("你是裁判");
    for (const [call] of vi.mocked(generateText).mock.calls) expect(call).not.toHaveProperty("tools");
  });
  it("streams public dialogue and real tool activity without forwarding private reasoning", async () => {
    vi.mocked(streamText).mockImplementationOnce(() => ({ fullStream: (async function* () {
      yield { type: "reasoning-delta", text: "private internal reasoning" };
      yield { type: "text-delta", text: "公开依据：根据用户给定文件。" };
      yield { type: "tool-call", toolCallId: "read", toolName: "localComputer", input: { action: "read_file", path: "C:/work/source.txt" } };
      yield { type: "tool-result", toolCallId: "read", toolName: "localComputer", output: { ok: true } };
      yield { type: "text-delta", text: "结论：文件包含目标内容。" };
    })() }) as unknown as ReturnType<typeof streamText>);
    const progress: import("../contracts/agent-progress").AgentProgress[] = [];
    await runLocalAgentTeam({ collaborators: [{ ...base, id: "reader", name: "Reader" }], collaborationMode: "parallel", model: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test", model: "local-test" }, userText: "读取工作文件", signal: new AbortController().signal, onProgress: (record) => progress.push(record) });
    expect(progress.some((record) => record.state === "running" && record.text?.includes("公开依据"))).toBe(true);
    expect(progress.at(-1)?.text).toContain("结论");
    expect(progress.at(-1)?.actions).toEqual(["开始：读取文件 · C:/work/source.txt", "返回结果：读取文件"]);
    expect(JSON.stringify(progress)).not.toContain("private internal reasoning");
  });
});
