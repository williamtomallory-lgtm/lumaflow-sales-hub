import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WechatConnection } from "./wechat-connection";

const endpoint = "/api/v1/integrations/wechat";
const roleIds = ["sales-consultant", "wechat-service", "sales-review", "moments-operator"];
const processId = 4_321;
const connectionId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "22222222-2222-4222-8222-222222222222";

const probe = {
  state: "detected",
  canRead: true,
  running: true,
  windows: [{ processId, version: "4.1.13.63", application: "微信" }],
  processId,
  version: "4.1.13.63",
};

const connection = { connectionId, chatLabel: "客户会话（合成测试）", loadedItems: 2 };
const snapshot = {
  id: snapshotId,
  chatLabel: connection.chatLabel,
  capturedAt: "2026-09-08T12:00:00.000Z",
  loadedItems: 2,
  entries: [
    { kind: "text" as const, text: "客户：请确认轨道灯交期。" },
    { kind: "text" as const, text: "销售：我先核对库存和交期。" },
  ],
};

function jsonResponse(data: unknown, status = 200) {
  return status >= 400
    ? new Response(JSON.stringify({ error: { message: data } }), { status, headers: { "content-type": "application/json" } })
    : Response.json({ data });
}

function actionOf(init?: RequestInit) {
  if (!init?.body) return "probe";
  return (JSON.parse(String(init.body)) as { action?: string }).action ?? "unknown";
}

function bodyOf(init?: RequestInit) {
  return init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WechatConnection", () => {
  it("runs read-only detection again for each Agent role", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(endpoint);
      expect(init?.method).toBe("GET");
      return jsonResponse(probe);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onImport = vi.fn(() => true);
    const { rerender } = render(<WechatConnection roleId={roleIds[0]} disabled={false} onImport={onImport} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    for (const [index, roleId] of roleIds.slice(1).entries()) {
      rerender(<WechatConnection roleId={roleId} disabled={false} onImport={onImport} />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(index + 2));
    }
    expect(fetchMock).toHaveBeenCalledTimes(roleIds.length);
  });

  it("detects a process without connecting, then requires consent and deliberate preview/select/import", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      switch (actionOf(init)) {
        case "connect": return jsonResponse(connection);
        case "read": return jsonResponse(snapshot);
        default: return jsonResponse(probe);
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    const onImport = vi.fn(() => true);
    render(<WechatConnection roleId="wechat-service" disabled={false} onImport={onImport} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "检测到微信 · 连接" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "检测到微信 · 连接" }));
    const dialog = screen.getByRole("dialog", { name: "连接个人微信" });
    expect(within(dialog).getByText("微信进程已检测到")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "连接当前微信会话" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "连接当前微信会话" }));
    await waitFor(() => expect(within(dialog).getByText(/桌面接口已连接/)).toBeInTheDocument());
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({ action: "connect", processId });

    const previewButton = within(dialog).getByRole("button", { name: "只读预览当前会话" });
    expect(previewButton).toBeDisabled();
    fireEvent.click(previewButton);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(within(dialog).getByRole("checkbox", { name: /我确认这是要分析的会话/ }));
    expect(previewButton).toBeEnabled();
    fireEvent.click(previewButton);
    await waitFor(() => expect(within(dialog).getByText("已读取 2 条，选中后再放入任务")).toBeInTheDocument());
    expect(bodyOf(fetchMock.mock.calls[2]?.[1])).toMatchObject({ action: "read", connectionId, confirmed: true, limit: 5 });
    expect(onImport).not.toHaveBeenCalled();

    const entries = within(dialog).getAllByRole("checkbox").filter((checkbox) => checkbox !== within(dialog).getByRole("checkbox", { name: /我确认这是要分析的会话/ }));
    expect(entries).toHaveLength(2);
    fireEvent.click(entries[1]);
    fireEvent.click(within(dialog).getByRole("button", { name: "把选中记录放入任务" }));
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport).toHaveBeenCalledWith(snapshotId, expect.stringContaining("客户：请确认轨道灯交期。"));
    expect(onImport).not.toHaveBeenCalledWith(snapshotId, expect.stringContaining("销售：我先核对库存和交期。"));
  });

  it("clears the connection after a chat-changed read error and never imports it", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      switch (actionOf(init)) {
        case "connect": return jsonResponse(connection);
        case "read": return jsonResponse("微信会话已切换或无法读取，请重新连接并确认聊天；本次未导入记录。", 409);
        default: return jsonResponse(probe);
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    const onImport = vi.fn(() => true);
    render(<WechatConnection roleId="wechat-service" disabled={false} onImport={onImport} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "检测到微信 · 连接" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "检测到微信 · 连接" }));
    const dialog = screen.getByRole("dialog", { name: "连接个人微信" });
    fireEvent.click(within(dialog).getByRole("button", { name: "连接当前微信会话" }));
    await waitFor(() => expect(within(dialog).getByText(/桌面接口已连接/)).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /我确认这是要分析的会话/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "只读预览当前会话" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("微信会话已切换"));
    expect(within(dialog).queryByText(/桌面接口已连接/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "断开" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "把选中记录放入任务" })).not.toBeInTheDocument();
    expect(onImport).not.toHaveBeenCalled();
  });

  it("blocks opening and all connection actions while disabled", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => jsonResponse(actionOf(init) === "probe" ? probe : connection));
    vi.stubGlobal("fetch", fetchMock);
    const onImport = vi.fn(() => true);
    render(<WechatConnection roleId="wechat-service" disabled={true} onImport={onImport} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const trigger = screen.getByRole("button", { name: "检测到微信 · 连接" });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: "连接个人微信" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onImport).not.toHaveBeenCalled();
  });
});
