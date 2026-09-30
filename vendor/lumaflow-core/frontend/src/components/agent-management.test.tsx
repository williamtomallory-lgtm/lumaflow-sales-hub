import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./cowagent-weixin-deployment", () => ({
  CowAgentWeixinDeployment: ({ agentId, autoStart }: { agentId: string; autoStart?: boolean }) => <div data-testid={"weixin-" + agentId} data-auto-start={String(Boolean(autoStart))}>绑定私人微信</div>,
}));
vi.mock("./cowagent-wecom-deployment", () => ({
  CowAgentWecomDeployment: ({ agentId }: { agentId: string }) => <div data-testid={"wecom-" + agentId}>绑定企业微信</div>,
}));

import { AgentManagement } from "./agent-management";

const baseAgents = [
  {
    id: "default",
    name: "CowAgent",
    description: "通用本地 Agent",
    enabled: true,
    type: "local" as const,
    workspace: "agents/default",
    knowledgeMode: "shared" as const,
    roleIds: ["sales-consultant" as const],
    permissions: { read: true, create: true, modify: true, delete: true, tools: true },
  },
];

const knowledgePayload = { data: [], summary: {}, meta: {} };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/v1/knowledge")) return Response.json(knowledgePayload);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const created = body.type === "wechat"
        ? { id: body.id, name: body.name, description: body.description, enabled: true, type: "wechat" as const, agentType: body.agentType, workspace: "agents/" + body.id, knowledgeMode: body.knowledgeMode, systemPrompt: body.systemPrompt, knowledgeBaseIds: body.knowledgeBaseIds, roleIds: body.roleIds }
        : { id: body.id, name: body.name, description: body.description, enabled: true, type: "local" as const, workspace: body.workspace || "agents/" + body.id, knowledgeMode: body.knowledgeMode, systemPrompt: body.systemPrompt, knowledgeBaseIds: body.knowledgeBaseIds, permissions: body.permissions, roleIds: body.roleIds };
      return Response.json({ data: { agents: [...baseAgents, created], defaultAgentId: "default", revision: "r2" } }, { status: 201 });
    }
    return Response.json({ data: { agents: baseAgents, defaultAgentId: "default", revision: "r1" } });
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("separate Local Agent and WeChat Agent management", () => {
  it("creates a local Agent with workspace, prompt, knowledge IDs, extra paths, and file permissions", async () => {
    render(<AgentManagement />);
    await screen.findByRole("region", { name: "本地 Agent 列表" });
    fireEvent.click(screen.getByRole("button", { name: "创建本地 Agent" }));
    const dialog = screen.getByRole("dialog", { name: "创建本地 Agent" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "销售资料助手" } });
    fireEvent.change(within(dialog).getByLabelText("Agent ID"), { target: { value: "sales-local" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /销售复盘 Agent/ }));
    fireEvent.change(within(dialog).getByLabelText("System Prompt"), { target: { value: "只处理本机销售资料。" } });
    fireEvent.change(within(dialog).getByLabelText("知识库"), { target: { value: "kb-sales\nkb-products" } });
    fireEvent.change(within(dialog).getByLabelText("工作空间"), { target: { value: "C:\\LumaFlow\\workspace\\sales-local" } });
    fireEvent.change(within(dialog).getByLabelText("额外授权目录"), { target: { value: "C:\\Users\\Willi\\Downloads\nD:\\Sales" } });
    fireEvent.click(within(dialog).getByLabelText("删除文件"));
    fireEvent.click(within(dialog).getByRole("button", { name: "创建本地 Agent" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: /本地 Agent/ })).toHaveAttribute("aria-selected", "true"));
    const post = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      id: "sales-local",
      type: "local",
      systemPrompt: "只处理本机销售资料。",
      knowledgeBaseIds: ["kb-sales", "kb-products"],
      workspace: "C:\\LumaFlow\\workspace\\sales-local",
      allowedPaths: ["C:\\Users\\Willi\\Downloads", "D:\\Sales"],
      permissions: { read: true, create: true, modify: true, delete: false, tools: true },
      roleIds: ["sales-consultant", "sales-review"],
    });
    expect(screen.getByText("本地文件与工具权限")).toBeInTheDocument();
  });

  it("creates a WeChat Agent with a channel subtype and keeps the WeixinClawBot binding entry", async () => {
    render(<AgentManagement />);
    await screen.findByRole("region", { name: "本地 Agent 列表" });
    fireEvent.click(screen.getByRole("tab", { name: /微信 Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "创建微信 Agent" }));
    const dialog = screen.getByRole("dialog", { name: "创建微信 Agent" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "群聊销售助手" } });
    fireEvent.change(within(dialog).getByLabelText("Agent ID"), { target: { value: "group-sales" } });
    fireEvent.change(within(dialog).getByLabelText("System Prompt"), { target: { value: "只在企业微信群中回答。" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: /企业微信/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "创建并绑定微信" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: /微信 Agent/ })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("wecom-group-sales")).toBeInTheDocument();
    expect(screen.getByText("微信 Agent 与微信中的 WeixinClawBot 使用同一份 Agent 配置和数据。")).toBeInTheDocument();
    const post = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      id: "group-sales",
      type: "wechat",
      agentType: "wecom_group",
      systemPrompt: "只在企业微信群中回答。",
    });
    expect(JSON.parse(String(post?.[1]?.body))).not.toHaveProperty("permissions");
  });

  it("deletes a non-default Agent through the shared roster endpoint", async () => {
    const molly = { id: "molly", name: "Molly", description: "销售助手", enabled: true, type: "local" as const, workspace: "agents/molly", knowledgeMode: "own" as const };
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/knowledge")) return Response.json(knowledgePayload);
      if (init?.method === "DELETE") return Response.json({ data: { agents: baseAgents, defaultAgentId: "default", revision: "r3" } });
      return Response.json({ data: { agents: [...baseAgents, molly], defaultAgentId: "default", revision: "r2" } });
    }));

    render(<AgentManagement />);
    fireEvent.click(await screen.findByRole("button", { name: /Molly/ }));
    fireEvent.click(screen.getByRole("button", { name: "删除 Agent" }));

    await waitFor(() => expect(screen.queryByText("Molly")).not.toBeInTheDocument());
    expect(confirm).toHaveBeenCalledOnce();
    const deletion = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(JSON.parse(String(deletion?.[1]?.body))).toEqual({ id: "molly", revision: "r2" });
  });
});
