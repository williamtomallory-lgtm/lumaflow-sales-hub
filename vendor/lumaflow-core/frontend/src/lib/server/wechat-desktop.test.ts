// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exec: vi.fn(), closeInput: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("node:child_process", () => ({ execFile: (file: string, args: string[], options: object, callback: (error: Error | null, stdout: string) => void) => {
  Promise.resolve(mocks.exec(file, args, options)).then((result) => callback(null, result.stdout)).catch((error) => callback(error, ""));
  return { stdin: { end: mocks.closeInput } };
} }));
import { authorizeWechatModel, connectWechat, detectWechat, disconnectWechat, readWechat } from "./wechat-desktop";
import { formatWechatSnapshot, wechatActionSchema } from "../contracts/wechat";
const fingerprint = "a".repeat(64);
const ready = { state: "ready", canRead: true, processId: 123, version: "4.1.13.63", chatLabel: "Synthetic QA only", chatFingerprint: fingerprint, loadedItems: 2 };
function reply(value: object) { mocks.exec.mockResolvedValueOnce({ stdout: JSON.stringify(value) }); }
beforeEach(() => { mocks.exec.mockReset(); mocks.closeInput.mockReset(); vi.stubGlobal("process", { ...process, platform: "win32" }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("read-only WeChat bridge", () => {
  it("detects without reading messages and uses a fixed hidden executable command", async () => {
    reply({ state: "detected", running: true, canRead: false, windows: [] });
    expect((await detectWechat()).canRead).toBe(false);
    expect(mocks.closeInput).toHaveBeenCalledOnce();
    expect(mocks.exec).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining(["-Action", "probe"]), expect.objectContaining({ windowsHide: true, timeout: 12000 }));
  });
  it("rejects unreadable windows without creating a connection", async () => {
    reply({ state: "open_chat_required", canRead: false });
    await expect(connectWechat(123)).rejects.toMatchObject({ status: 409 });
  });
  it("binds read to the confirmed process and chat fingerprint; snapshots stay local", async () => {
    reply(ready); const connection = await connectWechat(123);
    reply({ ...ready, entries: [{ kind: "text", text: "Synthetic customer needs 30 lights" }, { kind: "attachment-unread", text: "[Attachment content not read]" }] });
    const snapshot = await readWechat(connection.connectionId, 5);
    expect(mocks.exec).toHaveBeenLastCalledWith("powershell.exe", expect.arrayContaining(["-ProcessId", "123", "-ExpectedChat", fingerprint, "-Limit", "5"]), expect.any(Object));
    expect(formatWechatSnapshot(snapshot)).toContain("不是全部历史");
    expect(() => authorizeWechatModel(snapshot.id, "local-qwen3-8b")).not.toThrow();
    expect(() => authorizeWechatModel(snapshot.id, "local-qwen3-14b")).not.toThrow();
    expect(() => authorizeWechatModel(snapshot.id, "configured")).toThrow("仅允许");
    disconnectWechat(connection.connectionId);
    await expect(readWechat(connection.connectionId, 5)).rejects.toMatchObject({ status: 409 });
  });
  it("rejects a changed chat and invalidates the connection", async () => {
    reply(ready); const connection = await connectWechat(123);
    reply({ state: "chat_changed", canRead: false });
    await expect(readWechat(connection.connectionId, 5)).rejects.toMatchObject({ code: "WECHAT_CHAT_CHANGED" });
    await expect(readWechat(connection.connectionId, 5)).rejects.toMatchObject({ code: "WECHAT_CONNECTION_EXPIRED" });
  });
  it("expires snapshots and rejects fabricated IDs", () => {
    expect(() => authorizeWechatModel("00000000-0000-4000-8000-000000000000", "local-qwen3-8b")).toThrow();
  });
  it("does not disclose native exceptions or chat content", async () => {
    mocks.exec.mockRejectedValueOnce(new Error("private text must not leak"));
    await expect(detectWechat()).rejects.toMatchObject({ code: "WECHAT_PROBE_FAILED" });
  });
  it("requires explicit read confirmation and rejects arbitrary commands", () => {
    const base = { action: "read", connectionId: "00000000-0000-4000-8000-000000000000", limit: 5 };
    expect(wechatActionSchema.safeParse(base).success).toBe(false);
    expect(wechatActionSchema.safeParse({ ...base, confirmed: true }).success).toBe(true);
    expect(wechatActionSchema.safeParse({ ...base, confirmed: true, command: "anything" }).success).toBe(false);
    expect(wechatActionSchema.safeParse({ action: "send", text: "hello" }).success).toBe(false);
  });
});
