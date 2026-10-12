import { afterEach, describe, expect, it, vi } from "vitest";
import { flightClarification, planWorkTeam } from "./work-team-plan";
import type { CowAgentProfile } from "../contracts/cowagent-agent";
const lead: CowAgentProfile = { id: "lead", name: "执行员", enabled: true, type: "local", workspace: "D:/work", knowledgeMode: "own" };
const readonly = { read: true, create: false, modify: false, delete: false, tools: false };
const researcher = { ...lead, id: "research", permissions: readonly };
const reviewer = { ...lead, id: "review", permissions: readonly };
afterEach(() => vi.unstubAllEnvs());
describe("Work team selection", () => {
  it("selects distinct real read-only specialists for a complex task", () => {
    vi.stubEnv("LUMAFLOW_WORK_RESEARCH_AGENT_ID", "research"); vi.stubEnv("LUMAFLOW_WORK_REVIEW_AGENT_ID", "review");
    const plan = planWorkTeam({ text: "统计数据，生成报告并核验", lead, roster: [lead, researcher, reviewer], teamMode: "auto", manual: [] });
    expect(plan.prepare.map((agent) => agent.id)).toEqual(["research"]); expect(plan.review.map((agent) => agent.id)).toEqual(["review"]);
  });
  it("does not invent members, select disabled profiles, or grant write access", () => {
    vi.stubEnv("LUMAFLOW_WORK_RESEARCH_AGENT_ID", "research"); vi.stubEnv("LUMAFLOW_WORK_REVIEW_AGENT_ID", "review");
    const plan = planWorkTeam({ text: "生成报告", lead, roster: [{ ...researcher, enabled: false }, { ...reviewer, permissions: { ...readonly, modify: true } }], teamMode: "auto", manual: [] });
    expect(plan.prepare).toEqual([]); expect(plan.review).toEqual([]);
  });
  it("honors single execution and explicit manual members", () => {
    expect(planWorkTeam({ text: "生成报告", lead, roster: [researcher], teamMode: "single", manual: [researcher] }).prepare).toEqual([]);
    expect(planWorkTeam({ text: "生成报告", lead, roster: [], teamMode: "manual", manual: [researcher], collaborationMode: "debate" }).mode).toBe("debate");
  });
  it("does not auto-assign a specialist outside the selected workspace's read scope", () => {
    vi.stubEnv("LUMAFLOW_WORK_REVIEW_AGENT_ID", "review");
    const plan = planWorkTeam({ text: "生成报告", lead, roster: [{ ...reviewer, workspace: "D:/another", allowedPaths: [] }], teamMode: "auto", manual: [] });
    expect(plan.review).toEqual([]);
  });
});
describe("flight requirements", () => {
  it("asks before searching an undefined route in the supplied screenshot", () => {
    const result = flightClarification("去帮我找找今天去北京最快的机票");
    expect(result?.missing).toEqual(["出发城市或机场", "‘最快’是最早起飞、最短行程还是最早抵达"]);
  });
  it("accepts a specified origin, date and comparison criterion", () => {
    expect(flightClarification("查今天从上海到北京最早抵达的航班")).toBeUndefined();
    expect(flightClarification("查明天上海到北京最早抵达的机票")).toBeUndefined();
    expect(flightClarification("解释机票退改规则")).toBeUndefined();
  });
});
