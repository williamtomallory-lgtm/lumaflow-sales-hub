// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";

vi.mock("server-only", () => ({}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("./model-config", () => ({ isManagedLocalModel: (profile: string) => ["configured", "naive-n05-flash-int4-experimental"].includes(profile) }));

let running = "";
beforeEach(() => {
  vi.resetModules();
  delete (globalThis as typeof globalThis & { lumaflowModelRuntime?: unknown }).lumaflowModelRuntime;
  vi.mocked(spawn).mockReset();
  running = "";
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    running = args?.[args.length - 1] ?? "";
    queueMicrotask(() => child.emit("exit", 0));
    return child as unknown as ReturnType<typeof spawn>;
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const port = running === "configured" ? "8081" : "8083";
    if (!url.includes(`:${port}/`)) throw new Error("Connection refused");
    return Response.json(url.endsWith("/health") ? { status: "ok", gpu_packed_weights: true } : { data: [{ id: running === "configured" ? "ternary-bonsai-2-27b" : "naive-n0.5-flash-int4-48l-1e" }] });
  }));
});
afterEach(() => vi.unstubAllGlobals());

it("reuses the healthy selected worker and reloads it after a real disconnect", async () => {
  const runtime = await import("./local-model-runtime");
  await runtime.ensureLocalModel("configured");
  await runtime.ensureLocalModel("configured");
  expect(spawn).toHaveBeenCalledTimes(1);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));
  await runtime.ensureLocalModel("configured");
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("keeps the model leased until streamed output ends, then permits switching", async () => {
  const runtime = await import("./local-model-runtime");
  const release = await runtime.leaseLocalModel("configured");
  await expect(runtime.ensureLocalModel("naive-n05-flash-int4-experimental")).rejects.toMatchObject({ status: 409 });
  const response = runtime.releaseRuntimeWhenResponseEnds(new Response("真实输出"), release);
  expect(await response.text()).toBe("真实输出");
  await runtime.ensureLocalModel("naive-n05-flash-int4-experimental");
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("releases a cancelled stream and leaves unmanaged profiles alone", async () => {
  const runtime = await import("./local-model-runtime");
  const release = await runtime.leaseLocalModel("configured");
  const response = runtime.releaseRuntimeWhenResponseEnds(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } })), release);
  await response.body?.cancel();
  await runtime.ensureLocalModel("naive-n05-flash-int4-experimental");
  expect(await runtime.ensureLocalModel("remote-service")).toBe(false);
  expect(spawn).toHaveBeenCalledTimes(2);
});
