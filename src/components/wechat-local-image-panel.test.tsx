import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileUIPart } from "ai";
import { WechatLocalImagePanel } from "./wechat-local-image-panel";

const assetUrl = "/api/v1/assistant/image-operations/assets/0123456789abcdef0123456789abcdef.png";
const conversationId = "wechat-conversation-1";
const promptProps = () => ({ conversationId, prompt: "生成一张本地测试海报", onPromptChange: vi.fn(), onExit: vi.fn() });
const historyPosts: Record<string, unknown>[] = [];
const imagePosts: Record<string, unknown>[] = [];

beforeEach(() => {
  localStorage.clear();
  historyPosts.length = 0;
  imagePosts.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/assistant/history") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      historyPosts.push(body);
      return Response.json({ data: body });
    }
    if (url.includes("/assistant/history")) return Response.json({ data: null });
    if (url.endsWith("/image-operations/cancel")) return Response.json({ data: { cancelled: true } });
    if (url.endsWith("/image-operations")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      imagePosts.push(body);
      return Response.json({ data: { text: "本机质量说明：这是测试结果。", model: "Qwen/Qwen-Image-2.1", operation: body.operation, images: [{ url: assetUrl, filename: "本地结果.png", width: 512, height: 512 }] } });
    }
    return Response.json({ data: null });
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("WechatLocalImagePanel", () => {
  it("shows the local image model, gallery and updates the host prompt", () => {
    const props = promptProps();
    render(<WechatLocalImagePanel {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("生图功能启动");
    expect(screen.getByLabelText("图片模型 Qwen Image 2.1")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "热门图片风格" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "使用迪斯科风风格" }));
    expect(props.onPromptChange).toHaveBeenCalledWith(expect.stringContaining("迪斯科风格"));
  });

  it("submits only to the local image endpoint and saves an image turn to local history", async () => {
    const props = promptProps();
    render(<WechatLocalImagePanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "生成图片" }));
    await screen.findByText("本机质量说明：这是测试结果。");
    expect(imagePosts).toHaveLength(1);
    expect(imagePosts[0]).toMatchObject({ prompt: props.prompt, operation: "generate" });
    const result = await screen.findByRole("img", { name: "本地结果.png" });
    expect(result).toHaveAttribute("src", assetUrl);
    await waitFor(() => expect(historyPosts).toHaveLength(1));
    expect(historyPosts[0]).toMatchObject({ experience: "chat", title: "微信图片·生成一张本地测试海报" });
    const savedTurns = historyPosts[0].turns as Array<{ assistant: string }>;
    expect(savedTurns[0]?.assistant).toContain(assetUrl);
  });

  it("supports a source photo and routes it to edit when the prompt asks for a change", async () => {
    const props = { ...promptProps(), prompt: "把背景换成白色" };
    render(<WechatLocalImagePanel {...props} />);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "source.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("上传照片文件"), { target: { files: [file] } });
    await screen.findByText("source.png");
    fireEvent.click(screen.getByRole("button", { name: "编辑图片" }));
    await waitFor(() => expect(imagePosts[0]).toMatchObject({ operation: "edit" }));
    const submittedImages = imagePosts[0].images as Array<{ filename: string }>;
    expect(submittedImages[0]?.filename).toBe("source.png");
    expect(submittedImages[0]).not.toHaveProperty("size");
    expect(within(screen.getByLabelText("已上传图片")).getByText("source.png")).toBeInTheDocument();
  });

  it("accepts initial Wechat image parts and auto-submits only on a rising edge", async () => {
    const initialImage = { type: "file", mediaType: "image/png", filename: "wechat.png", url: "data:image/png;base64,AA==" } satisfies FileUIPart;
    const props = { ...promptProps(), prompt: "请查看这张图片", initialImages: [initialImage], autoSubmit: true };
    const view = render(<WechatLocalImagePanel {...props} />);
    await waitFor(() => expect(imagePosts).toHaveLength(1));
    expect(imagePosts[0]).toMatchObject({ operation: "analyze" });
    expect(imagePosts[0].images).toEqual([{ type: "file", mediaType: "image/png", filename: "wechat.png", url: initialImage.url }]);
    view.rerender(<WechatLocalImagePanel {...props} prompt="请继续查看细节" />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(imagePosts).toHaveLength(1);
  });
});
