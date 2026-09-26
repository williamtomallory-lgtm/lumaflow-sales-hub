import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkSideChat } from "./work-side-chat";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("independent Work side chat", () => {
  it("streams a real separate conversation and only updates the queued task on explicit apply", async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response('data: {"type":"text-delta","delta":"建议先核对输入文件"}\n\ndata: [DONE]\n\n'));
    vi.stubGlobal("fetch", fetcher);
    const apply = vi.fn();
    render(<WorkSideChat task="整理资料" onClose={vi.fn()} onApplyToQueue={apply} />);
    fireEvent.change(screen.getByRole("textbox", { name: "侧边聊天输入" }), { target: { value: "这个任务可以怎么细化？" } });
    fireEvent.click(screen.getByRole("button", { name: "发送侧边问题" }));
    await waitFor(() => expect(screen.getByText("建议先核对输入文件")).toBeInTheDocument());
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.experience).toBe("chat");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].parts[0].text).toContain("排队任务：整理资料");
    expect(apply).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "将回答用于排队消息" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "将回答用于排队消息" }));
    expect(apply).toHaveBeenCalledWith("建议先核对输入文件");
  });
  it("closing aborts only the side request", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => { requestSignal = init.signal as AbortSignal; return new Promise((_resolve, reject) => requestSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))); }));
    const close = vi.fn();
    render(<WorkSideChat task="整理资料" onClose={close} onApplyToQueue={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "发送侧边问题" }));
    await waitFor(() => expect(requestSignal).toBeDefined());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "关闭侧边聊天" })); });
    expect(requestSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
});
