import { describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateText: vi.fn(async ({ system }: { system: string }) => ({ text: system.includes("Reviewer") ? "检查文件内容" : "建议页面结构" })) }));
vi.mock("./knowledge-context", () => ({ buildKnowledgeContext: vi.fn(async () => ({ text: "", coverage: [] })) }));
vi.mock("./agent-roles", () => ({ loadCowAgentRole: (agent: { name: string }) => ({ instructions: agent.name }) }));
vi.mock("./model-config", () => ({ QWEN_PROVIDER_NAME: "local-test" }));

import { generateText } from "ai";
import { runLocalAgentTeam } from "./agent-team";
import type { CowAgentProfile } from "../contracts/cowagent-agent";

const base = { enabled: true, type: "local" as const, workspace: "C:/work", knowledgeMode: "own" as const };

describe("local Agent collaboration", () => {
  it("runs each selected profile and passes their labeled reports to the lead", async () => {
    const collaborators: CowAgentProfile[] = [
      { ...base, id: "reviewer", name: "Reviewer", systemPrompt: "Check changes", roleIds: ["sales-review"] },
      { ...base, id: "designer", name: "Designer", systemPrompt: "Design UI", roleIds: ["sales-consultant"] },
    ];
    const notes = await runLocalAgentTeam({ collaborators, model: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "test", model: "local-test" }, userText: "创建网页", signal: new AbortController().signal });
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(notes).toContain("【Reviewer / reviewer】检查文件内容");
    expect(notes).toContain("【Designer / designer】建议页面结构");
    expect(notes).toContain("未执行电脑操作");
  });
});
