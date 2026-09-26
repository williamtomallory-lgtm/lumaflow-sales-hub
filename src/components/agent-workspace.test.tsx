import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWorkspace } from "./agent-workspace";
import { chatSessionSchema } from "@/lib/contracts/chat-history";
import type { AgentProgress } from "@/lib/contracts/agent-progress";
import { testAssets, testCustomers, testProducts } from "../test/fixtures";

const posts: Record<string, unknown>[] = [];
const historyPosts: Record<string, unknown>[] = [];
const documentId = "11111111-1111-4111-8111-111111111111";
let includeInternalAgent = false;
let replyActivity: AgentProgress[] = [];
let replyText = "模型生成的客服草稿";

function utf8File(name: string, value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = bytes.slice().buffer as ArrayBuffer;
  const file = new File([buffer], name, { type: "text/plain" });
  // jsdom's File omits arrayBuffer(); the browser API used by the component
  // is supplied here so the test still exercises strict byte decoding.
  Object.defineProperty(file, "arrayBuffer", { value: async () => buffer.slice(0) });
  return file;
}

function modelReply(text = "模型生成的客服草稿") {
  const events = [
    { type: "start", messageId: "reply" },
    ...replyActivity.map((data) => ({ type: "data-agent-progress", id: `${data.agentId}:${data.round}`, data })),
    { type: "start-step" },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: text },
    { type: "text-end", id: "text" },
    { type: "finish-step" },
    { type: "finish", finishReason: "stop" },
  ];
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: {
      "content-type": "text/event-stream",
      "x-vercel-ai-ui-message-stream": "v1",
      "X-Knowledge-Coverage": encodeURIComponent(JSON.stringify([{ id: documentId, name: "已分类知识.md", includedCharacters: 120, totalCharacters: 120, truncated: false, hasText: true }])),
    },
  });
}

const props = {
  customers: testCustomers,
  products: testProducts,
  assets: testAssets,
  initialMessage: "客户问轨道灯库存",
  initialExperience: "work" as const,
  onOpenCustomer: vi.fn(),
  onOpenProduct: vi.fn(),
  onToast: vi.fn(),
};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  posts.length = 0;
  historyPosts.length = 0;
  includeInternalAgent = false;
  replyActivity = [];
  replyText = "模型生成的客服草稿";
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/assistant/history")) {
      if (init?.method === "POST") { const session = JSON.parse(String(init.body)) as Record<string, unknown>; historyPosts.push(session); return Response.json({ data: session }); }
      const requestedId = new URL(url, "http://127.0.0.1").searchParams.get("id");
      const latest = [...new Map(historyPosts.map((item) => [item.id, item])).values()];
      return Response.json({ data: requestedId ? latest.find((item) => item.id === requestedId) ?? null : latest.map((item) => ({ ...item, turnCount: Array.isArray(item.turns) ? item.turns.length : 0 })) });
    }
    if (url.endsWith("/parse-document")) return Response.json({ text: "已解析的 PDF 正文", characters: 12, truncated: false });
    if (url.endsWith("/chat")) {
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return modelReply(replyText);
    }
    if (url.endsWith("/cowagent/agents")) return Response.json({ data: { defaultAgentId: includeInternalAgent ? "default" : "sales-consultant", revision: "test-roster", agents: [
      ...(includeInternalAgent ? [{ id: "default", name: "CowAgent", description: "内置默认项", enabled: true, type: "local", workspace: "internal", knowledgeMode: "shared" }] : []),
      { id: "sales-consultant", name: "产品销售顾问", description: "查产品和库存", enabled: true, type: "local", workspace: "agents/sales-consultant", knowledgeMode: "shared", knowledgeBaseIds: [documentId, "33333333-3333-4333-8333-333333333333"] },
      { id: "wechat-service", name: "微信客服 Agent", description: "整理微信私聊", enabled: true, type: "wechat", workspace: "agents/wechat-service", knowledgeMode: "shared", agentType: "weixin_personal", avatar: "image", avatarRev: "wechat-v1" },
      { id: "sales-review", name: "销售复盘 Agent", description: "复盘销售记录", enabled: true, type: "local", workspace: "agents/sales-review", knowledgeMode: "own", avatar: "image", avatarRev: "local-v1" },
      { id: "moments-operator", name: "朋友圈运营 Agent", description: "生成待审核内容", enabled: true, type: "local", workspace: "agents/moments-operator", knowledgeMode: "shared" },
    ] } });
    if (url.endsWith("/knowledge")) return Response.json({ data: [{
      id: documentId,
      originalName: "已分类知识.md",
      title: "已分类知识.md",
      category: "产品知识",
      summary: "轨道灯常见参数",
      classificationStatus: "classified",
      hasText: true,
      parseStatus: "parsed",
      extension: "md",
      updatedAt: "2026-09-07T12:00:00.000Z",
    }, {
      id: "22222222-2222-4222-8222-222222222222",
      originalName: "仅归档图片.pdf",
      title: "仅归档图片.pdf",
      classificationStatus: "archived",
      hasText: false,
      parseStatus: "archive_only",
      extension: "pdf",
    }, {
      id: "33333333-3333-4333-8333-333333333333",
      originalName: "已解析表格.xlsx",
      title: "已解析表格.xlsx",
      category: "产品知识",
      summary: "已由知识库提取正文",
      classificationStatus: "classified",
      hasText: true,
      parseStatus: "parsed",
      extension: "xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeLabel: "2.4 MB",
    }] });
    const profileId = url.includes("modelProfileId=configured") ? "configured" : "local-qwen3-8b";
    const meta = { apiVersion: "v1", requestId: "test", checkedAt: new Date().toISOString() };
    if (url.endsWith("/models")) return Response.json({ data: { defaultProfileId: "local-qwen3-8b", models: [
      { id: "local-qwen3-8b", label: "本地 Qwen3 8B", model: "local-test", description: "本地模型", configured: true, reachable: true, connectionKind: "live", contextTokens: 8192 },
      { id: "configured", label: "自定义模型", model: "offline", description: "尚未接通", configured: false, reachable: false, connectionKind: "live", contextTokens: null },
    ] }, meta });
    return Response.json({ data: { configured: profileId !== "configured", reachable: profileId !== "configured", profileId, provider: "vllm-openai-compatible", model: profileId === "configured" ? "offline" : "local-test", connectionKind: "live", contextTokens: 8192, latencyMs: 1 }, meta });
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function ready() {
  await waitFor(() => expect(screen.getByRole("button", { name: "发送问题" })).toBeEnabled());
}
async function idle() {
  await waitFor(() => expect(screen.getByRole("button", { name: "新问题" })).toBeEnabled());
}

describe("Agent workspace", () => {
  it("shows the Work summary only for an active or saved Work conversation", async () => {
    render(<AgentWorkspace {...props} />);
    expect(screen.queryByRole("complementary", { name: "Work 工作概况" })).not.toBeInTheDocument();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await screen.findByTestId("agent-answer");
    expect(screen.getByRole("complementary", { name: "Work 工作概况" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新问题" }));
    expect(screen.queryByRole("complementary", { name: "Work 工作概况" })).not.toBeInTheDocument();
  });

  it("accepts a Work message while busy, queues it, and starts it after the current turn", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    const originalFetch = fetch;
    let releaseFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    let chatCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/chat")) {
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        chatCalls += 1;
        return chatCalls === 1 ? firstResponse : modelReply("第二条已自动执行");
      }
      return originalFetch(url, init);
    }));

    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(screen.queryByRole("region", { name: "排队消息" })).not.toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "客户问题或销售任务" });
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: "第二条排队任务" } });
    fireEvent.click(screen.getByRole("button", { name: "加入排队" }));
    expect(screen.getByRole("region", { name: "排队消息" })).toHaveTextContent("第二条排队任务");
    expect(posts).toHaveLength(1);

    await act(async () => { releaseFirst(modelReply("第一条完成")); });
    await waitFor(() => expect(posts.length).toBeGreaterThanOrEqual(2));
    expect(JSON.stringify(posts[1])).toContain("客户问轨道灯库存");
    expect(JSON.stringify(posts[1])).toContain("新增要求追加到原任务");
    expect(JSON.stringify(posts[1])).toContain("第一条完成");
    await waitFor(() => expect(screen.getByTestId("agent-answer")).toHaveTextContent("第二条已自动执行"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "排队消息" })).not.toBeInTheDocument());
    await waitFor(() => expect(historyPosts.at(-1)).toMatchObject({ turns: [
      { user: "客户问轨道灯库存", assistant: "第一条完成" },
      { user: "第二条排队任务", assistant: "第二条已自动执行" },
    ] }));
  });

  it("can guide an addition before the current response headers arrive", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    const originalFetch = fetch;
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/chat")) return originalFetch(url, init);
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      calls += 1;
      if (calls > 1) return modelReply("已继续原始任务");
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
      });
    }));
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.change(screen.getByRole("textbox", { name: "客户问题或销售任务" }), { target: { value: "一定给出最终结果" } });
    fireEvent.click(screen.getByRole("button", { name: "加入排队" }));
    fireEvent.click(screen.getByRole("button", { name: "引导排队消息 1" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(JSON.stringify(posts[1])).toContain("客户问轨道灯库存");
    expect(JSON.stringify(posts[1])).toContain("一定给出最终结果");
    await screen.findByText("已继续原始任务");
  });

  it("allows queued drafts to be edited, opened in the side panel, and deleted", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    const originalFetch = fetch;
    let releaseFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/chat")) {
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return posts.length === 1 ? firstResponse : modelReply("完成");
      }
      return originalFetch(url, init);
    }));
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    const input = screen.getByRole("textbox", { name: "客户问题或销售任务" });
    fireEvent.change(input, { target: { value: "待编辑的排队任务" } });
    fireEvent.click(screen.getByRole("button", { name: "加入排队" }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作 排队消息 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑排队消息" }));
    fireEvent.change(screen.getByRole("textbox", { name: "编辑排队消息 1" }), { target: { value: "已编辑的排队任务" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("region", { name: "排队消息" })).toHaveTextContent("已编辑的排队任务");
    fireEvent.click(screen.getByRole("button", { name: "更多操作 排队消息 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "在侧边聊天中打开" }));
    expect(screen.getByRole("complementary", { name: "侧边聊天" })).toHaveTextContent("已编辑的排队任务");
    fireEvent.click(screen.getByRole("button", { name: "关闭侧边聊天" }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作 排队消息 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭排队" }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作 排队消息 1" }));
    expect(screen.getByRole("menuitem", { name: "开启排队" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "开启排队" }));
    fireEvent.click(screen.getByRole("button", { name: "删除排队消息 1" }));
    expect(screen.queryByRole("region", { name: "排队消息" })).not.toBeInTheDocument();
    await act(async () => { releaseFirst(modelReply("完成")); });
  });

  it("guides the selected queued task first and keeps the interrupted turn as context", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    const originalFetch = fetch;
    const encoder = new TextEncoder();
    const firstResponse = new Response(new ReadableStream({
      start(controller) {
        for (const event of [
          { type: "start", messageId: "partial-reply" },
          { type: "start-step" },
          { type: "text-start", id: "partial" },
          { type: "text-delta", id: "partial", delta: "已保留的中途结果" },
        ]) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      },
    }), { headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
    let chatCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/chat")) {
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        chatCalls += 1;
        return chatCalls === 1 ? firstResponse : modelReply(`自动回答 ${chatCalls}`);
      }
      return originalFetch(url, init);
    }));
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await screen.findByText("已保留的中途结果");
    const input = screen.getByRole("textbox", { name: "客户问题或销售任务" });
    fireEvent.change(input, { target: { value: "先处理的普通任务" } });
    fireEvent.click(screen.getByRole("button", { name: "加入排队" }));
    fireEvent.change(input, { target: { value: "需要优先引导的任务" } });
    fireEvent.click(screen.getByRole("button", { name: "加入排队" }));
    fireEvent.click(screen.getByRole("button", { name: "引导排队消息 2" }));
    const queue = screen.getByRole("region", { name: "排队消息" });
    expect(within(queue).getAllByRole("listitem")[0]).toHaveTextContent("需要优先引导的任务");
    await waitFor(() => expect(posts.length).toBeGreaterThanOrEqual(2));
    expect(JSON.stringify(posts[1])).toContain("需要优先引导的任务");
    expect(JSON.stringify(posts[1])).toContain("客户问轨道灯库存");
    expect(JSON.stringify(posts[1])).toContain("已保留的中途结果");
    await waitFor(() => expect(posts.length).toBeGreaterThanOrEqual(3));
    expect(JSON.stringify(posts[2])).toContain("先处理的普通任务");
    await waitFor(() => expect(historyPosts.length).toBeGreaterThanOrEqual(3));
    expect(JSON.stringify(historyPosts[0])).toContain("已保留的中途结果");
  });

  it("saves real completed member replies when the final answer is empty and restores them from history", async () => {
    replyText = "";
    replyActivity = [
      { agentId: "sales-review", name: "销售复盘 Agent", round: 1, state: "completed", text: "已经核对了库存差异。" },
      { agentId: "sales-review", name: "销售复盘 Agent", round: 2, state: "running" },
    ];
    render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(historyPosts).toHaveLength(1));
    const saved = chatSessionSchema.parse(historyPosts[0]);
    expect(saved.turns[0].assistant).toContain("已经核对了库存差异。");
    expect(saved.turns[0].assistant).toContain("未完成最终回复");
    expect(saved.turns[0].agentActivity?.[1].state).toBe("cancelled");
    expect(screen.getByTestId("agent-output")).toHaveTextContent("已经核对了库存差异。");
    historyPosts[0] = { ...saved, turns: saved.turns.map((turn) => ({ ...turn, assistant: "" })) };
    fireEvent.click(screen.getByRole("button", { name: "新问题" }));
    fireEvent.click(screen.getByRole("button", { name: "对话记录" }));
    fireEvent.click(await within(screen.getByRole("complementary", { name: "本机对话记录" })).findByRole("button", { name: /客户问轨道灯库存.*1 轮/ }));
    await waitFor(() => expect(screen.getByTestId("agent-output")).toHaveTextContent("未完成最终回复"));
    expect(screen.getByTestId("agent-output")).toHaveTextContent("已经核对了库存差异。");
  });

  it("infers collaboration mode until explicitly selected and restores each version mode", async () => {
    render(<AgentWorkspace {...props} initialMessage="请大家讨论并辩论库存方案" />);
    await ready();
    const mode = screen.getByRole("combobox", { name: "协作方式" });
    expect(mode).toHaveValue("debate");
    fireEvent.click(screen.getByRole("button", { name: "@ 添加协作 Agent" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "选择协作 Agent" })).getByRole("option", { name: /销售复盘 Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(historyPosts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty("collaborationMode");
    expect(chatSessionSchema.parse(historyPosts[0]).turns[0].collaborationMode).toBe("debate");
    expect(screen.getByTestId("user-prompt")).toHaveTextContent("讨论辩论");
    expect(screen.queryByLabelText("参与协作的 Agent")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "修改提问" }));
    expect(mode).toHaveValue("debate");
    expect(screen.getByLabelText("参与协作的 Agent")).toHaveTextContent("销售复盘 Agent");
    fireEvent.change(mode, { target: { value: "sequential" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并重新生成" }));
    await waitFor(() => expect(historyPosts).toHaveLength(2));
    expect(posts[1]).toHaveProperty("collaborationMode", "sequential");
    expect(chatSessionSchema.parse(historyPosts[1]).turns[0].versions?.map((version) => version.collaborationMode)).toEqual(["debate", "sequential"]);
    expect(screen.getByTestId("user-prompt")).toHaveTextContent("分步工作");
    fireEvent.click(screen.getByRole("button", { name: "上一个分支" }));
    expect(mode).toHaveValue("debate");
    expect(screen.queryByLabelText("参与协作的 Agent")).not.toBeInTheDocument();
    fireEvent.change(mode, { target: { value: "parallel" } });
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(historyPosts).toHaveLength(3));
    expect(posts[2]).toHaveProperty("collaborationMode", "debate");
    fireEvent.click(screen.getByRole("button", { name: "修改提问" }));
    fireEvent.change(mode, { target: { value: "parallel" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并重新生成" }));
    await waitFor(() => expect(historyPosts).toHaveLength(4));
    expect(posts[3]).toHaveProperty("collaborationMode", "parallel");
    expect(screen.getByTestId("user-prompt")).toHaveTextContent("同时工作");
  });

  it("renders and saves actual independent Agent progress with the answer", async () => {
    replyActivity = [
      { agentId: "lead", name: "主助手", round: 3, state: "completed", text: "本轮回复已完成" },
      { agentId: "researcher", name: "资料助手", round: 1, state: "completed", text: "成员的真实第一轮内容" },
      { agentId: "researcher", name: "资料助手", round: 2, state: "completed", text: "成员回应了主助手" },
    ];
    render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await idle();
    const progress = screen.getByRole("region", { name: "协作 Agent 进度" });
    expect(within(progress).getByRole("status")).toHaveTextContent("0 运行中 · 2 完成");
    fireEvent.click(within(progress).getByRole("button", { name: "协作 Agent" }));
    expect(within(progress).getByText("成员的真实第一轮内容")).toBeInTheDocument();
    await waitFor(() => expect(historyPosts.length).toBeGreaterThan(0));
    const saved = chatSessionSchema.parse(historyPosts.at(-1));
    expect(saved.turns[0].agentActivity).toEqual(replyActivity);
  });
  it("hides the internal default Agent from Work choices", async () => {
    includeInternalAgent = true;
    render(<AgentWorkspace {...props} initialExperience="work" />);
    await ready();
    const selector = screen.getByRole("combobox", { name: "选择本地 Agent" });
    expect(selector).toHaveTextContent("产品销售顾问");
    fireEvent.click(selector);
    expect(within(screen.getByRole("listbox", { name: "选择本地 Agent" })).queryByRole("option", { name: /CowAgent/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole("listbox", { name: "选择本地 Agent" })).getByRole("option", { name: /产品销售顾问/ })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("heading", { name: "Chat-AI" }));
    expect(screen.queryByRole("listbox", { name: "选择本地 Agent" })).not.toBeInTheDocument();
  });

  it("saves completed Chat turns and shows them in the local history list", async () => {
    render(<AgentWorkspace {...props} initialExperience="chat" />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(historyPosts).toHaveLength(1));
    expect(historyPosts[0]).toMatchObject({ experience: "chat", title: "客户问轨道灯库存", turns: [{ user: "客户问轨道灯库存", assistant: "模型生成的客服草稿" }] });
    fireEvent.click(screen.getByRole("button", { name: "对话记录" }));
    expect(screen.getByRole("complementary", { name: "本机对话记录" })).toHaveTextContent("客户问轨道灯库存");
  });

  it("edits a sent prompt, saves both versions, and switches branches without a model call", async () => {
    render(<AgentWorkspace {...props} initialExperience="chat" />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(historyPosts).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "修改提问" }));
    fireEvent.change(screen.getByRole("textbox", { name: "修改提问内容" }), { target: { value: "请重新检查轨道灯库存" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并重新生成" }));
    await waitFor(() => expect(historyPosts).toHaveLength(2));
    expect(historyPosts[1].id).toBe(historyPosts[0].id);
    expect(historyPosts[1]).toMatchObject({ turns: [{ user: "请重新检查轨道灯库存", assistant: "模型生成的客服草稿", versions: [{ user: "客户问轨道灯库存" }, { user: "请重新检查轨道灯库存" }] }] });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    const requestsBeforeSwitch = posts.length;
    fireEvent.click(screen.getByRole("button", { name: "上一个分支" }));
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByText("客户问轨道灯库存")).toBeInTheDocument();
    expect(posts).toHaveLength(requestsBeforeSwitch);
    fireEvent.click(screen.getByRole("button", { name: "下一个分支" }));
    expect(screen.getByText("请重新检查轨道灯库存")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新生成" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "对话记录" }));
    fireEvent.click(within(screen.getByRole("complementary", { name: "本机对话记录" })).getByRole("button", { name: /客户问轨道灯库存.*1 轮/ }));
    await waitFor(() => expect(screen.getByText("2 / 2")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "上一个分支" }));
    expect(screen.getByText("客户问轨道灯库存")).toBeInTheDocument();
    expect(screen.queryByText("待人工核对")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "标记人工核对" })).not.toBeInTheDocument();
  });

  it("follows the selected parent branch and keeps later replies on their original path", async () => {
    render(<AgentWorkspace {...props} initialExperience="chat" initialMessage="第一问" />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(historyPosts).toHaveLength(1));

    fireEvent.change(screen.getByRole("textbox", { name: "输入问题" }), { target: { value: "原分支的第二问" } });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(historyPosts).toHaveLength(2));
    expect(screen.getByText("原分支的第二问")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "修改提问" })[0]);
    fireEvent.change(screen.getByRole("textbox", { name: "修改提问内容" }), { target: { value: "第一问的新分支" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并重新生成" }));
    await waitFor(() => expect(historyPosts).toHaveLength(3));
    expect(screen.getByText("第一问的新分支")).toBeInTheDocument();
    expect(screen.queryByText("原分支的第二问")).not.toBeInTheDocument();

    const requestsBeforeSwitch = posts.length;
    fireEvent.click(screen.getByRole("button", { name: "上一个分支" }));
    expect(screen.getByText("原分支的第二问")).toBeInTheDocument();
    expect(posts).toHaveLength(requestsBeforeSwitch);
    fireEvent.click(screen.getByRole("button", { name: "下一个分支" }));
    expect(screen.queryByText("原分支的第二问")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "输入问题" }), { target: { value: "新分支的第二问" } });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(historyPosts).toHaveLength(4));
    expect(screen.getByText("新分支的第二问")).toBeInTheDocument();
    expect(screen.queryByText("原分支的第二问")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "上一个分支" }));
    expect(screen.getByText("原分支的第二问")).toBeInTheDocument();
    expect(screen.queryByText("新分支的第二问")).not.toBeInTheDocument();
  });

  it("preserves editable Work teams on each version and restores them for branches and regeneration", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    const addMember = (name: RegExp) => {
      fireEvent.click(screen.getByRole("button", { name: "@ 添加协作 Agent" }));
      fireEvent.click(within(screen.getByRole("listbox", { name: "选择协作 Agent" })).getByRole("option", { name }));
    };
    addMember(/销售复盘 Agent/);
    addMember(/微信客服 Agent/);
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(historyPosts).toHaveLength(1));
    expect(historyPosts[0]).toMatchObject({ turns: [{ agentId: "sales-consultant", collaboratorAgentIds: ["wechat-service", "sales-review"] }] });
    expect(within(screen.getByRole("group", { name: "本轮 Agent 引用" })).getByLabelText("主 Agent：产品销售顾问")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "本轮 Agent 引用" })).getByLabelText("协作 Agent：销售复盘 Agent")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "修改提问" }));
    expect(screen.getByRole("combobox", { name: "选择本地 Agent" })).toHaveTextContent("产品销售顾问");
    expect(screen.getByLabelText("参与协作的 Agent")).toHaveTextContent("微信客服 Agent");
    expect(screen.getByLabelText("参与协作的 Agent")).toHaveTextContent("销售复盘 Agent");
    fireEvent.click(screen.getByRole("combobox", { name: "选择本地 Agent" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "选择本地 Agent" })).getByRole("option", { name: /朋友圈运营 Agent/ }));
    expect(screen.getByRole("textbox", { name: "修改提问内容" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "本轮 Agent 引用" })).getByLabelText("主 Agent：产品销售顾问")).toBeInTheDocument();
    fireEvent.click(within(screen.getByLabelText("参与协作的 Agent")).getByRole("button", { name: /销售复盘 Agent/ }));
    addMember(/产品销售顾问/);
    fireEvent.change(screen.getByRole("textbox", { name: "修改提问内容" }), { target: { value: "用新队伍检查库存" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并重新生成" }));
    await waitFor(() => expect(historyPosts).toHaveLength(2));
    expect(within(screen.getByRole("group", { name: "本轮 Agent 引用" })).getByLabelText("主 Agent：朋友圈运营 Agent")).toBeInTheDocument();
    expect(screen.getByTestId("answer-agent-name")).toHaveTextContent("朋友圈运营 Agent");
    expect(historyPosts[1].id).toBe(historyPosts[0].id);
    expect(posts[1]).toMatchObject({ agentId: "moments-operator", collaboratorAgentIds: ["wechat-service", "sales-consultant"] });
    expect(chatSessionSchema.parse(historyPosts[1]).turns[0].versions).toEqual([
      expect.objectContaining({ agentId: "sales-consultant", collaboratorAgentIds: ["wechat-service", "sales-review"] }),
      expect.objectContaining({ agentId: "moments-operator", collaboratorAgentIds: ["wechat-service", "sales-consultant"] }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "上一个分支" }));
    expect(within(screen.getByRole("group", { name: "本轮 Agent 引用" })).getByLabelText("主 Agent：产品销售顾问")).toBeInTheDocument();
    expect(screen.getByTestId("answer-agent-name")).toHaveTextContent("产品销售顾问");
    expect(screen.getByRole("combobox", { name: "选择本地 Agent" })).toHaveTextContent("产品销售顾问");
    expect(screen.queryByLabelText("参与协作的 Agent")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一个分支" }));
    expect(screen.getByRole("combobox", { name: "选择本地 Agent" })).toHaveTextContent("朋友圈运营 Agent");
    expect(screen.queryByLabelText("参与协作的 Agent")).not.toBeInTheDocument();

    addMember(/销售复盘 Agent/);
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(historyPosts).toHaveLength(3));
    expect(posts[2]).toMatchObject({ agentId: "moments-operator", collaboratorAgentIds: ["wechat-service", "sales-consultant"] });
    expect(chatSessionSchema.parse(historyPosts[2]).turns[0].versions?.[2]).toMatchObject({ agentId: "moments-operator", collaboratorAgentIds: ["wechat-service", "sales-consultant"] });
    expect(screen.queryByLabelText("参与协作的 Agent")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "本轮 Agent 引用" })).toHaveTextContent("微信客服 Agent");
  });

  it("keeps the submitted Work Agent references visible while sending and after completion", async () => {
    const originalFetch = fetch;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const response = await originalFetch(url, init);
      if (url.endsWith("/chat")) await gate;
      return response;
    }));
    render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "@ 添加协作 Agent" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "选择协作 Agent" })).getByRole("option", { name: /销售复盘 Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    const references = within(screen.getByTestId("user-prompt")).getByRole("group", { name: "本轮 Agent 引用" });
    expect(within(references).getByLabelText("主 Agent：产品销售顾问")).toBeInTheDocument();
    expect(within(references).getByLabelText("协作 Agent：销售复盘 Agent").querySelector("img")).toHaveAttribute("src", "/api/v1/cowagent/agents/sales-review/avatar?v=local-v1");
    expect(screen.getByRole("combobox", { name: "选择本地 Agent" })).toBeDisabled();
    expect(screen.queryByLabelText("参与协作的 Agent")).not.toBeInTheDocument();
    expect(screen.getByTestId("answer-agent-name")).toHaveTextContent("产品销售顾问");
    await act(async () => { release(); });
    await waitFor(() => expect(historyPosts).toHaveLength(1));
    expect(within(screen.getByTestId("user-prompt")).getByRole("group", { name: "本轮 Agent 引用" })).toHaveTextContent("产品销售顾问");
    expect(within(screen.getByTestId("user-prompt")).getByRole("group", { name: "本轮 Agent 引用" })).toHaveTextContent("销售复盘 Agent");
  });

  it("renders each historical team's references and answer name independently with snapshot and deleted-ID fallbacks", async () => {
    const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    historyPosts.push({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", experience: "work", title: "历史队伍", agentId: "sales-consultant", createdAt: "2026-09-25T10:00:00.000Z", updatedAt: "2026-09-25T10:04:00.000Z", turns: [
        { id: firstId, user: "历史第一问", assistant: "历史第一答", createdAt: "2026-09-25T10:00:00.000Z", attachments: [], agentId: "sales-consultant", collaboratorAgentIds: ["deleted-helper", "missing-agent"], agentActivity: [
          { agentId: "sales-consultant", name: "原主 Agent 名称", round: 3, state: "completed" },
          { agentId: "deleted-helper", name: "已删除的资料助手", avatarUrl: "/saved-helper-avatar.png", round: 1, state: "completed", text: "保存的真实分析" },
        ] },
        { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", user: "历史第二问", assistant: "历史第二答", createdAt: "2026-09-25T10:01:00.000Z", attachments: [], parentVersionId: firstId, agentId: "moments-operator", collaboratorAgentIds: ["sales-review"] },
      ],
    });
    render(<AgentWorkspace {...props} initialMessage="" />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "选择本地 Agent" })).toHaveTextContent("产品销售顾问"));
    fireEvent.click(screen.getByRole("button", { name: "对话记录" }));
    const history = screen.getByRole("complementary", { name: "本机对话记录" });
    fireEvent.click(await within(history).findByRole("button", { name: /历史队伍.*2 轮/ }));
    await waitFor(() => expect(screen.getAllByTestId("user-prompt")).toHaveLength(2));
    const prompts = screen.getAllByTestId("user-prompt");
    expect(within(prompts[0]).getByLabelText("主 Agent：原主 Agent 名称")).toBeInTheDocument();
    expect(within(prompts[0]).getByLabelText("协作 Agent：已删除的资料助手").querySelector("img")).toHaveAttribute("src", "/saved-helper-avatar.png");
    expect(within(prompts[0]).getByLabelText("协作 Agent：missing-agent")).toBeInTheDocument();
    expect(within(prompts[1]).getByLabelText("主 Agent：朋友圈运营 Agent")).toBeInTheDocument();
    expect(screen.getAllByTestId("answer-agent-name").map((element) => element.textContent)).toEqual(["原主 Agent 名称", "朋友圈运营 Agent"]);
    fireEvent.click(within(prompts[0]).getByRole("button", { name: "修改提问" }));
    expect(screen.getByRole("combobox", { name: "选择本地 Agent" })).toHaveTextContent("产品销售顾问");
    expect(within(prompts[0]).getByRole("group", { name: "本轮 Agent 引用" })).toHaveTextContent("已删除的资料助手");
    expect(screen.getAllByTestId("answer-agent-name").map((element) => element.textContent)).toEqual(["原主 Agent 名称", "朋友圈运营 Agent"]);
    fireEvent.click(within(prompts[0]).getByRole("button", { name: "取消" }));
    expect(screen.getAllByTestId("answer-agent-name").map((element) => element.textContent)).toEqual(["原主 Agent 名称", "朋友圈运营 Agent"]);
  });

  it("links versions in older saved conversations by creation order", async () => {
    const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    historyPosts.push({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", experience: "chat", title: "第一问", createdAt: "2026-09-25T10:00:00.000Z", updatedAt: "2026-09-25T10:04:00.000Z", turns: [
        { id: firstId, user: "第一问的新版本", assistant: "第一答的新版本", createdAt: "2026-09-25T10:00:00.000Z", attachments: [], versions: [
          { id: firstId, user: "第一问的旧版本", assistant: "第一答的旧版本", createdAt: "2026-09-25T10:00:00.000Z", attachments: [] },
          { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", user: "第一问的新版本", assistant: "第一答的新版本", createdAt: "2026-09-25T10:02:00.000Z", attachments: [] },
        ] },
        { id: secondId, user: "第二问的新版本", assistant: "第二答的新版本", createdAt: "2026-09-25T10:01:00.000Z", attachments: [], versions: [
          { id: secondId, user: "第二问的旧版本", assistant: "第二答的旧版本", createdAt: "2026-09-25T10:01:00.000Z", attachments: [] },
          { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc", user: "第二问的新版本", assistant: "第二答的新版本", createdAt: "2026-09-25T10:03:00.000Z", attachments: [] },
        ] },
      ],
    });
    render(<AgentWorkspace {...props} initialExperience="chat" initialMessage="" />);
    fireEvent.click(screen.getByRole("button", { name: "对话记录" }));
    const history = screen.getByRole("complementary", { name: "本机对话记录" });
    await waitFor(() => expect(within(history).getByRole("button", { name: /第一问.*2 轮/ })).toBeInTheDocument());
    fireEvent.click(within(history).getByRole("button", { name: /第一问.*2 轮/ }));
    await waitFor(() => expect(screen.getByText("第一问的新版本")).toBeInTheDocument());
    expect(screen.getByText("第二问的新版本")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "上一个分支" }));
    expect(screen.getByText("第一问的旧版本")).toBeInTheDocument();
    expect(screen.getByText("第二问的旧版本")).toBeInTheDocument();
    expect(screen.queryByText("第二问的新版本")).not.toBeInTheDocument();
  });

  it("adds local text through the plus menu", async () => {
    const { container } = render(<AgentWorkspace {...props} initialMessage="" />);
    fireEvent.click(screen.getByRole("button", { name: "添加文件、文件夹或模式" }));
    expect(screen.getByRole("menuitem", { name: /文件夹/ })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("menu", { name: "添加内容与模式" })).getAllByRole("menuitem")[0]);
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const file = utf8File("hello.html", "<html><body>Hello</body></html>");
    fireEvent.change(inputs[0], { target: { files: [file] } });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "客户问题或销售任务" }) as HTMLTextAreaElement).value).toContain("hello.html"));
    expect((screen.getByRole("textbox", { name: "客户问题或销售任务" }) as HTMLTextAreaElement).value).toContain("<html><body>Hello</body></html>");
  });

  it("closes the grouped add menu when clicking outside it", async () => {
    render(<AgentWorkspace {...props} initialMessage="" />);
    fireEvent.click(screen.getByRole("button", { name: "添加文件、文件夹或模式" }));
    const menu = screen.getByRole("menu", { name: "添加内容与模式" });
    expect(menu).toHaveTextContent("添加内容");
    expect(menu).toHaveTextContent("工作上下文");
    expect(menu).toHaveTextContent("工作模式");
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "添加内容与模式" })).not.toBeInTheDocument());
  });

  it("extracts PDF content from the local parser before adding it to Chat", async () => {
    const { container } = render(<AgentWorkspace {...props} initialExperience="chat" initialMessage="" />);
    fireEvent.click(screen.getByRole("button", { name: "添加文件、文件夹或模式" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "添加内容与模式" })).getAllByRole("menuitem")[0]);
    const file = new File([new Uint8Array([37, 80, 68, 70])], "report.pdf", { type: "application/pdf" });
    fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "输入问题" }) as HTMLTextAreaElement).value).toContain("已解析的 PDF 正文"));
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/parse-document", expect.objectContaining({ method: "POST" }));
  });

  it("opens an Excel preview for a generated spreadsheet", async () => {
    render(<AgentWorkspace {...props} initialExperience="chat" initialMessage="请生成Excel报价表" />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.stringify(posts[0].messages)).toContain("Markdown 表格");
    expect(screen.getByRole("complementary", { name: "生成文件预览" })).toHaveTextContent("表格预览");
    await waitFor(() => expect(screen.getByRole("button", { name: "下载 Excel" })).toBeEnabled());
  });

  it("offers a real PDF file from a Chat request instead of only export instructions", async () => {
    render(<AgentWorkspace {...props} initialExperience="chat" initialMessage="请生成一份PDF短文" />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.stringify(posts[0].messages)).toContain("不要解释如何使用 Word、Google Docs");
    const fileCard = await screen.findByLabelText("已生成PDF文件");
    await waitFor(() => expect(within(fileCard).getByRole("button", { name: "下载 PDF" })).toBeEnabled());
    fireEvent.click(within(fileCard).getByRole("button", { name: "预览" }));
    expect(screen.getByRole("complementary", { name: "生成文件预览" })).toHaveTextContent(".pdf");
  });

  it("passes a persistent goal and a tool-free plan mode to the server", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "添加文件、文件夹或模式" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /目标模式/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "持续目标" }), { target: { value: "建成网页" } });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ workflowMode: "goal" });
    expect(JSON.stringify(posts[0].messages)).toContain("持续目标：建成网页");
    await idle();
    fireEvent.click(screen.getByRole("button", { name: "添加文件、文件夹或模式" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /计划模式/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "客户问题或销售任务" }), { target: { value: "先规划网页" } });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toMatchObject({ workflowMode: "plan" });
    expect(JSON.stringify(posts[1].messages)).toContain("本轮不要执行工具或修改文件");
  });

  it("shows local and WeChat Agent avatars in collaboration choices and closes when clicking outside", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    const input = screen.getByRole("textbox", { name: "客户问题或销售任务" });
    fireEvent.change(input, { target: { value: "客户问轨道灯库存 @", selectionStart: 10 } });
    const menu = screen.getByRole("listbox", { name: "选择协作 Agent" });
    expect(within(menu).getByRole("option", { name: /微信客服 Agent/ })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("option", { name: /销售复盘 Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "@ 添加协作 Agent" }));
    const wechatOption = within(screen.getByRole("listbox", { name: "选择协作 Agent" })).getByRole("option", { name: /微信客服 Agent/ });
    expect(wechatOption.querySelector("img")?.getAttribute("src")).toContain("wechat-service/avatar");
    fireEvent.click(wechatOption);
    expect(screen.getByLabelText("参与协作的 Agent")).toHaveTextContent("销售复盘 Agent");
    expect(screen.getByLabelText("参与协作的 Agent")).toHaveTextContent("微信客服 Agent");
    fireEvent.click(screen.getByRole("button", { name: "@ 添加协作 Agent" }));
    expect(screen.getByRole("listbox", { name: "选择协作 Agent" })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("heading", { name: "Chat-AI" }));
    expect(screen.queryByRole("listbox", { name: "选择协作 Agent" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts[0]).toMatchObject({ agentId: "sales-consultant", collaboratorAgentIds: ["wechat-service", "sales-review"] }));
  });

  it("merges Chat and Work into one workspace and keeps the selected model", async () => {
    render(<AgentWorkspace {...props} initialExperience="chat" />);
    await ready();
    expect(screen.getByRole("heading", { name: "Chat-AI" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "选择本地 Agent" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    const role = await screen.findByRole("combobox", { name: "选择本地 Agent" });
    expect(role).toHaveTextContent("产品销售顾问");
    fireEvent.click(role);
    expect(within(screen.getByRole("listbox", { name: "选择本地 Agent" })).getAllByRole("option")).toHaveLength(3);
    fireEvent.click(within(screen.getByRole("listbox", { name: "选择本地 Agent" })).getByRole("option", { name: /销售复盘 Agent/ }));
    expect(screen.getByRole("combobox", { name: "选择本地 Agent" })).toHaveTextContent("销售复盘 Agent");
    expect(screen.getByRole("combobox", { name: "选择本地 Agent" }).querySelector("img")?.getAttribute("src")).toContain("sales-review/avatar");
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts[0]).toMatchObject({ agentId: "sales-review", modelProfileId: "local-qwen3-8b" }));
    await idle();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.queryByTestId("agent-answer")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "输入问题" }), { target: { value: "客户问轨道灯库存" } });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts[1]).toMatchObject({ agentRoleId: "sales-consultant", modelProfileId: "local-qwen3-8b" }));
    await idle();
  });

  it("clears customer and file context for a new question without navigating on customer selection", async () => {
    const openCustomer = vi.fn();
    render(<AgentWorkspace {...props} onOpenCustomer={openCustomer} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "添加文件、文件夹或模式" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /知识库与客户/ }));
    await waitFor(() => expect(screen.getByLabelText("选择 已分类知识.md")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("选择 已分类知识.md"));
    fireEvent.change(screen.getByRole("combobox", { name: "选择客户" }), { target: { value: testCustomers[0].id } });
    expect(openCustomer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts[0]).toMatchObject({ customerId: testCustomers[0].id, knowledgeDocumentIds: [documentId] }));
    await idle();
    fireEvent.click(screen.getByRole("button", { name: "新问题" }));
    expect(screen.queryByTestId("agent-answer")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消客户上下文" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "客户问题或销售任务" })).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox", { name: "客户问题或销售任务" }), { target: { value: "全新问题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).not.toHaveProperty("customerId");
    expect(posts[1].knowledgeDocumentIds).toEqual([]);
    await idle();
  });

  it("sends the selected role and knowledge IDs in the real chat body", async () => {
    render(<AgentWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "添加文件、文件夹或模式" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /知识库与客户/ }));
    await waitFor(() => expect(screen.getByText("已分类知识.md")).toBeInTheDocument());
    await ready();
    const parsedSpreadsheet = screen.getByLabelText("选择 已解析表格.xlsx");
    expect(parsedSpreadsheet).toBeEnabled();
    fireEvent.click(parsedSpreadsheet);
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(screen.getByTestId("agent-answer")).toHaveTextContent("模型生成的客服草稿"));
    expect(screen.getByTestId("knowledge-coverage")).toHaveTextContent("已纳入 120 / 120 字");
    expect(posts[0]).toMatchObject({
      agentId: "sales-consultant",
      knowledgeDocumentIds: ["33333333-3333-4333-8333-333333333333"],
      modelProfileId: "local-qwen3-8b",
      mode: "light",
      messages: [{ role: "user", parts: [{ type: "text", text: "客户问轨道灯库存" }] }],
    });
    expect(posts[0]).not.toHaveProperty("customerId");
  });

  it("attaches and sends a photo through the chat transport", async () => {
    const { container } = render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "添加文件、文件夹或模式" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "添加内容与模式" })).getAllByRole("menuitem")[0]);
    const imageInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(imageInput).not.toBeNull();
    const image = new File([new Uint8Array([137, 80, 78, 71])], "product.png", { type: "image/png" });
    fireEvent.change(imageInput!, { target: { files: [image] } });
    expect(await screen.findByRole("img", { name: "product.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].messages).toEqual([expect.objectContaining({
      role: "user",
      parts: expect.arrayContaining([expect.objectContaining({ type: "file", mediaType: "image/png", filename: "product.png", url: expect.stringMatching(/^data:image\/png;base64,/) })]),
    })]);
  });

  it("clears the previous output when switching role and does not invent an answer", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(screen.getByTestId("agent-answer")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("combobox", { name: "选择本地 Agent" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "选择本地 Agent" })).getByRole("option", { name: /销售复盘 Agent/ }));
    expect(screen.queryByTestId("agent-answer")).not.toBeInTheDocument();
    expect(screen.getByText("选一位 Agent，一起把工作做好。")).toBeInTheDocument();
  });

  it("removes the standalone WeChat import option while keeping the desktop connection", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    expect(screen.queryByRole("button", { name: "导入微信记录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "导入微信记录" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /检测 \/ 连接微信|检测到微信 · 连接|微信只读连接/ })).toBeInTheDocument();
  });

  it("clears output and persists the selected model when switching models", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(screen.getByTestId("agent-answer")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^选择模型 / }));
    fireEvent.click(screen.getByRole("button", { name: /自定义模型/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("模型服务尚未配置或无法连接"));
    expect(screen.queryByTestId("agent-answer")).not.toBeInTheDocument();
    expect(localStorage.getItem("lumaflow.assistant.model-profile")).toBe("configured");
    expect(screen.getByRole("button", { name: "发送问题" })).toBeDisabled();
  });

  it("passes a confirmed WeChat snapshot into a local Agent request and blocks external model selection", async () => {
    const originalFetch = fetch;
    const snapshotId = "33333333-3333-4333-8333-333333333333";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/integrations/wechat")) return originalFetch(url, init);
      const action = init?.body ? JSON.parse(String(init.body)).action : "probe";
      if (action === "connect") return Response.json({ data: { connectionId: documentId, chatLabel: "虚构测试", loadedItems: 1 } });
      if (action === "read") return Response.json({ data: { id: snapshotId, chatLabel: "虚构测试", loadedItems: 1, capturedAt: new Date().toISOString(), entries: [{ kind: "text", text: "需要30套轨道灯" }] } });
      return Response.json({ data: { running: true, canRead: false, windows: [{ processId: 123, version: "4.1", application: "Weixin" }] } });
    }));
    render(<AgentWorkspace {...props} />); await ready();
    fireEvent.click(await screen.findByRole("button", { name: "检测到微信 · 连接" }));
    fireEvent.click(screen.getByRole("button", { name: "连接当前微信会话" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /我确认这是要分析的会话/ }));
    fireEvent.click(screen.getByRole("button", { name: "只读预览当前会话" }));
    fireEvent.click(await screen.findByRole("button", { name: "把选中记录放入任务" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("需要30套");
    fireEvent.click(screen.getByRole("button", { name: /^选择模型 / }));
    fireEvent.click(screen.getByRole("button", { name: /自定义模型/ }));
    expect(screen.getByRole("button", { name: /选择模型 本地 Qwen3 8B/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ wechatSnapshotId: snapshotId, modelProfileId: "local-qwen3-8b" }));
    await screen.findByTestId("agent-answer");
    fireEvent.click(screen.getByRole("button", { name: "新问题" }));
    expect(screen.queryByText(/已附加微信只读快照/)).not.toBeInTheDocument();
  });

  it("adds text through the general file picker and rejects malformed UTF-8 or too many files", async () => {
    const onToast = props.onToast as ReturnType<typeof vi.fn>;
    onToast.mockClear();
    render(<AgentWorkspace {...props} />);
    await ready();
    const openFilePicker = () => {
      fireEvent.click(screen.getByRole("button", { name: "添加文件、文件夹或模式" }));
      fireEvent.click(within(screen.getByRole("menu", { name: "添加内容与模式" })).getByRole("menuitem", { name: /文件 图片/ }));
      return document.querySelector<HTMLInputElement>('input[type="file"][multiple]');
    };
    const shortFile = utf8File("wechat.txt", "客户：请发一份轨道灯参数\n销售：我先帮您确认。");
    const firstInput = openFilePicker();
    await act(async () => { fireEvent.change(firstInput!, { target: { files: [shortFile] } }); });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "客户问题或销售任务" }) as HTMLTextAreaElement).value).toContain("请发一份轨道灯参数"));

    const invalidUtf8 = utf8File("broken.txt", new Uint8Array([0xc3, 0x28]));
    const secondInput = openFilePicker();
    await act(async () => { fireEvent.change(secondInput!, { target: { files: [invalidUtf8] } }); });
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringContaining("UTF-8 解码失败")));

    const manyFiles = Array.from({ length: 6 }, (_, index) => utf8File(`chat-${index}.txt`, `记录${index}`));
    const thirdInput = openFilePicker();
    await act(async () => { fireEvent.change(thirdInput!, { target: { files: manyFiles } }); });
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("最多导入 5 个"));
  });
});
