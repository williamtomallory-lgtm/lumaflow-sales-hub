import "server-only";

import { randomUUID, timingSafeEqual } from "node:crypto";
import { ZodError, type ZodType } from "zod";
import type { ApiErrorBody } from "../contracts/api";

const MAX_JSON_BYTES = 256 * 1024;
const globalRateLimit = globalThis as typeof globalThis & { lumaflowRateLimit?: Map<string, { count: number; resetAt: number }> };
const rateLimitStore = globalRateLimit.lumaflowRateLimit ?? new Map<string, { count: number; resetAt: number }>();
globalRateLimit.lumaflowRateLimit = rateLimitStore;

export class ApiHttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export function requestId(request: Request) {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && /^[a-zA-Z0-9._:-]{8,100}$/.test(supplied) ? supplied : randomUUID();
}

export function enforceRateLimit(request: Request, limit = 120, windowMs = 60_000) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const key = `${forwarded || "local"}:${new URL(request.url).pathname}`;
  const now = Date.now();
  const current = rateLimitStore.get(key);
  if (!current || current.resetAt <= now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > limit) throw new ApiHttpError(429, "RATE_LIMITED", "Too many requests. Please retry shortly.");
}

function safeTokenEqual(received: string, expected: string) {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function authorizeWrite(request: Request) {
  const configuredToken = process.env.API_WRITE_TOKEN;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (configuredToken && bearer && safeTokenEqual(bearer, configuredToken)) return;

  if (process.env.DEMO_WRITES_ENABLED !== "true") {
    throw new ApiHttpError(503, "WRITES_DISABLED", "Persistent writes are disabled until authentication or an API write token is configured.");
  }

  const origin = request.headers.get("origin");
  if (!origin) throw new ApiHttpError(403, "ORIGIN_REQUIRED", "A same-origin request is required.");
  const expectedOrigin = new URL(request.url).origin;
  if (origin !== expectedOrigin) throw new ApiHttpError(403, "ORIGIN_DENIED", "Cross-origin writes are not allowed.");
}

export function authorizeAssistantRequest(request: Request) {
  const configuredToken = process.env.ASSISTANT_API_TOKEN;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (configuredToken && bearer && safeTokenEqual(bearer, configuredToken)) return;

  const origin = request.headers.get("origin");
  if (!origin) throw new ApiHttpError(403, "ORIGIN_REQUIRED", "A same-origin assistant request is required.");
  if (origin !== new URL(request.url).origin) {
    throw new ApiHttpError(403, "ORIGIN_DENIED", "Cross-origin model requests are not allowed.");
  }
}

// Private uploaded files have stricter reads than the demo catalog. This is a
// loopback workstation boundary, not multi-user authentication.
export function authorizeLocalKnowledgeRead(request: Request) {
  const configuredToken = process.env.ASSISTANT_API_TOKEN;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (configuredToken && bearer && safeTokenEqual(bearer, configuredToken)) return;
  const url = new URL(request.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new ApiHttpError(403, "LOCAL_ONLY", "知识库目前仅允许本机访问，远程部署前需配置身份权限。");
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if ((origin && origin !== url.origin) || (site && site !== "same-origin")) throw new ApiHttpError(403, "ORIGIN_DENIED", "Cross-origin knowledge access is not allowed.");
  if (origin === url.origin || site === "same-origin") return;
  throw new ApiHttpError(403, "ORIGIN_REQUIRED", "请从本机知识库页面访问文件，或使用已配置的 API token。");
}

export async function readValidatedJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_JSON_BYTES) throw new ApiHttpError(413, "PAYLOAD_TOO_LARGE", "JSON body exceeds 256 KB.");
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_JSON_BYTES) throw new ApiHttpError(413, "PAYLOAD_TOO_LARGE", "JSON body exceeds 256 KB.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ApiHttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiHttpError(422, "VALIDATION_FAILED", "Request data failed validation.", result.error.flatten());
  return result.data;
}

export function apiJson<T>(data: T, status: number, id: string, extraHeaders?: HeadersInit) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": id,
      ...extraHeaders,
    },
  });
}

export function apiError(error: unknown, id: string) {
  const normalized = error instanceof ApiHttpError
    ? error
    : error instanceof ZodError
      ? new ApiHttpError(422, "VALIDATION_FAILED", "Data failed validation.", error.flatten())
      : error instanceof Error && error.name === "ModelNotConfiguredError"
        ? new ApiHttpError(503, "MODEL_NOT_CONFIGURED", error.message)
      : error instanceof Error && error.name === "PersistenceUnavailableError"
        ? new ApiHttpError(503, "PERSISTENCE_UNAVAILABLE", error.message)
        : typeof error === "object" && error !== null && "code" in error && error.code === "23505"
          ? new ApiHttpError(409, "CONFLICT", "A record with the same identifier, SKU, or model already exists.")
      : new ApiHttpError(500, "INTERNAL_ERROR", "The server could not complete the request.");
  if (normalized.status >= 500 && normalized.code === "INTERNAL_ERROR") console.error(`[${id}] API error`, error);
  const body: ApiErrorBody = {
    error: { code: normalized.code, message: normalized.message, ...(normalized.details === undefined ? {} : { details: normalized.details }) },
    meta: { requestId: id },
  };
  return apiJson(body, normalized.status, id);
}
