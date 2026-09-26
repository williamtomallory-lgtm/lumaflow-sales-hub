import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./wechat-agent-workspace", () => ({
  WechatAgentCard: ({ onWork }: { onWork?: () => void }) => <section aria-label="我的微信 Agent"><h3>我的微信 Agent</h3><p>微信ClawBot</p><button onClick={onWork}>开始工作</button></section>,
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

const knowledgePayload = { data: [{ id: "kb-sales", title: "销售资料", originalName: "sales.pdf" }], summary: {}, meta: {} };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/v1/knowledge") && init?.method === "POST") return Response.json({ data: { id: "kb-uploaded", title: "新资料", originalName: "new.txt" } }, { status: 201 });
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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("separate Local Agent and WeChat Agent management", () => {
  it.each(["本地"])("closes the %s Agent creation dialog with Escape without saving", async (kind) => {
    render(<AgentManagement />);
    await screen.findByText(/暂无本地 Agent/);
    fireEvent.click(screen.getByRole("button", { name: `创建${kind} Agent` }));
    const dialog = screen.getByRole("dialog", { name: `创建${kind} Agent` });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "未保存的助手" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: `创建${kind} Agent` })).not.toBeInTheDocument();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url, init]) => url === "/api/v1/cowagent/agents" && init?.method === "POST")).toBe(false);
  });

  it("closes only the knowledge menu when clicking another form field and preserves selected files", async () => {
    render(<AgentManagement />);
    await screen.findByText(/暂无本地 Agent/);
    fireEvent.click(screen.getByRole("button", { name: "创建本地 Agent" }));
    const dialog = screen.getByRole("dialog", { name: "创建本地 Agent" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "资料助手" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加文件" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "选择知识库现有文件" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /销售资料/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭知识库文件列表" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "添加文件" }));
    expect(within(dialog).getByRole("button", { name: "网上搜索" })).toBeInTheDocument();
    fireEvent.pointerDown(within(dialog).getByLabelText("名称"));
    expect(within(dialog).queryByRole("button", { name: "网上搜索" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "创建本地 Agent" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("名称")).toHaveValue("资料助手");
    expect(within(dialog).getByText("已选择 1 个文件")).toBeInTheDocument();
  });

  it("prefills the existing local Agent settings and saves changes with PATCH", async () => {
    const dispatch = vi.spyOn(window, "dispatchEvent");
    const molly = {
      id: "molly", name: "Molly", description: "整理销售资料", systemPrompt: "核对来源", enabled: true, type: "local" as const,
      workspace: "C:\\Sales", allowedPaths: ["D:\\资料"], knowledgeMode: "own" as const, knowledgeBaseIds: ["kb-sales"], roleIds: ["sales-consultant"],
      permissions: { read: true, create: true, modify: true, delete: false, tools: false },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/knowledge")) return Response.json(knowledgePayload);
      if (init?.method === "PATCH") return Response.json({ data: { agents: [...baseAgents, { ...molly, ...JSON.parse(String(init.body)) }], defaultAgentId: "default", revision: "r3" } });
      return Response.json({ data: { agents: [...baseAgents, molly], defaultAgentId: "default", revision: "r2" } });
    }));
    render(<AgentManagement onWork={vi.fn()} />);
    await screen.findByRole("button", { name: /Molly/ });
    expect(within(screen.getByRole("group", { name: "本地 Agent 操作" })).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(["开始 Work", "修改 Agent", "删除 Agent"]);
    fireEvent.click(screen.getByRole("button", { name: "修改 Agent" }));
    const dialog = screen.getByRole("dialog", { name: "修改本地 Agent" });
    expect(within(dialog).getByLabelText("名称")).toHaveValue("Molly");
    expect(within(dialog).getByLabelText("Agent ID")).toHaveValue("molly");
    expect(within(dialog).getByLabelText("Agent ID")).toBeDisabled();
    expect(within(dialog).getByLabelText("主要任务")).toHaveValue("整理销售资料");
    expect(within(dialog).getByLabelText("补充设定")).toHaveValue("核对来源");
    expect(within(dialog).getByLabelText("工作间（文件夹）")).toHaveValue("C:\\Sales");
    expect(within(dialog).getByLabelText("额外授权目录")).toHaveValue("D:\\资料");
    expect(within(dialog).getByRole("radio", { name: /帮我批准/ })).toBeChecked();
    expect(within(dialog).getByText("已选择 1 个文件")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "Molly 新任务" } });
    fireEvent.change(within(dialog).getByLabelText("主要任务"), { target: { value: "整理已确认的销售资料" } });
    fireEvent.change(within(dialog).getByLabelText("工作间（文件夹）"), { target: { value: "C:\\Sales\\New" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确定保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const patch = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => url === "/api/v1/cowagent/agents" && init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({
      id: "molly", name: "Molly 新任务", type: "local", description: "整理已确认的销售资料", systemPrompt: "核对来源",
      workspace: "C:\\Sales\\New", allowedPaths: ["D:\\资料"], knowledgeMode: "own", knowledgeBaseIds: ["kb-sales"], revision: "r2",
      permissions: { read: true, create: true, modify: true, delete: false, tools: false },
    });
    expect(screen.getByRole("heading", { name: "Molly 新任务" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Molly 新任务/ })).toBeInTheDocument();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    const update = dispatch.mock.calls.find(([event]) => event.type === "lumaflow-agents-updated")?.[0] as CustomEvent;
    expect(update.detail).toMatchObject({ agentId: "molly", roster: { agents: expect.arrayContaining([expect.objectContaining({ id: "molly", name: "Molly 新任务" })]) } });
  });

  it("edits settings directly in the preview and saves the latest values on confirmation", async () => {
    const dispatch = vi.spyOn(window, "dispatchEvent");
    render(<AgentManagement />);
    await screen.findByText(/暂无本地 Agent/);
    fireEvent.click(screen.getByRole("button", { name: "创建本地 Agent" }));
    const dialog = screen.getByRole("dialog", { name: "创建本地 Agent" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "预览助手" } });
    fireEvent.change(within(dialog).getByLabelText("主要任务"), { target: { value: "整理任务结果" } });
    fireEvent.change(within(dialog).getByLabelText("工作间（文件夹）"), { target: { value: "C:\\Preview" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: /完全访问权限/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "预览" }));
    expect(within(dialog).getByRole("heading", { name: "预览本地 Agent" })).toBeInTheDocument();
    expect(within(dialog).getByText("工作间：C:\\Preview")).toBeInTheDocument();
    expect(within(dialog).getByText("权限：完全访问权限")).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "名称" })).toBeEnabled();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(within(dialog).getByLabelText("主要任务")).toHaveValue("整理任务结果");
    expect(within(dialog).getByRole("radio", { name: /完全访问权限/ })).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "最终助手" } });
    fireEvent.change(within(dialog).getByLabelText("主要任务"), { target: { value: "核对并整理任务结果" } });
    fireEvent.click(within(dialog).getByText("补充设定（可选）"));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "补充设定" }), { target: { value: "标明资料来源" } });
    fireEvent.change(within(dialog).getByLabelText("工作间（文件夹）"), { target: { value: "C:\\Preview\\Updated" } });
    fireEvent.change(within(dialog).getByLabelText("额外授权目录"), { target: { value: "D:\\Source" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: /帮我批准/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "添加文件" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "选择知识库现有文件" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /销售资料/ }));
    expect(within(dialog).getByRole("heading", { name: "最终助手" })).toBeInTheDocument();
    expect(within(dialog).getByText("知识库：1 个文件")).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "预览本地 Agent" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const creation = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => url === "/api/v1/cowagent/agents" && init?.method === "POST");
    const saved = JSON.parse(String(creation?.[1]?.body));
    expect(saved).toMatchObject({ name: "最终助手", description: "核对并整理任务结果", systemPrompt: "标明资料来源", workspace: "C:\\Preview\\Updated", allowedPaths: ["D:\\Source"], knowledgeBaseIds: ["kb-sales"], permissions: { read: true, create: true, modify: true, delete: false, tools: false } });
    const update = dispatch.mock.calls.find(([event]) => event.type === "lumaflow-agents-updated")?.[0] as CustomEvent;
    expect(update.detail).toMatchObject({ agentId: saved.id, roster: { agents: expect.arrayContaining([expect.objectContaining({ id: saved.id, name: "最终助手" })]) } });
  });

  it("shows one independent WeChat card without creation, templates, or role categories", async () => {
    const onWechatWork = vi.fn();
    render(<AgentManagement onWechatWork={onWechatWork} />);
    await screen.findByText(/暂无本地 Agent/);
    fireEvent.click(screen.getByRole("tab", { name: /微信 Agent/ }));
    expect(screen.getAllByRole("region", { name: "我的微信 Agent" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "创建微信 Agent" })).not.toBeInTheDocument();
    expect(screen.queryByText("微信 Agent 快速模板")).not.toBeInTheDocument();
    expect(screen.queryByText("角色")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始工作" }));
    expect(onWechatWork).toHaveBeenCalledOnce();
  });
  it("searches online, saves a selected source with provenance, and assigns it to the Agent", async () => {
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/knowledge/search") return Response.json({ results: [{ title: "轨道灯工作指南", url: "https://example.com/track-light", content: "先核对型号，再整理参数。" }] });
      return originalFetch(url, init);
    }));
    render(<AgentManagement />);
    await screen.findByText(/暂无本地 Agent/);
    fireEvent.click(screen.getByRole("button", { name: "创建本地 Agent" }));
    const dialog = screen.getByRole("dialog", { name: "创建本地 Agent" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "照明资料助手" } });
    fireEvent.change(within(dialog).getByLabelText("主要任务"), { target: { value: "整理轨道灯参数" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加文件" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "网上搜索" }));
    const search = within(dialog).getByRole("region", { name: "网上搜索" });
    expect(within(search).getByLabelText("搜索内容")).toHaveValue("整理轨道灯参数");
    fireEvent.change(within(search).getByLabelText("搜索内容"), { target: { value: "轨道灯型号参数指南" } });
    fireEvent.click(within(search).getByRole("button", { name: "搜索" }));
    expect(await within(search).findByRole("link", { name: "轨道灯工作指南" })).toHaveAttribute("href", "https://example.com/track-light");
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url, init]) => url === "/api/v1/knowledge" && init?.method === "POST")).toBe(false);
    fireEvent.click(within(search).getByRole("button", { name: "保存并选用" }));
    await waitFor(() => expect(within(dialog).getByText("已选择 1 个文件")).toBeInTheDocument());
    const searchRequest = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) => url === "/api/v1/knowledge/search");
    expect(JSON.parse(String(searchRequest?.[1]?.body))).toEqual({ query: "轨道灯型号参数指南" });
    const upload = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => url === "/api/v1/knowledge" && init?.method === "POST");
    const file = (upload?.[1]?.body as FormData).get("file") as File;
    expect(file.name).toBe("轨道灯工作指南.txt");
    const savedText = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(file); });
    expect(savedText).toContain("来源：https://example.com/track-light");
    expect(savedText).toContain("检索时间：");
    expect(savedText).toContain("先核对型号，再整理参数。");
    fireEvent.click(within(dialog).getByRole("button", { name: "创建本地 Agent" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const creation = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => url === "/api/v1/cowagent/agents" && init?.method === "POST");
    expect(JSON.parse(String(creation?.[1]?.body)).knowledgeBaseIds).toEqual(["kb-uploaded"]);
  });

  it("creates a local Agent with a custom main task, workroom, selected knowledge, upload, and bounded permissions", async () => {
    render(<AgentManagement />);
    await screen.findByText(/暂无本地 Agent/);
    fireEvent.click(screen.getByRole("button", { name: "创建本地 Agent" }));
    const dialog = screen.getByRole("dialog", { name: "创建本地 Agent" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "销售资料助手" } });
    fireEvent.change(within(dialog).getByLabelText("Agent ID"), { target: { value: "sales-local" } });
    expect(within(dialog).queryByRole("button", { name: /销售复盘 Agent/ })).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("主要任务"), { target: { value: "整理销售资料并生成可核对的总结。" } });
    fireEvent.change(within(dialog).getByLabelText("补充设定"), { target: { value: "只处理本机销售资料。" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加文件" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "选择知识库现有文件" }));
    expect(within(dialog).queryByRole("button", { name: "上传新文件" })).not.toBeInTheDocument();
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /销售资料/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭知识库文件列表" }));
    expect(within(dialog).queryByLabelText("现有知识库列表")).not.toBeInTheDocument();
    expect(within(dialog).getByText("已选择 1 个文件")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "添加文件" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(within(dialog).queryByRole("button", { name: "上传新文件" })).not.toBeInTheDocument();
    expect(within(dialog).getByText("已选择 1 个文件")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "添加文件" }));
    fireEvent.pointerDown(document.body);
    expect(within(dialog).queryByRole("button", { name: "上传新文件" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "添加文件" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "上传新文件" }));
    fireEvent.change(within(dialog).getByLabelText("知识库文件上传"), { target: { files: [new File(["hello"], "new.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(within(dialog).getByText("已选择 2 个文件")).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText("工作间（文件夹）"), { target: { value: "C:\\LumaFlow\\workspace\\sales-local" } });
    fireEvent.change(within(dialog).getByLabelText("额外授权目录"), { target: { value: "C:\\Users\\Willi\\Downloads\nD:\\Sales" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: /帮我批准/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "创建本地 Agent" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: /本地 Agent/ })).toHaveAttribute("aria-selected", "true"));
    const post = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => url === "/api/v1/cowagent/agents" && init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      id: "sales-local",
      type: "local",
      description: "整理销售资料并生成可核对的总结。",
      systemPrompt: "只处理本机销售资料。",
      knowledgeBaseIds: ["kb-sales", "kb-uploaded"],
      workspace: "C:\\LumaFlow\\workspace\\sales-local",
      allowedPaths: ["C:\\Users\\Willi\\Downloads", "D:\\Sales"],
      permissions: { read: true, create: true, modify: true, delete: false, tools: false },
      roleIds: ["sales-consultant"],
    });
    expect(screen.getByText("帮我批准")).toBeInTheDocument();
  });

  it("excludes WeChat Agent profiles from local creation cloning", async () => {
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/cowagent/agents" && !init?.method) return Response.json({ data: { agents: [...baseAgents, { id: "wechat-core", name: "我的微信 Agent", type: "wechat", enabled: true, workspace: "wechat", knowledgeMode: "shared" }, { id: "molly", name: "Molly", type: "local", enabled: true, workspace: "molly", knowledgeMode: "shared" }], defaultAgentId: "default", revision: "r1" } });
      return originalFetch(url, init);
    }));
    render(<AgentManagement />);
    await screen.findByRole("button", { name: /Molly/ });
    fireEvent.click(screen.getByRole("button", { name: "创建本地 Agent" }));
    const clone = within(screen.getByRole("dialog")).getByRole("combobox", { name: /从已有 Agent 复制/ });
    expect(within(clone).getByRole("option", { name: "Molly" })).toBeInTheDocument();
    expect(within(clone).queryByRole("option", { name: "我的微信 Agent" })).not.toBeInTheDocument();
  });
  it("saves typed knowledge as a text file and selects it for the new Agent", async () => {
    render(<AgentManagement />);
    await screen.findByText(/暂无本地 Agent/);
    fireEvent.click(screen.getByRole("button", { name: "创建本地 Agent" }));
    const dialog = screen.getByRole("dialog", { name: "创建本地 Agent" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "资料助手" } });
    fireEvent.change(within(dialog).getByLabelText("主要任务"), { target: { value: "整理资料" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加文件" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "输入文字" }));
    expect(within(dialog).queryByRole("button", { name: "上传新文件" })).not.toBeInTheDocument();
    fireEvent.click(within(within(dialog).getByRole("region", { name: "文字知识输入" })).getByRole("button", { name: "取消" }));
    expect(within(dialog).queryByRole("region", { name: "文字知识输入" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "添加文件" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "输入文字" }));
    fireEvent.change(within(dialog).getByLabelText("知识文字标题"), { target: { value: "操作说明" } });
    fireEvent.change(within(dialog).getByLabelText("知识文字正文"), { target: { value: "先核对来源，再整理结果。" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存并选用" }));
    await waitFor(() => expect(within(dialog).getByText("已选择 1 个文件")).toBeInTheDocument());
    const upload = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => url === "/api/v1/knowledge" && init?.method === "POST");
    expect(((upload?.[1]?.body as FormData).get("file") as File).name).toBe("操作说明.txt");
    fireEvent.click(within(dialog).getByRole("button", { name: "创建本地 Agent" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const created = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => url === "/api/v1/cowagent/agents" && init?.method === "POST");
    expect(JSON.parse(String(created?.[1]?.body)).knowledgeBaseIds).toEqual(["kb-uploaded"]);
    expect(JSON.parse(String(created?.[1]?.body)).workspace).toBeUndefined();
    expect(JSON.parse(String(created?.[1]?.body)).permissions).toEqual({ read: true, create: false, modify: false, delete: false, tools: false });
  });

  it("maps full access to the backend's exact five permission grants", async () => {
    render(<AgentManagement />);
    await screen.findByText(/暂无本地 Agent/);
    fireEvent.click(screen.getByRole("button", { name: "创建本地 Agent" }));
    const dialog = screen.getByRole("dialog", { name: "创建本地 Agent" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "工具助手" } });
    fireEvent.change(within(dialog).getByLabelText("主要任务"), { target: { value: "执行明确交代的本地工作" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: /完全访问权限/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "创建本地 Agent" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const created = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => url === "/api/v1/cowagent/agents" && init?.method === "POST");
    expect(JSON.parse(String(created?.[1]?.body)).permissions).toEqual({ read: true, create: true, modify: true, delete: true, tools: true });
  });

  it("deletes a non-default Agent through the shared roster endpoint", async () => {
    const molly = { id: "molly", name: "Molly", description: "销售助手", enabled: true, type: "local" as const, workspace: "agents/molly", knowledgeMode: "own" as const, permissions: { read: true, create: false, modify: true, delete: false, tools: false } };
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/knowledge")) return Response.json(knowledgePayload);
      if (init?.method === "DELETE") return Response.json({ data: { agents: baseAgents, defaultAgentId: "default", revision: "r3" } });
      return Response.json({ data: { agents: [...baseAgents, molly], defaultAgentId: "default", revision: "r2" } });
    }));

    render(<AgentManagement />);
    const mollyButton = await screen.findByRole("button", { name: /Molly/ });
    expect(screen.queryByText("CowAgent")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /本地 Agent/ })).toHaveTextContent("1");
    fireEvent.click(mollyButton);
    expect(screen.getByText("✓ 修改文件")).toBeInTheDocument();
    expect(screen.getByText("× 创建文件")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除 Agent" }));

    await waitFor(() => expect(screen.queryByText("Molly")).not.toBeInTheDocument());
    expect(confirm).toHaveBeenCalledOnce();
    const deletion = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(JSON.parse(String(deletion?.[1]?.body))).toEqual({ id: "molly", revision: "r2" });
  });

  it("shows a user Agent even if it becomes the default, while keeping the built-in hidden", async () => {
    const molly = { id: "molly", name: "Molly", enabled: true, type: "local" as const, workspace: "agents/molly", knowledgeMode: "own" as const };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { agents: [...baseAgents, molly], defaultAgentId: "molly", revision: "r4" } })));
    render(<AgentManagement />);
    await screen.findByRole("button", { name: /Molly/ });
    expect(screen.queryByText("CowAgent")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除 Agent" }));
    expect(screen.getByRole("alert")).toHaveTextContent("当前被设为默认的 Agent 无法删除");
  });
});
