// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
vi.mock("server-only", () => ({}));
const owner = vi.hoisted(() => ({ value: "a".repeat(32) }));
vi.mock("../server/knowledge-scope", () => ({ getKnowledgeOwner: () => owner.value }));
import { previousWorkRun, trackWorkTools, withWorkRun, workPlanTools, workRunContext } from "./work-run";
import type { WorkRun } from "../contracts/work-run";
import { prepareToolStep } from "./tool-step-policy";
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "lumaflow-work-")); vi.stubEnv("LUMAFLOW_WORK_RUNS_DIR", directory); vi.stubEnv("VERCEL", "1"); owner.value = "a".repeat(32); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const options = { toolCallId: "test", messages: [], context: {} };

describe("durable Work execution", () => {
  it("records intent before dispatch and preserves the real receipt for continuation", async () => {
    const input = { chatId: randomUUID(), agentId: "work", projectId: null, model: "local" };
    let latest: WorkRun | undefined;
    const tools = trackWorkTools({ localComputer: { inputSchema: z.object({}), execute: async () => {
      const stored = await previousWorkRun(input.chatId, input.agentId, null);
      expect(stored?.receipts[0].state).toBe("running");
      return { path: "report.txt", success: true };
    } } });
    await withWorkRun(input, (run) => { latest = run; }, async () => {
      const result = await tools.localComputer.execute() as unknown as { path: string; receiptId: string };
      expect(result.path).toBe("report.txt");
      await workPlanTools.updateWorkPlan.execute!({ steps: [{ title: "保存文件", state: "completed", receiptIds: [result.receiptId] }] }, options);
    }, new AbortController().signal);
    expect(latest?.state).toBe("answered");
    expect(latest?.steps[0].state).toBe("completed");
    expect((await previousWorkRun(input.chatId, input.agentId, null))?.receipts[0].state).toBe("succeeded");
    expect(await previousWorkRun(input.chatId, "other", null)).toBeUndefined();
    expect(await previousWorkRun(input.chatId, input.agentId, randomUUID())).toBeUndefined();
    owner.value = "b".repeat(32);
    expect(await previousWorkRun(input.chatId, input.agentId, null)).toBeUndefined();
  });
  it("rejects invented completion evidence and persists interruptions", async () => {
    const input = { chatId: randomUUID(), agentId: "work", projectId: null, model: "local" };
    const controller = new AbortController();
    await expect(withWorkRun(input, () => {}, async () => {
      const result = await workPlanTools.updateWorkPlan.execute!({ steps: [{ title: "没有写入", state: "completed", receiptIds: [randomUUID()] }] }, options);
      expect(result).toHaveProperty("error");
      controller.abort(); throw new Error("stopped");
    }, controller.signal)).rejects.toThrow("stopped");
    expect((await previousWorkRun(input.chatId, input.agentId, null))?.state).toBe("interrupted");
  });
  it("stops three identical calls while preserving changed parameters", () => {
    const call = { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "id", toolName: "read", input: { path: "a.txt" } }] };
    const input = { messages: [call, call, call], stepNumber: 3, maxSteps: 20, instructions: "Work", weatherLookup: false, workTask: true };
    expect(prepareToolStep(input)).toHaveProperty("toolChoice", "none");
    expect(prepareToolStep({ ...input, messages: [call, call] })).not.toHaveProperty("toolChoice");
  });
  it("keeps failed nested computer receipts out of completion evidence on the local desktop", async () => {
    vi.stubEnv("VERCEL", "");
    const input = { chatId: randomUUID(), agentId: "work", projectId: null, model: "local" };
    const tools = trackWorkTools({ python: { inputSchema: z.object({}), execute: async () => ({ receipt: { exitCode: 1, stderr: "file not found" } }) } });
    await withWorkRun(input, () => {}, async () => {
      const result = await tools.python.execute() as unknown as { receiptId: string };
      expect(await workPlanTools.updateWorkPlan.execute!({ steps: [{ title: "分析", state: "completed", receiptIds: [result.receiptId] }] }, options)).toHaveProperty("error");
    }, new AbortController().signal);
    expect((await previousWorkRun(input.chatId, input.agentId, null))?.receipts[0].state).toBe("failed");
  });
  it("persists the goal and an authoritative partial status for later continuation", async () => {
    const input = { chatId: randomUUID(), agentId: "work", projectId: null, model: "local", goal: "制作两份文件" };
    await withWorkRun(input, () => {}, async () => "first file only", new AbortController().signal, async () => ({ verdict: "partial", source: "rules", checks: [], missing: ["第二份文件未完成"] }));
    const stored = await previousWorkRun(input.chatId, input.agentId, null);
    expect(stored?.state).toBe("partial");
    expect(workRunContext(stored)).toContain("制作两份文件");
    expect(workRunContext(stored)).toContain("第二份文件未完成");
  });
});
