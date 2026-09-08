import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  onOpenCustomer: vi.fn(),
  onOpenProduct: vi.fn(),
  onToast: vi.fn(),
};

beforeEach(() => {
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
  await waitFor(() => expect(screen.getByRole("button", { name: /交给 产品销售顾问/ })).toBeEnabled());
}

describe("Agent workspace", () => {
  it("sends the selected role and knowledge IDs in the real chat body", async () => {
    render(<AgentWorkspace {...props} />);
    await waitFor(() => expect(screen.getByText("已分类知识.md")).toBeInTheDocument());
    await ready();
    const parsedSpreadsheet = screen.getByLabelText("选择 已解析表格.xlsx");
    expect(parsedSpreadsheet).toBeEnabled();
    fireEvent.click(parsedSpreadsheet);
    fireEvent.click(screen.getByRole("button", { name: /交给 产品销售顾问/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /交给 产品销售顾问/ }));
    await waitFor(() => expect(screen.getByTestId("agent-answer")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /微信客服 Agent/ }));
    expect(screen.queryByTestId("agent-answer")).not.toBeInTheDocument();
    expect(screen.getByText("发送工作输入后，这里才会出现模型输出")).toBeInTheDocument();
  });

  it("explains that personal WeChat is not connected instead of showing fake login", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /微信客服 Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "导入微信记录" }));
    expect(screen.getByRole("dialog", { name: "导入微信记录" })).toHaveTextContent("个人微信：尚未连接");
    expect(screen.getByRole("dialog", { name: "导入微信记录" })).toHaveTextContent("不会生成二维码、索取密码或自动发送消息");
    expect(screen.queryByText(/扫码|登录成功/)).not.toBeInTheDocument();
  });

  it("clears output and persists the selected model when switching models", async () => {
    render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /交给 产品销售顾问/ }));
    await waitFor(() => expect(screen.getByTestId("agent-answer")).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox", { name: "选择模型" }), { target: { value: "configured" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("所选模型尚未连接"));
    expect(screen.queryByTestId("agent-answer")).not.toBeInTheDocument();
    expect(localStorage.getItem("lumaflow.assistant.model-profile")).toBe("configured");
    expect(screen.getByRole("button", { name: /交给 产品销售顾问/ })).toBeDisabled();
  });

  it("imports a short UTF-8 WeChat TXT, rejects over-budget input, malformed UTF-8, and more than five files", async () => {
    const onToast = props.onToast as ReturnType<typeof vi.fn>;
    onToast.mockClear();
    render(<AgentWorkspace {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /微信客服 Agent/ }));
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
