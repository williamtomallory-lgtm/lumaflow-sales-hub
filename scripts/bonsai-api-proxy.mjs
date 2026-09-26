import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.BONSAI_PROXY_PORT || 8082);
const token = process.env.BONSAI_PROXY_TOKEN?.trim() || "";
const upstream = "http://127.0.0.1:8081";
const maxBodyBytes = 4 * 1024 * 1024;
const rateWindowMs = 60_000;
const maxChatsPerWindow = 12;

if (token.length < 32) {
  throw new Error("BONSAI_PROXY_TOKEN must contain at least 32 characters.");
}

const expectedToken = Buffer.from(token);
const chatRequests = [];
let activeChats = 0;

function isAuthorized(request) {
  const authorization = request.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return false;
  const supplied = Buffer.from(match[1]);
  return supplied.length === expectedToken.length && timingSafeEqual(supplied, expectedToken);
}

function reply(response, status, message) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify({ error: { message } }));
}

async function readBoundedBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new RangeError("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function writeChunk(response, chunk) {
  if (response.destroyed) throw new Error("Client disconnected.");
  if (response.write(Buffer.from(chunk))) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("Client disconnected.")); };
    response.once("drain", onDrain);
    response.once("close", onClose);
  });
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url || "/", "http://localhost").pathname;
  const isModelsRequest = request.method === "GET" && path === "/v1/models";
  const isChatRequest = request.method === "POST" && path === "/v1/chat/completions";

  if (!isModelsRequest && !isChatRequest) {
    reply(response, 404, "Not found.");
    return;
  }
  if (!isAuthorized(request)) {
    reply(response, 401, "Unauthorized.");
    return;
  }

  if (isChatRequest) {
    const now = Date.now();
    while (chatRequests.length && chatRequests[0] <= now - rateWindowMs) chatRequests.shift();
    if (chatRequests.length >= maxChatsPerWindow || activeChats >= 1) {
      reply(response, 429, "The local Bonsai runtime is busy. Please retry shortly.");
      return;
    }
    chatRequests.push(now);
    activeChats += 1;
  }

  let body;
  try {
    body = isChatRequest ? await readBoundedBody(request) : undefined;
  } catch (error) {
    if (isChatRequest) activeChats -= 1;
    reply(response, error instanceof RangeError ? 413 : 400, error instanceof RangeError ? "Request body is too large." : "Invalid request body.");
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 295_000);
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  try {
    const upstreamResponse = await fetch(`${upstream}${path}`, {
      method: request.method,
      headers: isChatRequest ? { "content-type": request.headers["content-type"] || "application/json" } : undefined,
      body,
      signal: controller.signal,
      redirect: "error",
    });

    response.writeHead(upstreamResponse.status, {
      "cache-control": "no-store",
      "content-type": upstreamResponse.headers.get("content-type") || "application/json",
      "x-content-type-options": "nosniff",
    });
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        await writeChunk(response, chunk);
      }
    }
    response.end();
  } catch {
    if (!response.headersSent) reply(response, 502, "The local Bonsai runtime is unavailable.");
    else response.destroy();
  } finally {
    clearTimeout(timeout);
    if (isChatRequest) activeChats -= 1;
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Bonsai API proxy listening on http://${host}:${port}\n`);
});
