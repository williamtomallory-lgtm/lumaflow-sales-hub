import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiHttpError, authorizeAssistantRequest } from "./api-security";
import { getCalendarViewer } from "./calendar-auth";
import type { CalendarViewer } from "./calendar-store";

const tokenLifetimeMs = 8 * 60 * 60 * 1000;
const tokenPayloadSchema = z.object({
  version: z.literal(1),
  origin: z.string(),
  viewer: z.object({ id: z.string().min(1), email: z.email(), name: z.string().min(1) }),
  expiresAt: z.number().int(),
}).strict();

function signingKey() {
  const secret = process.env.WORK_PAIRING_SIGNING_KEY;
  if (!secret || Buffer.byteLength(secret) < 32) throw new ApiHttpError(503, "CALENDAR_CONNECT_UNAVAILABLE", "云端日历连接尚未配置。");
  return createHmac("sha256", secret).update("lumaflow-calendar-browser-v1").digest();
}

export function localCalendarOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.origin !== value || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    const allowed = (process.env.CALENDAR_LOCAL_ORIGINS || "http://127.0.0.1:3000,http://localhost:3000").split(",").map((item) => item.trim());
    if (!allowed.includes(value)) return null;
    return value;
  } catch { return null; }
}

function signature(payload: string) {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function issueCalendarBrowserToken(viewer: CalendarViewer, origin: string) {
  if (!localCalendarOrigin(origin)) throw new ApiHttpError(403, "CALENDAR_ORIGIN_DENIED", "只允许连接本机打开的 LumaFlow 页面。");
  const expiresAt = Date.now() + tokenLifetimeMs;
  const payload = Buffer.from(JSON.stringify(tokenPayloadSchema.parse({ version: 1, origin, viewer, expiresAt }))).toString("base64url");
  return { token: `${payload}.${signature(payload)}`, expiresAt };
}

export function verifyCalendarBrowserToken(token: string, origin: string): CalendarViewer {
  if (!localCalendarOrigin(origin)) throw new ApiHttpError(403, "CALENDAR_ORIGIN_DENIED", "日历连接来源不受信任。");
  const [payload, receivedSignature, extra] = token.split(".");
  if (!payload || !receivedSignature || extra || payload.length > 2_000) throw new ApiHttpError(401, "CALENDAR_TOKEN_INVALID", "日历连接已失效，请重新连接。");
  const received = Buffer.from(receivedSignature, "base64url");
  const expected = Buffer.from(signature(payload), "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new ApiHttpError(401, "CALENDAR_TOKEN_INVALID", "日历连接已失效，请重新连接。");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw new ApiHttpError(401, "CALENDAR_TOKEN_INVALID", "日历连接已失效，请重新连接。"); }
  const parsed = tokenPayloadSchema.safeParse(value);
  if (!parsed.success || parsed.data.origin !== origin || parsed.data.expiresAt <= Date.now() || parsed.data.expiresAt > Date.now() + tokenLifetimeMs) {
    throw new ApiHttpError(401, "CALENDAR_TOKEN_INVALID", "日历连接已失效，请重新连接。");
  }
  return parsed.data.viewer;
}

export async function getCalendarRequestViewer(request: Request, write = false): Promise<CalendarViewer> {
  const origin = localCalendarOrigin(request.headers.get("origin"));
  if (origin && process.env.VERCEL === "1") {
    const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new ApiHttpError(401, "CALENDAR_CONNECT_REQUIRED", "请先连接云端协作日历。");
    return verifyCalendarBrowserToken(token, origin);
  }
  if (write) authorizeAssistantRequest(request);
  return getCalendarViewer();
}

export function calendarCorsHeaders(request: Request): Record<string, string> {
  const origin = localCalendarOrigin(request.headers.get("origin"));
  return origin && process.env.VERCEL === "1" ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  } : {};
}

export function calendarOptions(request: Request) {
  const headers = calendarCorsHeaders(request);
  return Object.keys(headers).length ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 });
}
