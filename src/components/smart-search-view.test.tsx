import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmartSearchView } from "./smart-search-view";
import { testSnapshot } from "../test/fixtures";
import { getInventoryRecord, getProductRecord } from "../lib/ai/product-tooling";

const posts: Record<string, unknown>[] = [];
let nextChat: (init?: RequestInit) => Promise<Response>;
const props = { products: testSnapshot.products, initialQuestion: "测试库存问题", onProduct: vi.fn(), onToast: vi.fn(), onAddToKit: vi.fn() };
function modelReply(text = "模型实测回复：库存126件") {
  const events = [
    { type: "start", messageId: "reply" },
    { type: "start-step" },
    { type: "tool-input-available", toolCallId: "details", toolName: "getProductDetails", input: { identifier: "LT-ARC-T18-BK" } },
    { type: "tool-output-available", toolCallId: "details", output: getProductRecord("LT-ARC-T18-BK", testSnapshot) },
    { type: "tool-input-available", toolCallId: "inventory", toolName: "checkInventory", input: { identifier: "LT-ARC-T18-BK" } },
    { type: "tool-output-available", toolCallId: "inventory", output: getInventoryRecord("LT-ARC-T18-BK", testSnapshot) },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: text },
    { type: "text-end", id: "text" },
    { type: "finish-step" },
    { type: "finish", finishReason: "stop" },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
}
beforeEach(() => {
  posts.length = 0;
  localStorage.clear();
  nextChat = async () => modelReply();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/chat")) { posts.push(JSON.parse(String(init?.body))); return nextChat(init); }
    const id = url.includes("modelProfileId=configured") ? "configured" : "local-qwen3-8b";
    const meta = { apiVersion: "v1", requestId: "test", checkedAt: new Date().toISOString() };
    if (url.endsWith("/models")) return Response.json({ data: { defaultProfileId: "local-qwen3-8b", models: [
      { id: "local-qwen3-8b", label: "本地8B", model: "local-test", description: "本地模型", configured: true, reachable: true, connectionKind: "live", contextTokens: 8192, family: "Qwen3", parameterSizeB: 8, supportedModes: ["instant", "medium", "high", "extra-high"] },
      { id: "local-qwen3-14b", label: "本地14B", model: "qwen3:14b", description: "较大本地模型", configured: true, reachable: true, connectionKind: "live", contextTokens: 8192, family: "Qwen3", parameterSizeB: 14, supportedModes: ["instant", "medium", "high", "extra-high", "pro"] },
      { id: "configured", label: "自定义", model: "offline-model", description: "尚未接通", configured: false, reachable: false, connectionKind: "live", contextTokens: null },
    ] }, meta });
    return Response.json({ data: { configured: id !== "configured", reachable: id !== "configured", profileId: id, provider: "vllm-openai-compatible", model: id === "configured" ? "offline-model" : "local-test", connectionKind: "live", contextTokens: 8192, latencyMs: 1 }, meta });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function ready() { await waitFor(() => expect(screen.getByRole("button", { name: "发送问题" })).toBeEnabled()); }

describe("smart search real-model entry", () => {
  it("sends real reasoning modes and visibly routes Pro to 14B", async () => {
    render(<SmartSearchView {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "High 更长推理" }));
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts[0]).toMatchObject({ mode: "high", modelProfileId: "local-qwen3-8b" }));
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Pro 较大模型" }));
    await ready();
    expect(screen.queryByTestId("model-answer")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "选择模型" })).toHaveValue("local-qwen3-14b");
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts[1]).toMatchObject({ mode: "pro", modelProfileId: "local-qwen3-14b" }));
  });

  it("does not label length-exhausted output as a completed answer", async () => {
    nextChat = async () => {
      const original = modelReply("部分回答");
      return new Response((await original.text()).replace('"finishReason":"stop"', '"finishReason":"length"'), { headers: original.headers });
    };
    render(<SmartSearchView {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(screen.getByText("预算已用尽 · 答案可能不完整")).toBeInTheDocument());
    expect(screen.queryByText("已完成 · 待人工核对")).not.toBeInTheDocument();
  });
  it("starts without fabricated answers or citations and sends selected profile through the real useChat transport", async () => {
    render(<SmartSearchView {...props} />);
    await ready();
    expect(screen.queryByTestId("model-answer")).not.toBeInTheDocument();
    expect(screen.getByTestId("search-evidence")).not.toHaveTextContent("实时库存快照");
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(screen.getByTestId("model-answer")).toHaveTextContent("模型实测回复"));
    expect(posts[0]).toMatchObject({ modelProfileId: "local-qwen3-8b", mode: "instant", messages: [{ role: "user", parts: [{ type: "text", text: "测试库存问题" }] }] });
    expect(screen.getByTestId("search-evidence")).toHaveTextContent("LT-ARC-T18-BK 库存 126");
    expect(screen.getByTestId("search-evidence")).toHaveTextContent("核对时间");
    expect(screen.getByText(/本轮数据源：json/)).toBeInTheDocument();
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "输入产品问题" }), { target: { value: "第二次问题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].messages).toHaveLength(1);
  });

  it("switches model, clears the old answer, persists selection and disables disconnected calls", async () => {
    render(<SmartSearchView {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(screen.getByTestId("model-answer")).toBeInTheDocument());
    await ready();
    fireEvent.change(screen.getByRole("combobox", { name: "选择模型" }), { target: { value: "configured" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("自定义模型未连接"));
    expect(screen.getByRole("button", { name: "发送问题" })).toBeDisabled();
    expect(screen.queryByTestId("model-answer")).not.toBeInTheDocument();
    expect(localStorage.getItem("lumaflow.assistant.model-profile")).toBe("configured");
    fireEvent.change(screen.getByRole("combobox", { name: "选择模型" }), { target: { value: "local-qwen3-8b" } });
    await ready();
  });

  it("shows pending state, locks model selection and offers stop while inference is pending", async () => {
    let resolve!: (value: Response) => void;
    nextChat = () => new Promise((done) => { resolve = done; });
    render(<SmartSearchView {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止生成" })).toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "选择模型" })).toBeDisabled();
    expect(screen.getByText(/正在等待本地模型/)).toBeInTheDocument();
    resolve(modelReply());
    await ready();
  });

  it("surfaces HTTP failures and retries instead of falling back to a rule answer", async () => {
    nextChat = async () => new Response("unavailable", { status: 503 });
    render(<SmartSearchView {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("HTTP 503"));
    expect(screen.queryByTestId("model-answer")).not.toBeInTheDocument();
    nextChat = async () => modelReply("重试成功");
    fireEvent.click(screen.getByRole("button", { name: "重试本轮问题" }));
    await waitFor(() => expect(screen.getByTestId("model-answer")).toHaveTextContent("重试成功"));
  });

  it("aborts a pending request on stop and can send a fresh question afterwards", async () => {
    let signal: AbortSignal | null | undefined;
    nextChat = (init) => new Promise((_, reject) => {
      signal = init?.signal;
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    render(<SmartSearchView {...props} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(signal).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    await ready();
    expect(signal?.aborted).toBe(true);
    expect(screen.getByText("已停止 · 内容可能不完整")).toBeInTheDocument();
    expect(screen.queryByTestId("model-answer")).not.toBeInTheDocument();
    nextChat = async () => modelReply("停止后重新生成成功");
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(screen.getByTestId("model-answer")).toHaveTextContent("停止后重新生成成功"));
  });

  it("does not send while confirming Chinese IME input or creating a newline", async () => {
    render(<SmartSearchView {...props} />);
    await ready();
    const input = screen.getByRole("textbox", { name: "输入产品问题" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(posts).toHaveLength(0);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(posts).toHaveLength(1));
    await ready();
  });
});
