import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWorkspace } from "./agent-workspace";
import { testAssets, testCustomers, testProducts } from "../test/fixtures";

const posts: Record<string, unknown>[] = [];
const documentId = "11111111-1111-4111-8111-111111111111";

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
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/chat")) {
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return modelReply();
    }
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

describe("Agent workspace", () => {
  it("merges Chat and Work into one workspace and keeps the selected model", async () => {
    render(<AgentWorkspace {...props} initialExperience="chat" />);
    await ready();
    expect(screen.getByRole("heading", { name: "Chat-AI" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "选择 Agent 角色" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    const role = screen.getByRole("combobox", { name: "选择 Agent 角色" });
    expect(role.querySelectorAll("option")).toHaveLength(4);
    fireEvent.change(role, { target: { value: "sales-review" } });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts[0]).toMatchObject({ agentRoleId: "sales-review", modelProfileId: "local-qwen3-8b" }));
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.queryByTestId("agent-answer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts[1]).toMatchObject({ agentRoleId: "sales-consultant", modelProfileId: "local-qwen3-8b" }));
    await ready();
  });

  it("clears customer and file context for a new question without navigating on customer selection", async () => {
    const openCustomer = vi.fn();
    render(<AgentWorkspace {...props} onOpenCustomer={openCustomer} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "添加资料与客户上下文" }));
    await waitFor(() => expect(screen.getByLabelText("选择 已分类知识.md")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("选择 已分类知识.md"));
    fireEvent.change(screen.getByRole("combobox", { name: "选择客户" }), { target: { value: testCustomers[0].id } });
    expect(openCustomer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts[0]).toMatchObject({ customerId: testCustomers[0].id, knowledgeDocumentIds: [documentId] }));
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "新问题" }));
    expect(screen.queryByTestId("agent-answer")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消客户上下文" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "客户问题或销售任务" })).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox", { name: "客户问题或销售任务" }), { target: { value: "全新问题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).not.toHaveProperty("customerId");
    expect(posts[1].knowledgeDocumentIds).toEqual([]);
    await ready();
  });

  it("sends the selected role and knowledge IDs in the real chat body", async () => {
    render(<AgentWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "添加资料与客户上下文" }));
    await waitFor(() => expect(screen.getByText("已分类知识.md")).toBeInTheDocument());
    await ready();
    const parsedSpreadsheet = screen.getByLabelText("选择 已解析表格.xlsx");
    expect(parsedSpreadsheet).toBeEnabled();
    fireEvent.click(parsedSpreadsheet);
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(screen.getByTestId("agent-answer")).toHaveTextContent("模型生成的客服草稿"));
    expect(screen.getByTestId("knowledge-coverage")).toHaveTextContent("已纳入 120 / 120 字");
    expect(posts[0]).toMatchObject({
      agentRoleId: "sales-consultant",
      knowledgeDocumentIds: ["33333333-3333-4333-8333-333333333333"],
      modelProfileId: "local-qwen3-8b",
      mode: "instant",
      messages: [{ role: "user", parts: [{ type: "text", text: "客户问轨道灯库存" }] }],
    });
    expect(posts[0]).not.toHaveProperty("customerId");
  });

  it("clears the previous output when switching role and does not invent an answer", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(screen.getByTestId("agent-answer")).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox", { name: "选择 Agent 角色" }), { target: { value: "wechat-service" } });
    expect(screen.queryByTestId("agent-answer")).not.toBeInTheDocument();
    expect(screen.getByText("选一位 Agent，一起把工作做好。")).toBeInTheDocument();
  });

  it("keeps export import separate from desktop connection without showing fake login", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.change(screen.getByRole("combobox", { name: "选择 Agent 角色" }), { target: { value: "wechat-service" } });
    fireEvent.click(screen.getByRole("button", { name: "导入微信记录" }));
    const importDialog = screen.getByRole("dialog", { name: "导入微信记录" });
    expect(importDialog).toHaveTextContent("与桌面只读连接分开");
    expect(importDialog).toHaveTextContent("不会生成二维码、索取密码或自动发送消息");
    expect(within(importDialog).queryByText(/扫码|登录成功/)).not.toBeInTheDocument();
  });

  it("clears output and persists the selected model when switching models", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(screen.getByTestId("agent-answer")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^选择模型 / }));
    fireEvent.click(screen.getByRole("button", { name: /自定义模型/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("所选模型尚未连接"));
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

  it("imports a short UTF-8 WeChat TXT, rejects over-budget input, malformed UTF-8, and more than five files", async () => {
    const onToast = props.onToast as ReturnType<typeof vi.fn>;
    onToast.mockClear();
    render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.change(screen.getByRole("combobox", { name: "选择 Agent 角色" }), { target: { value: "wechat-service" } });
    fireEvent.click(screen.getByRole("button", { name: "导入微信记录" }));
    const importInput = () => screen.getByLabelText("选择导出的文本记录（TXT / Markdown / CSV / JSON）") as HTMLInputElement;
    const shortFile = utf8File("wechat.txt", "客户：请发一份轨道灯参数\n销售：我先帮您确认。");
    fireEvent.change(importInput(), { target: { files: [shortFile] } });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "粘贴微信聊天记录" }) as HTMLTextAreaElement).value).toContain("请发一份轨道灯参数"));

    fireEvent.click(screen.getByRole("button", { name: "导入微信记录" }));
    const tooLong = utf8File("too-long.txt", "x".repeat(4_001));
    fireEvent.change(importInput(), { target: { files: [tooLong] } });
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringContaining("4,000")));
    expect((screen.getByRole("textbox", { name: "粘贴微信聊天记录" }) as HTMLTextAreaElement).value).not.toContain("x".repeat(100));

    const invalidUtf8 = utf8File("broken.txt", new Uint8Array([0xc3, 0x28]));
    fireEvent.change(importInput(), { target: { files: [invalidUtf8] } });
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringContaining("UTF-8 解码失败")));

    fireEvent.click(screen.getByRole("button", { name: "导入微信记录" }));
    const manyFiles = Array.from({ length: 6 }, (_, index) => utf8File(`chat-${index}.txt`, `记录${index}`));
    fireEvent.change(importInput(), { target: { files: manyFiles } });
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("最多导入 5 个"));
  });
});
