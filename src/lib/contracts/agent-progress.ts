import { z } from "zod";

export const collaborationModeSchema = z.enum(["parallel", "sequential", "debate"]);
export type CollaborationMode = z.infer<typeof collaborationModeSchema>;
export function inferCollaborationMode(text: string): CollaborationMode {
  const currentRequest = text.lastIndexOf("\n\n当前请求：");
  if (currentRequest >= 0) text = text.slice(currentRequest + "\n\n当前请求：".length);
  if (/辩论|讨论|debate|discuss/i.test(text)) return "debate";
  if (/分步|分布|依次|接力|sequential/i.test(text)) return "sequential";
  return "parallel";
}

export const agentProgressSchema = z.object({
  agentId: z.string().min(1).max(100),
  name: z.string().min(1).max(80),
  avatarUrl: z.string().max(1000).optional(),
  round: z.number().int().min(1).max(3),
  state: z.enum(["running", "completed", "failed", "cancelled"]),
  text: z.string().max(2000).optional(),
  recipientNames: z.array(z.string().min(1).max(80)).max(4).optional(),
  actions: z.array(z.string().max(200)).max(20).optional(),
}).strict();
export type AgentProgress = z.infer<typeof agentProgressSchema>;

/** Preserve actual replies when a connection closes before the final answer. */
export function interruptedTeamAnswer(records: readonly AgentProgress[]): string {
  const reports = records.filter((record) => record.text && record.round < 3);
  const notes = reports.map((record) => `### ${record.name} · 第 ${record.round} 轮\n\n${record.text}`).join("\n\n");
  return `本轮未完成最终回复，以下是已经返回的成员内容；尚未形成最终结论。${notes ? `\n\n${notes}` : "请重试剩余任务。"}`;
}

export function readAgentProgress(parts: readonly unknown[]): AgentProgress[] {
  const records = new Map<string, AgentProgress>();
  for (const part of parts) {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "data-agent-progress" || !("data" in part)) continue;
    const parsed = agentProgressSchema.safeParse(part.data);
    if (parsed.success) records.set(`${parsed.data.agentId}:${parsed.data.round}`, parsed.data);
  }
  return [...records.values()];
}
