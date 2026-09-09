import "server-only";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { wechatProbeSchema, type WechatSnapshot } from "../contracts/wechat";
import { ApiHttpError } from "./api-security";

const TTL = 10 * 60_000;
type Connection = { processId: number; fingerprint: string; expires: number };
const globalWechat = globalThis as typeof globalThis & { lumaflowWechat?: { connections: Map<string, Connection>; snapshots: Map<string, number> } };
const state = globalWechat.lumaflowWechat ??= { connections: new Map(), snapshots: new Map() };
function prune() {
  for (const [id, item] of state.connections) if (item.expires < Date.now()) state.connections.delete(id);
  for (const [id, expires] of state.snapshots) if (expires < Date.now()) state.snapshots.delete(id);
}
async function desktop(action: "probe" | "connect" | "read", extra: string[] = []) {
  if (process.platform !== "win32") return wechatProbeSchema.parse({ state: "windows_required", canRead: false, running: false, windows: [] });
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(process.cwd(), "scripts", "wechat-desktop.ps1"), "-Action", action, ...extra], { timeout: 12_000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8" }, (error, output) => error ? reject(error) : resolve(output));
      // Windows PowerShell can wait on an inherited pipe even with -File and
      // -NonInteractive. Close stdin so a hidden desktop probe terminates.
      child.stdin?.end();
    });
    return wechatProbeSchema.parse(JSON.parse(stdout.replace(/^\uFEFF/, "").trim()));
  } catch { throw new ApiHttpError(503, "WECHAT_PROBE_FAILED", "微信桌面检测失败或超时，请保持微信已登录且会话窗口可见后重试。"); }
}
export async function detectWechat() { return desktop("probe"); }
export async function connectWechat(processId: number) {
  prune();
  const result = await desktop("connect", ["-ProcessId", String(processId)]);
  if (!result.canRead || !result.chatFingerprint) throw new ApiHttpError(409, "WECHAT_NOT_READY", `微信进程存在，但当前会话尚不可读（${result.state}）。请登录并在微信中选择要分析的聊天。`);
  if (state.connections.size >= 20) throw new ApiHttpError(429, "WECHAT_CONNECTION_LIMIT", "连接过多，请断开旧连接或稍后重试。");
  const connectionId = randomUUID();
  state.connections.set(connectionId, { processId, fingerprint: result.chatFingerprint, expires: Date.now() + TTL });
  return { connectionId, chatLabel: result.chatLabel!, loadedItems: result.loadedItems ?? 0, version: result.version, state: "connected-readonly" };
}
export function disconnectWechat(connectionId: string) { state.connections.delete(connectionId); }
export async function readWechat(connectionId: string, limit: number): Promise<WechatSnapshot> {
  prune();
  const connection = state.connections.get(connectionId);
  if (!connection) throw new ApiHttpError(409, "WECHAT_CONNECTION_EXPIRED", "微信连接已过期，请重新连接并确认当前会话。");
  const result = await desktop("read", ["-ProcessId", String(connection.processId), "-ExpectedChat", connection.fingerprint, "-Limit", String(limit)]);
  if (!result.canRead || !result.entries || result.chatFingerprint !== connection.fingerprint) {
    state.connections.delete(connectionId);
    throw new ApiHttpError(409, "WECHAT_CHAT_CHANGED", "微信会话已切换或无法读取，请重新连接并确认聊天；本次未导入记录。");
  }
  const id = randomUUID();
  // Only an expiring ID is retained server-side; never log or persist chat text.
  if (state.snapshots.size >= 100) throw new ApiHttpError(429, "WECHAT_SNAPSHOT_LIMIT", "读取次数过多，请稍后重试。");
  state.snapshots.set(id, Date.now() + TTL);
  return { id, chatLabel: result.chatLabel!, capturedAt: new Date().toISOString(), loadedItems: result.loadedItems ?? 0, entries: result.entries };
}
export function authorizeWechatModel(snapshotId: string, modelProfileId: string) {
  prune();
  if (!state.snapshots.has(snapshotId)) throw new ApiHttpError(409, "WECHAT_SNAPSHOT_EXPIRED", "微信快照已过期，请重新读取并检查后发送。");
  if (!["local-qwen3-8b", "local-qwen3-14b"].includes(modelProfileId)) throw new ApiHttpError(403, "WECHAT_LOCAL_MODEL_ONLY", "实时微信记录仅允许交给本机 8B / 14B 模型，不会发往自定义服务。");
}
