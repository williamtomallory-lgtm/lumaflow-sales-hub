import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WechatAgentCard, WechatAgentWorkspace, type WechatAgentWorkspaceProps } from "./wechat-agent-workspace";
import { wechatAgentStateSchema, type WechatAgentState, type WechatMessagePage } from "@/lib/contracts/wechat-conversation";

const endpoint = "/api/v1/wechat-agent";
const time = "2026-09-26T10:00:00.000Z";
let state: WechatAgentState;
let pages: Record<string, WechatMessagePage>;
const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
let historyHost: HTMLDivElement;
function conversation(id: string, title: string) { return { id, title, createdAt: time, updatedAt: time }; }
function freshState() {
  return wechatAgentStateSchema.parse({
    agent: { id: "wechat-core", name: "我的微信伙伴", avatarUrl: "/avatar/core.png", systemPrompt: "按来源回答", workspace: "C:\\Wechat", knowledgeBaseIds: [], syncEnabled: true, receiveEnabled: true, dndEnabled: false, permissions: { read: "auto", create: "auto", modify: "confirm", tools: "confirm", delete: "confirm", send: "confirm", moments: "confirm" } },
    connection: { status: "connected" }, currentConversationId: "a", conversations: { items: [conversation("a", "采购资料"), conversation("b", "售后记录")], nextCursor: null }, recentActivity: [],
  });
}
beforeEach(() => {
  state = freshState(); requests.length = 0;
  historyHost = document.createElement("div"); document.body.append(historyHost);
  pages = { a: { items: [{ id: "m1", conversationId: "a", role: "user", text: "工作页面输入的原文", createdAt: time, source: "work", status: "completed", deliveryStatus: "none" }, { id: "m2", conversationId: "a", role: "assistant", text: "微信同步的实际回复", createdAt: time, source: "wechat", senderName: "微信ClawBot", status: "completed", deliveryStatus: "sent" }], pendingActions: [] }, b: { items: [{ id: "m3", conversationId: "b", role: "assistant", text: "售后独立上下文", createdAt: time, source: "work", status: "completed" }], pendingActions: [] } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/v1/knowledge")) return Response.json({ data: [{ id: "kb1", title: "产品资料" }] });
    if (url.includes("/avatar")) return Response.json({ data: {} });
    const query = new URL(url, "http://localhost").searchParams;
    if (init?.method === "PATCH") { const body = JSON.parse(String(init.body)); requests.push({ method: "PATCH", body }); state = { ...state, agent: { ...state.agent, ...body } }; return Response.json({ data: state }); }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)); requests.push({ method: "POST", body });
      if (body.action === "createConversation") { state = { ...state, currentConversationId: "new", conversations: { items: [conversation("new", "新工作会话"), ...state.conversations.items] } }; pages.new = { items: [], pendingActions: [] }; }
      if (body.action === "activate") state = { ...state, currentConversationId: body.conversationId };
      if (body.action === "send") pages[body.conversationId].items.push({ id: body.clientMessageId, conversationId: body.conversationId, role: "user", text: body.text, createdAt: time, source: "work", status: "completed" });
      if (body.action === "confirmAction") for (const page of Object.values(pages)) page.pendingActions = page.pendingActions.map((item) => item.id === body.actionId ? { ...item, state: body.approved ? "approved" : "rejected" } : item);
      if (body.action === "connect") state = { ...state, connection: { status: "waiting", qrCodeUrl: "/qr.png" } };
      if (body.action === "disconnect") state = { ...state, connection: { status: "disconnected" } };
      return Response.json({ data: state });
    }
    if (query.get("action") === "messages") return Response.json({ data: pages[query.get("conversationId") || "a"] });
    if (query.get("action") === "conversations") return Response.json({ data: { items: [conversation("c", "更早会话")], nextCursor: null } });
    return Response.json({ data: state });
  }));
});
afterEach(() => { cleanup(); historyHost.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderWorkspace(props: Omit<WechatAgentWorkspaceProps, "historyPortalTarget"> = {}) {
  return render(<WechatAgentWorkspace {...props} historyPortalTarget={historyHost} />);
}

describe("single canonical WeChat Agent", () => {
  it("shows backend connection status and waits for actual connection before claiming sync", async () => {
    state.connection.status = "disconnected";
    const onWork = vi.fn(); render(<WechatAgentCard onWork={onWork} />);
    await screen.findByRole("heading", { name: "WeixinClawBot" });
    expect(screen.getAllByRole("region", { name: "我的微信 Agent" })).toHaveLength(1);
    expect(screen.getByRole("region", { name: "微信连接引导" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始工作" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "配置" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "连接微信" }));
    await screen.findByRole("img", { name: "微信连接二维码" });
    expect(within(screen.getByRole("region", { name: "微信连接引导" })).getByRole("heading", { name: "等待连接" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "配置" })).not.toBeInTheDocument();
    expect(requests[0].body).toEqual({ action: "connect" });
  });

  it("keeps a broken QR visible as an error and offers a retry", async () => {
    state.connection.status = "disconnected";
    render(<WechatAgentCard />);
    fireEvent.click(await screen.findByRole("button", { name: "连接微信" }));
    const qr = await screen.findByRole("img", { name: "微信连接二维码" });
    fireEvent.error(qr);
    expect(await screen.findByRole("alert")).toHaveTextContent("二维码图片加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重试二维码" }));
    const retried = await screen.findByRole("img", { name: "微信连接二维码" });
    expect(retried).toHaveAttribute("src", "/qr.png?lumaflow_retry=1");
  });

  it("uses the fixed local WeixinClawBot identity and does not expose name or avatar editing", async () => {
    render(<WechatAgentCard />);
    await screen.findByRole("heading", { name: "WeixinClawBot" });
    expect(screen.getByRole("img", { name: "WeixinClawBot 头像" })).toHaveAttribute("src", "/wechat-clawbot.svg");
    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    const dialog = screen.getByRole("dialog", { name: "配置微信 Agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加文件" }));
    fireEvent.click(within(dialog).getByRole("menuitem", { name: "选择知识库现有文件" }));
    await within(dialog).findByText("产品资料");
    expect(within(dialog).queryByLabelText("微信 Agent 名称")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("上传微信 Agent 头像")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("在微信中使用相同名称和头像")).not.toBeInTheDocument();
  });

  it("reports invalid server state without inventing a connected Agent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { connection: { status: "connected" } } })));
    render(<WechatAgentCard />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("heading", { name: "WeixinClawBot" })).not.toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  });

  it("saves typed configuration with selected knowledge and required confirmations", async () => {
    const onToast = vi.fn(); render(<WechatAgentCard onToast={onToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "配置" }));
    const dialog = screen.getByRole("dialog", { name: "配置微信 Agent" });
    fireEvent.change(within(dialog).getByLabelText("微信 Agent Prompt"), { target: { value: "核对资料后回答" } });
    fireEvent.change(within(dialog).getByLabelText("微信 Agent 工作间"), { target: { value: "D:\\微信资料" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: /^自动执行/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "添加文件" }));
    fireEvent.click(within(dialog).getByRole("menuitem", { name: "选择知识库现有文件" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: "产品资料" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "免打扰" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const patch = requests.find((item) => item.method === "PATCH")?.body;
    expect(patch).toMatchObject({ systemPrompt: "核对资料后回答", workspace: "D:\\微信资料", knowledgeBaseIds: ["kb1"], dndEnabled: true, permissions: { read: "auto", create: "auto", modify: "auto", tools: "auto", send: "auto", delete: "auto", moments: "auto" } });
    expect(patch).not.toHaveProperty("name");
    expect(patch).not.toHaveProperty("avatarUrl");
    expect(onToast).toHaveBeenCalledWith("Agent设置已保存");
    expect(screen.getByText("WeixinClawBot")).toBeInTheDocument();
  });

  it("cancels configuration on Escape without changing the server", async () => {
    render(<WechatAgentCard />); fireEvent.click(await screen.findByRole("button", { name: "配置" }));
    fireEvent.change(screen.getByLabelText("微信 Agent Prompt"), { target: { value: "未保存" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(requests).toHaveLength(0);
  });

  it("renders conversation selection in the supplied portal and handles root new-chat and mode events", async () => {
    const onExperienceChange = vi.fn();
    renderWorkspace({ onExperienceChange });
    await screen.findByText("微信同步的实际回复");
    expect(within(historyHost).getByRole("button", { name: "采购资料" })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("complementary", { name: "微信工作会话" })).not.toBeInTheDocument();
    fireEvent.click(within(historyHost).getByRole("button", { name: "售后记录" }));
    await screen.findByText("售后独立上下文");
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onExperienceChange).toHaveBeenCalledWith("chat");
    fireEvent.click(within(historyHost).getByRole("button", { name: "新对话" }));
    await screen.findByRole("button", { name: "新工作会话" });
    act(() => window.dispatchEvent(new CustomEvent("lumaflow-wechat-new-conversation")));
    await waitFor(() => expect(requests.filter((item) => item.body.action === "createConversation")).toHaveLength(2));
  });

  it("does not report a successful configuration save after an API failure", async () => {
    const originalFetch = fetch; const onToast = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => init?.method === "PATCH" ? Response.json({ error: { message: "保存服务未连接" } }, { status: 503 }) : originalFetch(url, init)));
    render(<WechatAgentCard onToast={onToast} />); fireEvent.click(await screen.findByRole("button", { name: "配置" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确定" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存服务未连接"); expect(onToast).not.toHaveBeenCalled(); expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("unbinds the channel only after confirmation and keeps conversation records", async () => {
    state.connection.status = "connected"; render(<WechatAgentCard />);
    fireEvent.click(await screen.findByRole("button", { name: "解绑微信" }));
    expect(requests).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "确认解绑" }));
    await waitFor(() => expect(requests[0].body).toEqual({ action: "disconnect" }));
    expect(state.conversations.items).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("uses one feed for actual Work and WeChat messages and creates separate new conversations", async () => {
    renderWorkspace();
    await screen.findByText("微信同步的实际回复");
    const feed = screen.getByLabelText("微信工作与同步消息");
    expect(feed).toHaveTextContent("工作页面输入的原文"); expect(feed).toHaveTextContent("已发送到微信");
    fireEvent.click(screen.getByRole("button", { name: "售后记录" }));
    await screen.findByText("售后独立上下文"); expect(screen.queryByText("工作页面输入的原文")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await screen.findByRole("button", { name: "新工作会话" });
    expect(screen.queryByText("售后独立上下文")).not.toBeInTheDocument();
    expect(state.conversations.items).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("微信 Agent 工作指令"), { target: { value: "只整理本机草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "提交任务" }));
    await screen.findByText("只整理本机草稿");
    expect(requests.at(-1)?.body).toMatchObject({ action: "send", conversationId: "new", text: "只整理本机草稿" });
    expect(requests.at(-1)?.body.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByLabelText("微信 Agent 工作指令")).toHaveValue("");
  });

  it("keeps pending external sends unconfirmed and ignores actions from another conversation", async () => {
    pages.a.pendingActions = [{ id: "p1", conversationId: "a", type: "send", title: "向客户发送回复", detail: "将发送：已收到", state: "pending" }, { id: "p2", conversationId: "b", type: "delete", title: "其他会话删除", state: "pending" }];
    pages.a.items[1].deliveryStatus = "pending";
    pages.a.items[1].status = "awaiting_confirmation";
    renderWorkspace();
    const pending = await screen.findByRole("region", { name: "待确认：向客户发送回复" });
    expect(screen.getByText("待确认发送")).toBeInTheDocument(); expect(screen.queryByText("已发送到微信")).not.toBeInTheDocument();
    expect(screen.queryByText(/其他会话删除/)).not.toBeInTheDocument(); expect(requests).toHaveLength(0);
    fireEvent.click(within(pending).getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(requests[0].body).toEqual({ action: "confirmAction", actionId: "p1", approved: false }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "待确认：向客户发送回复" })).not.toBeInTheDocument());
  });

  it("paginates conversation and message history without duplicating canonical messages", async () => {
    state.conversations.nextCursor = "next"; pages.a.nextCursor = "before-m1";
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("action=messages") && url.includes("cursor=")) return Response.json({ data: { items: [{ ...pages.a.items[0], id: "older", text: "更早的消息", createdAt: "2026-09-25T10:00:00.000Z" }, pages.a.items[0]], nextCursor: null, pendingActions: [] } });
      return originalFetch(url, init);
    }));
    renderWorkspace(); await screen.findByText("微信同步的实际回复");
    fireEvent.click(screen.getByRole("button", { name: "加载更多会话" }));
    await screen.findByRole("button", { name: "更早会话" });
    expect(screen.queryByRole("button", { name: "加载更多会话" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看更早消息" }));
    await screen.findByText("更早的消息");
    expect(screen.getAllByText("工作页面输入的原文")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "查看更早消息" })).not.toBeInTheDocument();
  });

  it("follows a canonical conversation switch from WeChat and clears the previous unsent draft", async () => {
    renderWorkspace(); await screen.findByText("微信同步的实际回复");
    fireEvent.change(screen.getByLabelText("微信 Agent 工作指令"), { target: { value: "旧会话未提交任务" } });
    state.currentConversationId = "b";
    act(() => window.dispatchEvent(new CustomEvent("lumaflow-wechat-agent-updated")));
    await screen.findByText("售后独立上下文");
    expect(screen.getByRole("button", { name: "售后记录" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByLabelText("微信 Agent 工作指令")).toHaveValue("");
    expect(screen.queryByText("微信同步的实际回复")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "采购资料" }));
    await screen.findByText("微信同步的实际回复");
    expect(screen.getByLabelText("微信 Agent 工作指令")).toHaveValue("旧会话未提交任务");
  });

  it("updates actual partial replies from the canonical feed without duplicating the message", async () => {
    vi.useFakeTimers(); pages.a.items[1] = { ...pages.a.items[1], text: "正在整理", status: "running", deliveryStatus: "none" };
    renderWorkspace();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("正在整理")).toBeInTheDocument();
    pages.a.items[1] = { ...pages.a.items[1], text: "正在整理真实返回的资料。", status: "running" };
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(screen.getAllByText("正在整理真实返回的资料。")).toHaveLength(1);
    expect(screen.queryByText("正在整理")).not.toBeInTheDocument();
    pages.a.items[1] = { ...pages.a.items[1], text: "已整理完毕的真实回复。", status: "completed" };
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(screen.getAllByText("已整理完毕的真实回复。")).toHaveLength(1);
    expect(screen.queryByText("正在工作")).not.toBeInTheDocument();
  });

  it("discards an older state poll after a new-conversation mutation", async () => {
    const originalFetch = fetch; let holdState = false; let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { const result = await originalFetch(url, init); if (url === endpoint && !init?.method && holdState) { holdState = false; await gate; } return result; }));
    renderWorkspace(); await screen.findByText("微信同步的实际回复");
    holdState = true; act(() => window.dispatchEvent(new CustomEvent("lumaflow-wechat-agent-updated")));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await screen.findByRole("button", { name: "新工作会话" });
    await act(async () => release());
    expect(screen.getByRole("button", { name: "新工作会话" })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByText("微信同步的实际回复")).not.toBeInTheDocument();
  });

  it("aborts previous message reads when switching conversations", async () => {
    const originalFetch = fetch; let previousSignal: AbortSignal | null = null; let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { const result = await originalFetch(url, init); if (url.includes("action=messages&conversationId=a")) { previousSignal = init?.signal ?? null; await gate; } return result; }));
    renderWorkspace(); await screen.findByRole("button", { name: "售后记录" });
    await waitFor(() => expect(previousSignal).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "售后记录" }));
    await screen.findByText("售后独立上下文");
    expect((previousSignal as AbortSignal | null)?.aborted).toBe(true);
    await act(async () => release()); expect(screen.queryByText("微信同步的实际回复")).not.toBeInTheDocument();
  });
});
