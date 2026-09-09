import "server-only";

import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { ApiHttpError } from "./api-security";
import type { CowAgentWeixinState } from "../contracts/cowagent-weixin";
import type { CowAgentWecomState } from "../contracts/cowagent-wecom";
import type { CowAgentProfile, CowAgentRoster } from "../contracts/cowagent-agent";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_RESPONSE_BYTES = 1_500_000;

type CowAgentChannelInstance = {
  instance_id?: unknown;
  channel_type?: unknown;
  agent_id?: unknown;
  active?: unknown;
  login_status?: unknown;
  fields?: unknown;
};

function baseUrl() {
  let url: URL;
  try {
    url = new URL(process.env.COWAGENT_BASE_URL?.trim() || "http://127.0.0.1:9876");
  } catch {
    throw new ApiHttpError(503, "COWAGENT_CONFIG_INVALID", "CowAgent 后端地址配置无效。");
  }
  const remoteAllowed = process.env.COWAGENT_ALLOW_REMOTE === "true";
  const allowedProtocol = LOOPBACK_HOSTS.has(url.hostname) ? url.protocol === "http:" || url.protocol === "https:" : remoteAllowed && url.protocol === "https:";
  if (!allowedProtocol || url.username || url.password || url.search || url.hash) {
    throw new ApiHttpError(503, "COWAGENT_CONFIG_INVALID", "CowAgent 后端地址不符合本地安全策略。");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function cowAgentHeaders(includeJson = false) {
  const headers = new Headers({ Accept: "application/json" });
  if (includeJson) headers.set("content-type", "application/json");
  const token = process.env.COWAGENT_WEB_AUTH_TOKEN?.trim();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

type CowAgentRequestInit = Omit<RequestInit, "body"> & { body?: string | Buffer };

async function cowAgentJson(path: string, init?: CowAgentRequestInit, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  try {
    const response = await cowAgentRaw(path, init, timeoutMs, MAX_RESPONSE_BYTES);
    const raw = response.body.toString("utf8");
    let payload: unknown;
    try { payload = JSON.parse(raw); }
    catch { throw new ApiHttpError(502, "COWAGENT_BAD_RESPONSE", "CowAgent 返回了无法识别的响应。"); }
    if (response.status < 200 || response.status >= 300 || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ApiHttpError(response.status === 401 ? 503 : 502, "COWAGENT_UNAVAILABLE", "CowAgent 后端暂时不可用。");
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiHttpError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiHttpError(504, "COWAGENT_TIMEOUT", "CowAgent 后端响应超时。");
    }
    throw new ApiHttpError(503, "COWAGENT_UNAVAILABLE", "CowAgent 后端尚未连接。");
  }
}

type CowAgentRawResponse = { status: number; headers: Headers; body: Buffer };

function cowAgentRaw(path: string, init: CowAgentRequestInit = {}, timeoutMs = 15_000, maxBytes = MAX_RESPONSE_BYTES): Promise<CowAgentRawResponse> {
  const url = new URL(path.replace(/^\/+/, ""), baseUrl());
  const headers = new Headers(init.headers ?? cowAgentHeaders(Boolean(init.body)));
  const body = Buffer.isBuffer(init.body) ? init.body : typeof init.body === "string" ? Buffer.from(init.body, "utf8") : Buffer.alloc(0);
  if (body.byteLength && !headers.has("content-length")) headers.set("content-length", String(body.byteLength));
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: init.method || "GET",
      headers: Object.fromEntries(headers.entries()),
    }, (response) => {
      const declared = Number(response.headers["content-length"] || 0);
      if (declared > maxBytes) {
        response.destroy();
        settled = true;
        reject(new ApiHttpError(502, "COWAGENT_RESPONSE_TOO_LARGE", "CowAgent 返回内容过大。"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBytes) {
          response.destroy();
          if (!settled) {
            settled = true;
            reject(new ApiHttpError(502, "COWAGENT_RESPONSE_TOO_LARGE", "CowAgent 返回内容过大。"));
          }
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, item));
          else if (value !== undefined) responseHeaders.set(key, String(value));
        }
        resolve({ status: response.statusCode || 502, headers: responseHeaders, body: Buffer.concat(chunks) });
      });
    });
    request.setTimeout(timeoutMs, () => {
      const error = new Error("CowAgent request timed out");
      error.name = "AbortError";
      request.destroy(error);
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    if (body.byteLength) request.write(body);
    request.end();
  });
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function publicAgentError(message: string) {
  if (/already exists/i.test(message)) return "这个智能体 ID 已存在，请换一个 ID。";
  if (/agent id|URL-safe/i.test(message)) return "智能体 ID 只能包含英文字母、数字、下划线或短横线。";
  if (/name/i.test(message)) return "请填写有效的智能体名称。";
  if (/stale/i.test(message)) return "智能体列表已变化，请刷新后重试。";
  if (/workspace/i.test(message)) return "CowAgent 无法创建智能体工作目录，请检查本地数据目录。";
  return "CowAgent 创建智能体失败。";
}

function parseAgent(value: unknown): CowAgentProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = asString(item.id);
  const name = asString(item.name);
  const workspace = asString(item.workspace);
  if (!id || !name || !workspace) return null;
  const knowledgeMode = item.knowledge_mode === "own" ? "own" : "shared";
  return {
    id,
    name,
    workspace,
    enabled: item.enabled !== false,
    knowledgeMode,
    ...(asString(item.description) ? { description: asString(item.description) } : {}),
    ...(asString(item.model) ? { model: asString(item.model) } : {}),
    ...(asString(item.bot_type) ? { botType: asString(item.bot_type) } : {}),
    ...(asString(item.avatar) ? { avatar: asString(item.avatar) } : {}),
    ...(asString(item.avatar_rev) ? { avatarRev: asString(item.avatar_rev) } : {}),
  };
}

export async function getCowAgentRoster(): Promise<CowAgentRoster> {
  const payload = await cowAgentJson("api/agents", { headers: cowAgentHeaders() }, 8_000);
  if (payload.status !== "success") throw new ApiHttpError(502, "COWAGENT_AGENTS_FAILED", "无法读取 CowAgent 智能体列表。");
  return {
    agents: (Array.isArray(payload.agents) ? payload.agents : []).flatMap((item) => {
      const parsed = parseAgent(item);
      return parsed ? [parsed] : [];
    }),
    defaultAgentId: asString(payload.default_agent_id),
    revision: asString(payload.revision),
  };
}

export async function createCowAgentProfile(input: {
  id: string;
  name: string;
  description: string;
  cloneFrom: string | null;
  knowledgeMode: "shared" | "own";
  agentType: "weixin_personal" | "wecom_group";
  revision?: string;
}): Promise<CowAgentRoster> {
  const payload = await cowAgentJson("api/agents", {
    method: "POST",
    headers: cowAgentHeaders(true),
    body: JSON.stringify({
      action: "create",
      id: input.id,
      name: input.name,
      description: input.description,
      clone_from: input.cloneFrom,
      knowledge_mode: input.knowledgeMode,
      bot_type: input.agentType,
      ...(input.revision ? { revision: input.revision } : {}),
    }),
  }, 30_000);
  if (payload.status !== "success") {
    throw new ApiHttpError(payload.code === "stale_roster" ? 409 : 422, "COWAGENT_CREATE_FAILED", publicAgentError(asString(payload.message)));
  }
  return getCowAgentRoster();
}

export async function uploadCowAgentAvatar(agentId: string, file: File): Promise<void> {
  try {
    const boundary = `lumaflow-${randomUUID()}`;
    const safeName = file.name.replace(/[\r\n"]/g, "_");
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="${safeName}"\r\nContent-Type: ${file.type || "application/octet-stream"}\r\n\r\n`, "utf8");
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([head, Buffer.from(await file.arrayBuffer()), tail]);
    const headers = cowAgentHeaders();
    headers.set("content-type", `multipart/form-data; boundary=${boundary}`);
    const response = await cowAgentRaw(`api/agents/${encodeURIComponent(agentId)}/avatar`, { method: "POST", headers, body }, 20_000, 2_500_000);
    const payload = JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
    if (response.status < 200 || response.status >= 300 || payload.status !== "success") throw new ApiHttpError(422, "COWAGENT_AVATAR_FAILED", "头像上传失败；智能体已成功创建，可稍后再设置头像。");
  } catch (error) {
    if (error instanceof ApiHttpError) throw error;
    throw new ApiHttpError(503, "COWAGENT_AVATAR_FAILED", "头像上传失败；智能体已成功创建，可稍后再设置头像。");
  }
}

export async function readCowAgentAvatar(agentId: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  try {
    const response = await cowAgentRaw(`api/agents/${encodeURIComponent(agentId)}/avatar`, { headers: cowAgentHeaders() }, 10_000, 2 * 1024 * 1024);
    if (response.status < 200 || response.status >= 300) throw new ApiHttpError(404, "AVATAR_NOT_FOUND", "头像不存在。");
    const bytes = new Uint8Array(response.body);
    if (bytes.byteLength > 2 * 1024 * 1024) throw new ApiHttpError(404, "AVATAR_NOT_FOUND", "头像不存在。");
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(contentType)) throw new ApiHttpError(502, "AVATAR_INVALID", "CowAgent 返回了无效头像。");
    return { bytes, contentType };
  } catch (error) {
    if (error instanceof ApiHttpError) throw error;
    throw new ApiHttpError(503, "COWAGENT_UNAVAILABLE", "CowAgent 后端尚未连接。");
  }
}

export async function getCowAgentWeixinState(agentId: string, instanceId: string): Promise<CowAgentWeixinState> {
  const payload = await cowAgentJson("api/channels", { headers: cowAgentHeaders() }, 5_000);
  const instances = Array.isArray(payload.instances) ? payload.instances as CowAgentChannelInstance[] : [];
  const instance = instances.find((item) => item.instance_id === instanceId && item.channel_type === "weixin");
  const loginStatus = asString(instance?.login_status);
  const active = instance?.active === true;
  const connected = active && (!loginStatus || loginStatus === "logged_in");
  return {
    engine: "CowAgent",
    phase: connected ? "connected" : "idle",
    active,
    instanceId,
    ...(asString(instance?.agent_id) ? { boundAgentId: asString(instance?.agent_id) } : {}),
    ...(loginStatus ? { loginStatus } : {}),
  };
}

export async function createCowAgentWeixinQr(agentId: string, instanceId: string): Promise<CowAgentWeixinState> {
  const query = new URLSearchParams({ agent_id: agentId, instance_id: instanceId });
  const payload = await cowAgentJson(`api/weixin/qrlogin?${query}`, { headers: cowAgentHeaders() }, 20_000);
  if (payload.status !== "success") throw new ApiHttpError(502, "WEIXIN_QR_FAILED", "微信登录二维码生成失败。");
  const qrImage = asString(payload.qr_image);
  const qrUrl = asString(payload.qrcode_url);
  if (!qrImage && !qrUrl) throw new ApiHttpError(502, "WEIXIN_QR_MISSING", "CowAgent 没有返回微信登录二维码。");
  return { engine: "CowAgent", phase: "waiting", active: false, instanceId, boundAgentId: agentId, ...(qrImage ? { qrImage } : {}), ...(qrUrl ? { qrUrl } : {}) };
}

export async function pollCowAgentWeixinQr(agentId: string, instanceId: string): Promise<CowAgentWeixinState> {
  const payload = await cowAgentJson("api/weixin/qrlogin", {
    method: "POST",
    headers: cowAgentHeaders(true),
    body: JSON.stringify({ action: "poll", agent_id: agentId, instance_id: instanceId }),
  }, 20_000);
  if (payload.status !== "success") throw new ApiHttpError(502, "WEIXIN_POLL_FAILED", "微信登录状态读取失败。");
  const status = asString(payload.qr_status);
  if (status === "confirmed") {
    return { engine: "CowAgent", phase: "connected", active: true, loginStatus: "starting", boundAgentId: agentId, instanceId };
  }
  const qrImage = asString(payload.qr_image);
  const qrUrl = asString(payload.qrcode_url);
  return {
    engine: "CowAgent",
    phase: status === "scaned" || status === "scanned" ? "scanned" : "waiting",
    active: false,
    instanceId,
    boundAgentId: agentId,
    loginStatus: status || "waiting",
    ...(qrImage ? { qrImage } : {}),
    ...(qrUrl ? { qrUrl } : {}),
  };
}

export async function disconnectCowAgentWeixin(agentId: string, instanceId: string): Promise<CowAgentWeixinState> {
  const current = await getCowAgentWeixinState(agentId, instanceId);
  if (current.boundAgentId && current.boundAgentId !== agentId) {
    throw new ApiHttpError(409, "WEIXIN_BOUND_TO_OTHER_AGENT", "这个微信账号当前绑定在另一个智能体上，请从对应智能体卡片停止连接。");
  }
  const payload = await cowAgentJson("api/channels", {
    method: "POST",
    headers: cowAgentHeaders(true),
    body: JSON.stringify({ action: "disconnect", channel: "weixin", instance_id: instanceId, config: {} }),
  }, 10_000);
  if (payload.status !== "success") throw new ApiHttpError(502, "WEIXIN_STOP_FAILED", "微信 Agent 停止失败。");
  return { engine: "CowAgent", phase: "idle", active: false, instanceId };
}

function parseInstanceFields(value: unknown) {
  const result = new Map<string, unknown>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const field = item as Record<string, unknown>;
    const key = asString(field.key);
    if (key) result.set(key, field.value);
  }
  return result;
}

export async function getCowAgentWecomState(agentId: string, instanceId: string): Promise<CowAgentWecomState> {
  const [payload, recipientPayload, taskPayload] = await Promise.all([
    cowAgentJson("api/channels", { headers: cowAgentHeaders() }, 5_000),
    cowAgentJson("api/scheduler/recipients", { headers: cowAgentHeaders() }, 5_000),
    cowAgentJson(`api/scheduler?agent_id=${encodeURIComponent(agentId)}`, { headers: cowAgentHeaders() }, 5_000),
  ]);
  const instances = Array.isArray(payload.instances) ? payload.instances as CowAgentChannelInstance[] : [];
  const instance = instances.find((item) => item.instance_id === instanceId && item.channel_type === "wecom_bot");
  const fields = parseInstanceFields(instance?.fields);
  const keywordValue = fields.get("wecom_group_keywords");
  const keywords = typeof keywordValue === "string" ? keywordValue.split(",").map((item) => item.trim()).filter(Boolean) : [];
  const recipients = (Array.isArray(recipientPayload.recipients) ? recipientPayload.recipients : []).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (asString(item.instance_id) !== instanceId || item.is_group !== true || !asString(item.receiver)) return [];
    return [{ receiver: asString(item.receiver), name: asString(item.name) || asString(item.receiver), isGroup: true }];
  });
  const tasks = (Array.isArray(taskPayload.tasks) ? taskPayload.tasks : []).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const action = item.action && typeof item.action === "object" && !Array.isArray(item.action) ? item.action as Record<string, unknown> : {};
    if (asString(action.instance_id) !== instanceId || !asString(item.id)) return [];
    return [{ id: asString(item.id), name: asString(item.name) || asString(item.id), enabled: item.enabled === true, ...(asString(item.next_run_at) ? { nextRunAt: asString(item.next_run_at) } : {}) }];
  });
  return {
    engine: "CowAgent",
    instanceId,
    boundAgentId: asString(instance?.agent_id) || agentId,
    active: instance?.active === true,
    ...(asString(instance?.login_status) ? { loginStatus: asString(instance?.login_status) } : {}),
    keywordEnabled: fields.get("wecom_group_keywords_enabled") === true,
    keywords,
    recipients,
    tasks,
  };
}

export async function connectCowAgentWecom(input: {
  agentId: string;
  instanceId: string;
  botId: string;
  botSecret: string;
  keywordEnabled: boolean;
  keywords: string[];
}): Promise<CowAgentWecomState> {
  const payload = await cowAgentJson("api/channels", {
    method: "POST",
    headers: cowAgentHeaders(true),
    body: JSON.stringify({
      action: "connect",
      channel: "wecom_bot",
      instance_id: input.instanceId,
      agent_id: input.agentId,
      config: {
        wecom_bot_id: input.botId,
        wecom_bot_secret: input.botSecret,
        wecom_group_keywords_enabled: input.keywordEnabled,
        wecom_group_keywords: input.keywords.join(","),
      },
    }),
  }, 20_000);
  if (payload.status !== "success") throw new ApiHttpError(422, "WECOM_CONNECT_FAILED", "企业微信机器人连接失败，请检查 Bot ID 与 Secret。");
  return { engine: "CowAgent", instanceId: input.instanceId, boundAgentId: input.agentId, active: true, loginStatus: "starting", keywordEnabled: input.keywordEnabled, keywords: input.keywords, recipients: [], tasks: [] };
}

export async function disconnectCowAgentWecom(agentId: string, instanceId: string): Promise<CowAgentWecomState> {
  const current = await getCowAgentWecomState(agentId, instanceId);
  if (current.boundAgentId && current.boundAgentId !== agentId) throw new ApiHttpError(409, "WECOM_BOUND_TO_OTHER_AGENT", "这个企微机器人属于另一个智能体。");
  const payload = await cowAgentJson("api/channels", {
    method: "POST",
    headers: cowAgentHeaders(true),
    body: JSON.stringify({ action: "disconnect", channel: "wecom_bot", instance_id: instanceId, config: {} }),
  }, 10_000);
  if (payload.status !== "success") throw new ApiHttpError(502, "WECOM_STOP_FAILED", "企业微信机器人停止失败。");
  return { engine: "CowAgent", instanceId, boundAgentId: agentId, active: false, keywordEnabled: false, keywords: [], recipients: [], tasks: [] };
}

export async function updateCowAgentWecomPolicy(input: { agentId: string; instanceId: string; keywordEnabled: boolean; keywords: string[] }): Promise<CowAgentWecomState> {
  const payload = await cowAgentJson("api/channels", {
    method: "POST",
    headers: cowAgentHeaders(true),
    body: JSON.stringify({
      action: "save", channel: "wecom_bot", instance_id: input.instanceId,
      config: { wecom_group_keywords_enabled: input.keywordEnabled, wecom_group_keywords: input.keywords.join(",") },
    }),
  }, 10_000);
  if (payload.status !== "success") throw new ApiHttpError(422, "WECOM_POLICY_FAILED", "群聊关键词设置保存失败。");
  return getCowAgentWecomState(input.agentId, input.instanceId);
}

export async function createCowAgentWecomTask(input: {
  agentId: string; instanceId: string; name: string; receiver: string; content: string; enabled: boolean;
  schedule: { type: "once"; runAt: string } | { type: "cron"; expression: string } | { type: "interval"; seconds: number };
}): Promise<CowAgentWecomState> {
  const schedule = input.schedule.type === "once" ? { type: "once", run_at: input.schedule.runAt }
    : input.schedule.type === "cron" ? { type: "cron", expression: input.schedule.expression }
      : { type: "interval", seconds: input.schedule.seconds };
  const payload = await cowAgentJson("api/scheduler/create", {
    method: "POST", headers: cowAgentHeaders(true),
    body: JSON.stringify({
      name: input.name, enabled: input.enabled, schedule,
      action: { type: "send_message", content: input.content, receiver: input.receiver, channel_type: "wecom_bot", instance_id: input.instanceId },
    }),
  }, 10_000);
  if (payload.status !== "success") throw new ApiHttpError(422, "WECOM_TASK_FAILED", asString(payload.message) === "recipient is not in the trusted directory" ? "请先在目标群里 @ 一次机器人，再创建定时任务。" : "企业微信定时任务创建失败。");
  return getCowAgentWecomState(input.agentId, input.instanceId);
}

export async function toggleCowAgentWecomTask(agentId: string, instanceId: string, taskId: string, enabled: boolean): Promise<CowAgentWecomState> {
  const payload = await cowAgentJson("api/scheduler/toggle", {
    method: "POST", headers: cowAgentHeaders(true),
    body: JSON.stringify({ task_id: taskId, agent_id: agentId, enabled }),
  }, 10_000);
  if (payload.status !== "success") throw new ApiHttpError(422, "WECOM_TASK_TOGGLE_FAILED", "企业微信定时任务状态更新失败。");
  return getCowAgentWecomState(agentId, instanceId);
}
