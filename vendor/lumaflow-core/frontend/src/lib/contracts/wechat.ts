import { z } from "zod";

export const wechatEntrySchema = z.object({ kind: z.enum(["text", "system", "attachment-unread"]), text: z.string().max(20_000) });
export const wechatProbeSchema = z.object({
  state: z.string(), canRead: z.boolean(), running: z.boolean().optional(),
  windows: z.array(z.object({ processId: z.number().int().positive(), version: z.string().nullable(), application: z.string() })).optional(),
  processId: z.number().int().positive().optional(), version: z.string().nullable().optional(),
  chatLabel: z.string().max(500).optional(), chatFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  loadedItems: z.number().int().nonnegative().optional(), entries: z.array(wechatEntrySchema).max(20).optional(),
});
export const wechatActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), processId: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("read"), connectionId: z.string().uuid(), confirmed: z.literal(true), limit: z.number().int().min(1).max(20).default(5) }).strict(),
  z.object({ action: z.literal("disconnect"), connectionId: z.string().uuid() }).strict(),
]);
export type WechatProbe = z.infer<typeof wechatProbeSchema>;
export type WechatEntry = z.infer<typeof wechatEntrySchema>;
export type WechatSnapshot = { id: string; chatLabel: string; capturedAt: string; loadedItems: number; entries: WechatEntry[] };
export function formatWechatSnapshot(snapshot: WechatSnapshot, entries = snapshot.entries) {
  return `【微信只读快照：${snapshot.chatLabel}】\n范围：本机当前会话已加载的 ${snapshot.loadedItems} 条中选取 ${entries.length} 条；不是全部历史。附件正文未读取，发送者身份未结构化核验。\n${entries.map((entry, index) => `${index + 1}. [${entry.kind}] ${entry.text}`).join("\n")}`;
}
