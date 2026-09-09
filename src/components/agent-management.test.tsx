import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./cowagent-weixin-deployment", () => ({
  CowAgentWeixinDeployment: ({ agentId, autoStart }: { agentId: string; autoStart?: boolean }) => <div data-testid={`weixin-${agentId}`} data-auto-start={String(Boolean(autoStart))}>个人微信绑定</div>,
}));
vi.mock("./cowagent-wecom-deployment", () => ({
  CowAgentWecomDeployment: ({ agentId }: { agentId: string }) => <div data-testid={`wecom-${agentId}`}>企业微信绑定</div>,
}));

import { AgentManagement } from "./agent-management";

const baseAgents = [
  { id: "default", name: "CowAgent", description: "通用后端 Agent", enabled: true, workspace: "agents/default", knowledgeMode: "shared" as const },
];

beforeEach(() => {
  const created = { id: "north-wechat", name: "北区客服", description: "负责北区客户私聊", enabled: true, workspace: "agents/north-wechat", knowledgeMode: "shared" as const, botType: "weixin_personal" };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ data: { agents: [...baseAgents, created], defaultAgentId: "default", revision: "r2" } }, { status: 201 });
    return Response.json({ data: { agents: baseAgents, defaultAgentId: "default", revision: "r1" } });
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("unified Agent management", () => {
  it("creates in CowAgent, switches to the same WeChat roster, and starts the new personal QR", async () => {
    render(<AgentManagement />);
    await screen.findByRole("region", { name: "后端 Agent 名单" });
    fireEvent.click(screen.getByRole("button", { name: "创建智能体" }));
    const dialog = screen.getByRole("dialog", { name: "创建智能体" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "北区客服" } });
    fireEvent.change(within(dialog).getByPlaceholderText("wechat-service"), { target: { value: "north-wechat" } });
    fireEvent.change(within(dialog).getByPlaceholderText("说明这个智能体负责什么、不能做什么…"), { target: { value: "负责北区客户私聊" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^\s*创建智能体\s*$/ }));

    await waitFor(() => expect(screen.getByRole("tab", { name: /微信 Agent 列表/ })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getAllByText("北区客服")).toHaveLength(2);
    expect(screen.getByTestId("weixin-north-wechat")).toHaveAttribute("data-auto-start", "true");
    const post = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ id: "north-wechat", name: "北区客服", agentType: "weixin_personal" });
  });
});
