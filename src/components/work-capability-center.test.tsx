import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkCapabilityLaunchUrl,
  isLocalBrowserHost,
  loopbackOrigin,
  WorkCapabilityCenter,
} from "./work-capability-center";

const connectedPayload = {
  data: {
    connected: true,
    version: "1.0.2b7",
    baseUrl: "http://127.0.0.1:8088",
    agentIds: { work: "lumaflow-work", researcher: "work-researcher", verifier: "work-verifier", team: "work-team" },
    sections: [
      { id: "experts", label: "专家和团队", path: "/experts", availability: "available" },
      { id: "skills", label: "技能和插件", path: "/personalization/skills", availability: "available" },
      { id: "tasks", label: "定时任务", path: "/tasks", availability: "available" },
    ],
    models: [{ id: "local-qwen", label: "本地 Qwen" }],
  },
};
let routePayload: unknown;

function response(payload: unknown, status = 200) {
  return Response.json(payload, { status });
}

beforeEach(() => {
  routePayload = { data: { sectionId: "experts", confidence: 0.9, source: "local-rules" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/work-engine")) return response(connectedPayload);
    if (url.endsWith("/work-engine/session")) return response({ data: { token: "opaque-session-token", expiresAt: "2099-01-01T00:00:00.000Z" } });
    if (url.endsWith("/work-engine/route-request")) return response(routePayload);
    throw new Error(`unexpected request ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkCapabilityCenter", () => {
  it("accepts only loopback engine origins and encodes the server section path", () => {
    expect(loopbackOrigin("http://127.0.0.1:8088")).toBe("http://127.0.0.1:8088");
    expect(loopbackOrigin("http://localhost:8088/anything")).toBe("http://localhost:8088");
    expect(loopbackOrigin("https://example.com")).toBeNull();
    expect(loopbackOrigin("javascript:alert(1)")).toBeNull();
    expect(buildWorkCapabilityLaunchUrl("http://127.0.0.1:8088", "/personalization/skills")).toBe("http://127.0.0.1:8088/lumaflow/launch?section=%2Fpersonalization%2Fskills");
    expect(buildWorkCapabilityLaunchUrl("https://example.com", "/experts")).toBeNull();
    expect(isLocalBrowserHost("127.0.0.1")).toBe(true);
    expect(isLocalBrowserHost("example.com")).toBe(false);
  });

  it("shows the real disconnected state and lets the user retry", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementationOnce(async () => response({ data: { connected: false, baseUrl: "http://127.0.0.1:8088", sections: [] } }));
    render(<WorkCapabilityCenter />);
    fireEvent.click(screen.getByRole("button", { name: "能力中心" }));
    expect(await screen.findByTestId("work-engine-disconnected")).toHaveTextContent("本机 Octop 引擎未连接");
    expect(screen.queryByTestId("work-engine-frame-shell")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId("work-engine-disconnected")).getByRole("button", { name: "重新检测" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/work-engine"))).toHaveLength(2));
  });

  it("requires the exact iframe origin/source before issuing a session and never renders the token", async () => {
    render(<WorkCapabilityCenter />);
    fireEvent.click(screen.getByRole("button", { name: "能力中心" }));
    const iframe = await screen.findByTitle("专家和团队 · LumaFlow Work 能力中心") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "http://evil.example",
        source: iframe.contentWindow,
        data: { type: "lumaflow:ready" },
      }));
      window.dispatchEvent(new MessageEvent("message", {
        origin: "http://127.0.0.1:8088",
        source: window,
        data: { type: "lumaflow:ready" },
      }));
    });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/work-engine/session"))).toHaveLength(0);

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "http://127.0.0.1:8088",
        source: iframe.contentWindow,
        data: { type: "lumaflow:ready" },
      }));
    });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/work-engine/session"))).toHaveLength(1));
    expect(vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/work-engine/session"))?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ path: "/experts" }),
    });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "lumaflow:session", token: "opaque-session-token", path: "/experts" }, "http://127.0.0.1:8088"));
    expect(document.body).not.toHaveTextContent("opaque-session-token");
  });

  it("uses server-provided sections for the native navigation", async () => {
    render(<WorkCapabilityCenter />);
    fireEvent.click(screen.getByRole("button", { name: "能力中心" }));
    await screen.findByTitle("专家和团队 · LumaFlow Work 能力中心");
    fireEvent.click(screen.getByRole("button", { name: "技能和插件" }));
    expect(await screen.findByTitle("技能和插件 · LumaFlow Work 能力中心")).toHaveAttribute("src", "http://127.0.0.1:8088/lumaflow/launch?section=%2Fpersonalization%2Fskills");
  });

  it("keeps duplicate paths distinct by section id while navigating with the shared path", async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => response({
      data: {
        ...connectedPayload.data,
        sections: [
          { id: "experts", label: "专家库", path: "/experts", availability: "available" },
          { id: "teams", label: "专家团队", path: "/experts", availability: "available" },
        ],
      },
    }));
    render(<WorkCapabilityCenter />);
    fireEvent.click(screen.getByRole("button", { name: "能力中心" }));
    await screen.findByTitle("专家库 · LumaFlow Work 能力中心");
    fireEvent.click(screen.getByRole("button", { name: "专家团队" }));
    const frame = await screen.findByTitle("专家团队 · LumaFlow Work 能力中心");
    expect(frame).toHaveAttribute("src", "http://127.0.0.1:8088/lumaflow/launch?section=%2Fexperts");
    expect(screen.getByRole("button", { name: "专家团队" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "专家库" })).not.toHaveAttribute("aria-current", "page");
  });

  it("does not present sections requiring an account as available", async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => response({
      data: {
        ...connectedPayload.data,
        sections: [
          { id: "experts", label: "专家和团队", path: "/experts", availability: "available" },
          { id: "channels", label: "消息通道", path: "/channels", availability: "needs-account", detail: "需要先授权账号" },
        ],
      },
    }));
    render(<WorkCapabilityCenter />);
    fireEvent.click(screen.getByRole("button", { name: "能力中心" }));
    const channels = await screen.findByRole("button", { name: /消息通道/ });
    expect(channels).toBeDisabled();
    expect(channels).toHaveAttribute("title", "需要先授权账号");
    expect(screen.getByTitle("专家和团队 · LumaFlow Work 能力中心")).toBeInTheDocument();
  });

  it("asks the router for a recommendation and navigates only after an explicit click", async () => {
    routePayload = { data: { sectionId: "skills", confidence: 0.91, source: "local-rules" } };
    render(<WorkCapabilityCenter />);
    fireEvent.click(screen.getByRole("button", { name: "能力中心" }));
    const input = await screen.findByRole("textbox", { name: "你想做什么？" });
    fireEvent.change(input, { target: { value: "  管理技能和插件  " } });
    fireEvent.click(screen.getByRole("button", { name: "推荐入口" }));
    const recommendation = await screen.findByTestId("work-engine-route-recommendation");
    expect(recommendation).toHaveTextContent("技能和插件");
    const routeCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/work-engine/route-request"));
    expect(routeCall?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ text: "管理技能和插件" }) });
    expect(screen.getByTitle("专家和团队 · LumaFlow Work 能力中心")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("local-rules");
    fireEvent.click(screen.getByRole("button", { name: "进入技能和插件" }));
    expect(await screen.findByTitle("技能和插件 · LumaFlow Work 能力中心")).toHaveAttribute("src", "http://127.0.0.1:8088/lumaflow/launch?section=%2Fpersonalization%2Fskills");
  });

  it("returns to selectable navigation when confidence is low or the section is unknown", async () => {
    routePayload = { data: { sectionId: "skills", confidence: 0.74, source: "typesafe-choice" } };
    render(<WorkCapabilityCenter />);
    fireEvent.click(screen.getByRole("button", { name: "能力中心" }));
    const input = await screen.findByRole("textbox", { name: "你想做什么？" });
    fireEvent.change(input, { target: { value: "我不确定要做什么" } });
    fireEvent.click(screen.getByRole("button", { name: "推荐入口" }));
    expect(await screen.findByTestId("work-engine-route-uncertain")).toHaveTextContent("请从左侧选择功能");
    expect(screen.queryByRole("button", { name: "进入技能和插件" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "技能和插件" })).toBeEnabled();
    expect(document.body).not.toHaveTextContent("typesafe-choice");

    routePayload = { data: { sectionId: "private-internal-id", confidence: 0.99, source: "local-rules" } };
    fireEvent.change(input, { target: { value: "另一个任务" } });
    fireEvent.click(screen.getByRole("button", { name: "推荐入口" }));
    expect(await screen.findByTestId("work-engine-route-uncertain")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("private-internal-id");
  });
});
