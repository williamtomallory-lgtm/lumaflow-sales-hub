import { z } from "zod";

export const workStepSchema = z.object({
  title: z.string().trim().min(1).max(160),
  state: z.enum(["pending", "running", "completed", "blocked"]),
  receiptIds: z.array(z.string().uuid()).max(8).default([]),
}).strict();
export const workRunSchema = z.object({
  id: z.string().uuid(), chatId: z.string().uuid(), agentId: z.string().max(100),
  projectId: z.string().uuid().nullable(), model: z.string().max(240),
  goal: z.string().max(20_000).default(""),
  workspace: z.string().max(2000).optional(),
  state: z.enum(["running", "answered", "partial", "needs-review", "interrupted", "failed"]),
  steps: z.array(workStepSchema).max(12),
  receipts: z.array(z.object({
    id: z.string().uuid(), tool: z.string().max(100), action: z.string().max(120),
    target: z.string().max(2000).optional(),
    state: z.enum(["running", "succeeded", "failed"]),
    summary: z.string().max(2000),
    facts: z.array(z.object({ kind: z.enum(["file-read", "file-write", "file-delete", "command", "analysis"]), path: z.string().max(2000).optional(), fileSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), exitCode: z.number().int().optional() }).strict()).max(8).optional(),
  }).strict()).max(80),
  updatedAt: z.string().datetime(),
  outcome: z.object({ verdict: z.enum(["checked", "partial", "uncertain"]), source: z.enum(["local-model", "rules"]), checks: z.array(z.object({ title: z.string().max(180), state: z.enum(["passed", "failed", "unknown"]), evidenceIds: z.array(z.string().uuid()).max(8) }).strict()).max(24), missing: z.array(z.string().max(240)).max(8) }).strict().optional(),
}).strict();
export type WorkRun = z.infer<typeof workRunSchema>;

export function readWorkRun(parts: readonly unknown[]): WorkRun | undefined {
  let latest: WorkRun | undefined;
  for (const part of parts) {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "data-work-run" || !("data" in part)) continue;
    const parsed = workRunSchema.safeParse(part.data);
    if (parsed.success) latest = parsed.data;
  }
  return latest;
}
