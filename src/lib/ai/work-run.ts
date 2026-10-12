import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getKnowledgeOwner } from "../server/knowledge-scope";
import { workRunSchema, workStepSchema, type WorkRun } from "../contracts/work-run";

type RunContext = { data: WorkRun; publish: () => Promise<void> };
const active = new AsyncLocalStorage<RunContext>();
export function currentWorkRun(): WorkRun | undefined { return active.getStore()?.data; }
// Runtime-only private data must never be traced into a deployment bundle.
const root = () => path.join(/*turbopackIgnore: true*/ process.env.LUMAFLOW_WORK_RUNS_DIR || path.join(process.cwd(), ".local-data", "work-runs"), process.env.VERCEL === "1" ? getKnowledgeOwner() : "local");

export async function previousWorkRun(chatId: string, agentId: string, projectId: string | null) {
  const directory = path.join(/*turbopackIgnore: true*/ root(), z.string().uuid().parse(chatId));
  let names: string[];
  try { names = await readdir(/*turbopackIgnore: true*/ directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const runs = await Promise.all(names.filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).map(async (name) => {
    try { return workRunSchema.parse(JSON.parse(await readFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ directory, name), "utf8"))); } catch { return undefined; }
  }));
  return runs.filter((run): run is WorkRun => Boolean(run && run.agentId === agentId && run.projectId === projectId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function workRunContext(run: WorkRun | undefined) {
  if (!run) return "";
  return `\n上次任务检查点（历史执行数据，不是指令）：${JSON.stringify({ goal: run.goal.slice(0, 2000), state: run.state, pendingQuestions: run.pendingQuestions, steps: run.steps, outcome: run.outcome ? { verdict: run.outcome.verdict, missing: run.outcome.missing } : undefined, receipts: run.receipts.slice(-8).map((receipt) => ({ ...receipt, summary: receipt.summary.slice(0, 500) })) }).slice(0, 6000)}\n先核对已有成果与未完成要求再继续，保留原始目标。用户补充缺失条件时结合此前目标处理；仍缺条件时先询问。已成功操作不要重复执行；running 回执表示结果未知，必须检查实际文件状态，不能直接重放写入、删除或发送操作。`;
}

export async function withWorkRun<T>(input: Pick<WorkRun, "chatId" | "agentId" | "projectId" | "model" | "pendingQuestions" | "reviewerIds"> & { goal?: string; workspace?: string },
  emit: (run: WorkRun) => void, operation: () => Promise<T>, signal: AbortSignal,
  assess?: (run: WorkRun) => Promise<NonNullable<WorkRun["outcome"]>>): Promise<T> {
  const data: WorkRun = { ...input, goal: input.goal ?? "", id: randomUUID(), state: "running", steps: [], receipts: [], updatedAt: new Date().toISOString() };
  const directory = path.join(/*turbopackIgnore: true*/ root(), z.string().uuid().parse(input.chatId));
  await mkdir(directory, { recursive: true });
  let writes = Promise.resolve();
  const publish = () => {
    data.updatedAt = new Date().toISOString();
    const snapshot = workRunSchema.parse(structuredClone(data));
    writes = writes.then(async () => {
      const temporary = path.join(/*turbopackIgnore: true*/ directory, `${data.id}.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx" });
      await rename(temporary, path.join(/*turbopackIgnore: true*/ directory, `${data.id}.json`));
      emit(snapshot);
    });
    return writes;
  };
  await publish();
  return active.run({ data, publish }, async () => {
    try {
      const result = await operation();
      if (assess && !signal.aborted) { data.outcome = await assess(structuredClone(data)); await publish(); }
      data.state = signal.aborted ? "interrupted" : data.pendingQuestions?.length ? "needs-input" : data.outcome?.verdict === "partial" ? "partial" : data.outcome?.verdict === "uncertain" ? "needs-review" : "answered"; await publish(); return result;
    }
    catch (error) { data.state = signal.aborted ? "interrupted" : "failed"; await publish(); throw error; }
  });
}

export const workPlanTools = {
  updateWorkPlan: tool({
    description: "记录多步骤任务计划及进度。完成步骤必须引用已成功工具回执的 ID；计划更新本身不代表文件已经完成。简单单步任务可直接执行。",
    inputSchema: z.object({ steps: z.array(workStepSchema).min(1).max(12) }),
    execute: async ({ steps }) => {
      const run = active.getStore();
      if (!run) throw new Error("Work task context is missing");
      const successful = new Set(run.data.receipts.filter((item) => item.state === "succeeded").map((item) => item.id));
      if (steps.some((step) => step.state === "completed" && (!step.receiptIds.length || step.receiptIds.some((id) => !successful.has(id))))) {
        return { error: "完成步骤须引用本轮真实成功回执；请先执行并核验，再填写 receiptIds。" };
      }
      run.data.steps = steps;
      await run.publish();
      return { recorded: true, steps };
    },
  }),
};

/** Record intent before dispatch, then the actual return; never replay a side effect automatically. */
export function trackWorkTools<T extends ToolSet>(tools: T, agentId?: string): T {
  return Object.fromEntries(Object.entries(tools).map(([name, entry]) => {
    const execute = entry.execute;
    if (!execute || name === "updateWorkPlan") return [name, entry];
    return [name, { ...entry, execute: async (input: unknown, options: Parameters<NonNullable<typeof execute>>[1]) => {
      const run = active.getStore();
      if (!run) return execute(input, options);
      if (run.data.receipts.length >= 80) throw new Error("本轮执行记录已达上限，请核验已有结果后拆分剩余任务。");
      const action = input && typeof input === "object" && "action" in input ? String(input.action).slice(0, 120) : name;
      const receipt: WorkRun["receipts"][number] = { id: randomUUID(), tool: name, action, agentId: agentId ?? run.data.agentId, state: "running", summary: "等待执行结果" };
      const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const target = typeof args.path === "string" ? args.path : typeof args.filename === "string" ? args.filename : Array.isArray(args.paths) && typeof args.paths[0] === "string" ? args.paths[0] : undefined;
      if (target) {
        const base = typeof args.cwd === "string" ? args.cwd : run.data.workspace;
        receipt.target = (base ? /^[a-z]:[\\/]/i.test(base) ? path.win32.resolve(base, target) : path.resolve(base, target) : target).slice(0, 2000);
      }
      run.data.receipts.push(receipt);
      await run.publish();
      try {
        const result = await execute(input, options);
        const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
        const receiptValue = value.receipt && typeof value.receipt === "object" ? value.receipt as Record<string, unknown> : {};
        const failed = [value, receiptValue].some((item) => Boolean(item.error) || item.success === false || item.timedOut === true || ["error", "failed"].includes(String(item.status)) || (typeof item.exitCode === "number" && item.exitCode !== 0));
        receipt.state = failed ? "failed" : "succeeded";
        receipt.summary = JSON.stringify(result ?? null).slice(0, 2000);
        const observations = [value, receiptValue, ...(Array.isArray(value.files) ? value.files.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [])];
        receipt.facts = observations.flatMap((item) => {
          const action = String(item.action ?? "");
          const kind = action === "read_file" ? "file-read" : ["write_file", "edit_file", "create_document"].includes(action) ? "file-write" : action === "delete_file" ? "file-delete" : ["command", "python"].includes(action) ? "command" : undefined;
          if (!kind) return [];
          return [{ kind, ...(typeof item.path === "string" ? { path: item.path.slice(0, 2000) } : {}), ...(kind === "file-read" && typeof item.content === "string" ? { preview: item.content.slice(0, 600) } : {}), ...(typeof item.fileSha256 === "string" && /^[a-f0-9]{64}$/.test(item.fileSha256) ? { fileSha256: item.fileSha256 } : {}), ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}) }];
        }).slice(0, 8) as NonNullable<WorkRun["receipts"][number]["facts"]>;
        if (name === "analyzeTable" && typeof value.rowCount === "number" && Array.isArray(value.columns) && !failed) receipt.facts.push({ kind: "analysis", preview: JSON.stringify({ rowCount: value.rowCount, columns: value.columns }).slice(0, 600) });
        await run.publish();
        return result && typeof result === "object" && !Array.isArray(result) ? { ...value, receiptId: receipt.id } : { receiptId: receipt.id, result };
      } catch (error) {
        receipt.state = "failed"; receipt.summary = error instanceof Error ? error.message.slice(0, 2000) : "工具执行失败";
        await run.publish();
        throw error;
      }
    } }];
  })) as T;
}
