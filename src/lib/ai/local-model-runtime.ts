import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";
import { ApiHttpError } from "../server/api-security";
import { isManagedLocalModel } from "./model-config";

type RuntimeState = { queue: Promise<unknown>; active: string | null; leases: number };
const runtimeGlobal = globalThis as typeof globalThis & { lumaflowModelRuntime?: RuntimeState };
const state = runtimeGlobal.lumaflowModelRuntime ??= { queue: Promise.resolve(), active: null, leases: 0 };
const services: Record<string, { port: number; model: string }> = {
  configured: { port: 8081, model: "ternary-bonsai-2-27b" },
  "naive-n05-flash-int4-experimental": { port: 8083, model: "naive-n0.5-flash-int4-48l-1e" },
  image: { port: 8084, model: "Qwen/Qwen-Image-2.1" },
};

async function canReuseActive(profile: string) {
  if (state.active !== profile || !services[profile]) return false;
  const target = services[profile];
  try {
    const [health, models, otherServices] = await Promise.all([
      fetch(`http://127.0.0.1:${target.port}/health`, { cache: "no-store", signal: AbortSignal.timeout(1500) }).then(async (response) => response.ok ? response.json() : null),
      fetch(`http://127.0.0.1:${target.port}/v1/models`, { cache: "no-store", signal: AbortSignal.timeout(1500) }).then(async (response) => response.ok ? response.json() : null),
      Promise.all(Object.entries(services).filter(([key]) => key !== profile).map(async ([, service]) => {
        try { await fetch(`http://127.0.0.1:${service.port}/health`, { cache: "no-store", signal: AbortSignal.timeout(1500) }); return true; }
        catch { return false; }
      })),
    ]);
    const settingsMatch = profile === "image" ? health?.quantization === "experimental-low-bit" : profile === "naive-n05-flash-int4-experimental" ? health?.gpu_packed_weights === true : true;
    return settingsMatch && health?.status === "ok" && Array.isArray(models?.data) && models.data.some((model: { id?: string }) => model.id === target.model) && !otherServices.some(Boolean);
  } catch { return false; }
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = state.queue.then(operation, operation);
  state.queue = result.catch(() => undefined);
  return result;
}

function runManager(profile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(process.cwd(), "scripts", "manage-local-model.ps1"), "-Profile", profile], {
      cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output = (output + chunk.toString()).slice(-2000); });
    child.stderr.on("data", (chunk) => { output = (output + chunk.toString()).slice(-2000); });
    child.on("error", reject);
    child.on("exit", (code) => {
      // Detached model workers can inherit a Windows pipe handle. Waiting for
      // "close" would keep this request pending until the model itself exits.
      child.stdout.destroy();
      child.stderr.destroy();
      if (code === 0) resolve();
      else reject(new ApiHttpError(output.includes("MODEL_BUSY:") ? 409 : 503, "LOCAL_MODEL_LOAD_FAILED", output.includes("MODEL_BUSY:")
        ? "另一条请求正在使用本机模型，请等它完成后再切换。"
        : "本机模型加载失败，请刷新重试；详细原因已记录在本地模型日志中。"));
    });
  });
}

async function activate(profile: string) {
  if (state.leases > 0) {
    if (state.active === profile) return;
    throw new ApiHttpError(409, "MODEL_BUSY", "本机模型正在处理请求，请等它完成后再切换。");
  }
  // Confirm the real worker remains ready, then reuse its loaded weights.
  // Repeated questions need no PowerShell launch or process enumeration.
  if (!await canReuseActive(profile)) await runManager(profile);
  state.active = profile;
}

export async function ensureLocalModel(profile: string) {
  if (!isManagedLocalModel(profile)) return false;
  await serialize(() => activate(profile));
  return true;
}

/** Hold the runtime until the entire response finishes, including streamed text. */
export async function leaseLocalModel(profile: string): Promise<() => void> {
  if (profile !== "image" && !isManagedLocalModel(profile)) return () => undefined;
  if (profile === "image" && process.env.LOCAL_MODEL_SWITCHING !== "true") throw new ApiHttpError(503, "LOCAL_IMAGE_RUNTIME_DISABLED", "本机图片模型尚未启用。");
  await serialize(async () => { await activate(profile); state.leases += 1; });
  let released = false;
  return () => { if (!released) { released = true; state.leases = Math.max(0, state.leases - 1); } };
}

export function releaseRuntimeWhenResponseEnds(response: Response, release: () => void) {
  if (!response.body) { release(); return response; }
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) { release(); controller.close(); }
        else controller.enqueue(item.value);
      } catch (error) { release(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
