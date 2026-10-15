import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ApiHttpError, authorizeAssistantRequest, authorizeLocalKnowledgeRead } from "./api-security";
import { getModelConfig, getModelOptions } from "../ai/model-config";
import type { WorkEngineSection, WorkEngineStatus } from "../contracts/work-engine";

const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const configSchema = z.object({
  version: z.string(), baseUrl: z.string().url().default("http://127.0.0.1:8088"),
  ownerId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  ownerUsername: z.string().min(1), jwtSecret: z.string().min(32), jwtSecretEncoding: z.enum(["base64", "utf8"]).default("utf8"), gatewayKey: z.string().min(32),
  gatewayReadKey: z.string().min(32).optional(),
  agentIds: z.object({ work: z.string(), researcher: z.string(), verifier: z.string(), team: z.string() }),
}).passthrough();
export type WorkEngineConfig = z.infer<typeof configSchema>;

export function authorizeWorkEngineBrowser(request: Request, write = false) {
  if (process.env.VERCEL === "1" || !localHosts.has(new URL(request.url).hostname)) throw new ApiHttpError(403, "LOCAL_WORK_ONLY", "能力中心在你的本机 Work 中运行。请打开远程电脑上的本机网站。");
  authorizeLocalKnowledgeRead(request);
  if (write) authorizeAssistantRequest(request);
}

export async function readWorkEngineConfig(): Promise<WorkEngineConfig | null> {
  const testFile = process.env.NODE_ENV === "test" ? process.env.LUMAFLOW_WORK_ENGINE_TEST_FILE : undefined;
  try {
    const value = JSON.parse(await readFile(testFile || path.join(process.cwd(), ".local-data", "octop", "lumaflow.json"), "utf8"));
    const config = configSchema.parse(value);
    const url = new URL(config.baseUrl);
    if (url.protocol !== "http:" || !localHosts.has(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid local engine address");
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ApiHttpError(503, "WORK_ENGINE_CONFIG_INVALID", "本机能力中心配置尚未就绪，请检查引擎启动日志。");
  }
}

export function createWorkEngineToken(config: WorkEngineConfig, ttlSeconds = 600) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: String(config.ownerId), uname: config.ownerUsername, role: "admin", iat: now, exp: now + ttlSeconds })).toString("base64url");
  const secret = Buffer.from(config.jwtSecret, config.jwtSecretEncoding === "base64" ? "base64url" : "utf8");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return { token: `${header}.${payload}.${signature}`, expiresAt: new Date((now + ttlSeconds) * 1000).toISOString() };
}

export async function authorizeWorkEngineGateway(request: Request) {
  if (process.env.VERCEL === "1" || !localHosts.has(new URL(request.url).hostname)) throw new ApiHttpError(403, "LOCAL_MODEL_REQUIRED", "本机模型网关仅供本机引擎使用。");
  const config = await readWorkEngineConfig();
  if (!config) throw new ApiHttpError(503, "WORK_ENGINE_NOT_INSTALLED", "本机能力中心尚未安装。");
  const received = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "");
  const matches = (expectedValue: string | undefined) => {
    const expected = Buffer.from(expectedValue || "");
    return expected.length >= 32 && received.length === expected.length && timingSafeEqual(received, expected);
  };
  if (matches(config.gatewayKey)) return { ...config, readOnly: false };
  if (matches(config.gatewayReadKey)) return { ...config, readOnly: true };
  throw new ApiHttpError(401, "GATEWAY_AUTH_REQUIRED", "模型网关凭据无效。");
}

export async function workEngineJson(endpoint: string, init: RequestInit = {}) {
  const config = await readWorkEngineConfig();
  if (!config) throw new ApiHttpError(503, "WORK_ENGINE_NOT_INSTALLED", "本机能力中心尚未安装。");
  if (!/^\/api\/[a-z0-9_/?=&.%-]+$/i.test(endpoint)) throw new Error("Invalid engine endpoint");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${createWorkEngineToken(config).token}`);
  headers.set("accept-language", "zh");
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${endpoint}`, { ...init, headers, cache: "no-store", signal: init.signal || AbortSignal.timeout(8000) });
  if (!response.ok) throw new ApiHttpError(503, "WORK_ENGINE_UNAVAILABLE", "本机能力中心暂时不可用，请重试。");
  return await response.json() as unknown;
}

const definitions: Omit<WorkEngineSection, "availability">[] = [
  { id: "chat", label: "专家执行", path: "/chat", detail: "调用完整工具与技能执行任务，保留会话和执行轨迹。" },
  { id: "experts", label: "专家库", path: "/experts", detail: "创建专属专家，设置人格、工作区、工具、模型和知识库。" },
  { id: "teams", label: "专家团队", path: "/experts", detail: "主持人派工、成员独立执行、群聊回传和任务汇总。" },
  { id: "memory", label: "长期记忆", path: "/personalization/memory", detail: "按专家查看、检索、维护和迁移工作区记忆。" },
  { id: "skills", label: "技能", path: "/skill-packages", detail: "管理技能包与子智能体资源，绑定给专家使用。" },
  { id: "plugins", label: "插件", path: "/admin/plugins", detail: "管理内置与第三方插件；按需启用。" },
  { id: "schedules", label: "定时任务", path: "/tasks", detail: "创建定时和周期任务，查看运行结果与下一次执行时间。" },
  { id: "connectors", label: "连接器", path: "/connectors", detail: "连接腾讯文档、邮箱、Notion 等服务，或配置自定义 MCP。外部账号需授权。" },
  { id: "knowledge", label: "知识库", path: "/knowledge-bases", detail: "导入文档、检索私有知识、共享语料并绑定专家。" },
  { id: "browser", label: "浏览器", path: "/workbench/browser", detail: "在本机 Chromium 中浏览、截图、操作网页和管理持久会话。" },
  { id: "terminal", label: "终端", path: "/workbench/terminal", detail: "交互式终端与 AI 辅助命令执行；遵循引擎的工具审批规则。" },
  { id: "desktop", label: "桌面控制", path: "/remote-desktop", detail: "查看并控制引擎所在电脑的桌面。" },
  { id: "acp", label: "编程助手", path: "/acp", detail: "配置 Codex、Claude Code、OpenCode 等 Runner；对应程序需安装和登录。" },
  { id: "channels", label: "消息通道", path: "/personalization/channels", detail: "绑定微信、企业微信、飞书、钉钉、QQ 等通道。需要相应账号凭据。" },
  { id: "models", label: "模型", path: "/admin/models", detail: "选择本地模型并配置其他供应商；本地网关管理显存切换。" },
  { id: "users", label: "用户和权限", path: "/admin/users", detail: "管理本机用户、角色和授权。" },
  { id: "settings", label: "设置", path: "/admin/advanced", detail: "配置工具审批、运行限制、存储、共享和服务器。" },
  { id: "backup", label: "备份迁移", path: "/admin/backend", detail: "备份和迁移专家、记忆、技能、知识和定时任务。" },
];

export async function getWorkEngineStatus(): Promise<WorkEngineStatus> {
  const config = await readWorkEngineConfig();
  let connected = false;
  if (config) {
    try { await workEngineJson("/api/auth/me"); connected = true; } catch { /* The saved configuration alone is not a live connection. */ }
  }
  const models = (await getModelOptions()).filter((model) => {
    try { return model.configured && localHosts.has(new URL(getModelConfig(model.id).baseURL || "").hostname); } catch { return false; }
  }).map(({ id, label, reachable }) => ({ id, label, reachable }));
  return {
    connected, installed: Boolean(config), version: config?.version ?? null, baseUrl: config?.baseUrl || "http://127.0.0.1:8088",
    agentIds: config?.agentIds || { work: "", researcher: "", verifier: "", team: "" }, models,
    sections: definitions.map((section) => ({ ...section, availability: connected ? "available" : "offline" })),
    message: connected ? "完整本机引擎已连接。外部账号、编程助手和消息通道可在对应页面配置。" : config ? "引擎配置已保存，服务尚未连接。" : "尚未安装本机能力中心。",
    typesafe: { configured: Boolean(process.env.TYPESAFE_API_KEY?.trim()), enabled: process.env.TYPESAFE_WORK_ROUTING === "true" },
  };
}
