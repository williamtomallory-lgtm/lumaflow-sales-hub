import { z } from "zod";
import { cowAgentIdSchema } from "./cowagent-agent";

const id = z.string().min(1).max(200);
const permission = z.enum(["auto", "confirm"]);
export const wechatAgentPermissionsSchema = z.object({
  read: permission.default("auto"), create: permission.default("auto"),
  modify: permission.default("confirm"), tools: permission.default("auto"),
  delete: permission.default("confirm"),
  send: permission.default("confirm"),
  moments: permission.default("confirm"),
}).strict();
export const wechatAgentConfigSchema = z.object({
  id: cowAgentIdSchema,
  name: z.string().trim().min(1).max(80),
  avatarUrl: z.string().max(2000).optional(),
  systemPrompt: z.string().max(12_000).default(""),
  workspace: z.string().max(2000).default(""),
  knowledgeBaseIds: z.array(z.string().max(200)).max(50).default([]),
  syncEnabled: z.boolean().default(true),
  receiveEnabled: z.boolean().default(true),
  dndEnabled: z.boolean().default(false),
  permissions: wechatAgentPermissionsSchema,
});
// Patches must not apply the defaults used for a complete configuration.
export const wechatAgentConfigPatchSchema = z.object({
  systemPrompt: z.string().max(12_000).optional(), workspace: z.string().max(2000).optional(),
  knowledgeBaseIds: z.array(z.string().max(200)).max(50).optional(),
  syncEnabled: z.boolean().optional(), receiveEnabled: z.boolean().optional(), dndEnabled: z.boolean().optional(),
  permissions: z.object({
    read: permission.optional(), create: permission.optional(), modify: permission.optional(), tools: permission.optional(),
    delete: permission.optional(), send: permission.optional(), moments: permission.optional(),
  }).strict().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "No configuration changes");
export const wechatConversationSchema = z.object({
  id, title: z.string().min(1).max(120),
  createdAt: z.string(), updatedAt: z.string(),
  // A newly created runtime conversation has no message to preview yet.
  preview: z.string().max(500).nullable().transform((value) => value ?? undefined).optional(),
  pinned: z.boolean().optional(), archived: z.boolean().optional(),
});
export const wechatConversationPageSchema = z.object({
  items: z.array(wechatConversationSchema), nextCursor: z.string().max(500).nullable().optional(),
});
export const wechatMessageSchema = z.object({
  id, conversationId: id, role: z.enum(["user", "assistant", "system"]),
  text: z.string().max(150_000), createdAt: z.string(),
  source: z.enum(["work", "wechat"]),
  senderName: z.string().max(80).optional(), recipientName: z.string().max(80).optional(),
  status: z.enum(["pending", "running", "completed", "failed", "awaiting_confirmation"]).default("completed"),
  deliveryStatus: z.enum(["none", "pending", "sent", "failed"]).optional(),
});
export const wechatPendingActionSchema = z.object({
  id, conversationId: id, type: z.enum(["read", "create", "send", "delete", "modify", "moments", "command"]),
  title: z.string().max(200), detail: z.string().max(150_000).optional(),
  state: z.enum(["pending", "approved", "rejected", "failed"]),
  messageId: id.optional(),
});
export const wechatMessagePageSchema = z.object({
  items: z.array(wechatMessageSchema), nextCursor: z.string().max(500).nullable().optional(),
  pendingActions: z.array(wechatPendingActionSchema).default([]),
});
export const wechatAgentStateSchema = z.object({
  agent: wechatAgentConfigSchema,
  connection: z.object({
    status: z.enum(["connected", "waiting", "disconnected"]),
    error: z.string().max(500).optional(), botName: z.string().max(80).optional(), accountName: z.string().max(80).optional(),
    qrCodeDataUrl: z.string().max(500_000).optional(), qrCodeUrl: z.string().max(2000).optional(),
  }),
  currentConversationId: id.nullable().optional(),
  conversations: wechatConversationPageSchema,
  recentActivity: z.array(z.object({ text: z.string().max(300), createdAt: z.string() })).default([]),
});
export const wechatAgentActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("createConversation"), title: z.string().trim().min(1).max(120).optional() }).strict(),
  z.object({ action: z.literal("activate"), conversationId: id }).strict(),
  z.object({ action: z.literal("updateConversation"), conversationId: id, title: z.string().trim().min(1).max(120).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() }).strict().refine((value) => value.title !== undefined || value.pinned !== undefined || value.archived !== undefined, "No conversation changes"),
  z.object({ action: z.literal("deleteConversation"), conversationId: id }).strict(),
  z.object({ action: z.literal("send"), conversationId: id, text: z.string().trim().min(1).max(12_000), clientMessageId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("confirmAction"), actionId: id, approved: z.boolean() }).strict(),
  z.object({ action: z.literal("connect") }).strict(),
  z.object({ action: z.literal("disconnect") }).strict(),
]);
export const wechatAgentQuerySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("state") }).strict(),
  z.object({ action: z.literal("conversations"), cursor: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal("messages"), conversationId: id, cursor: z.string().max(500).optional() }).strict(),
]);
export type WechatAgentConfig = z.infer<typeof wechatAgentConfigSchema>;
export type WechatAgentState = z.infer<typeof wechatAgentStateSchema>;
export type WechatConversation = z.infer<typeof wechatConversationSchema>;
export type WechatConversationPage = z.infer<typeof wechatConversationPageSchema>;
export type WechatMessage = z.infer<typeof wechatMessageSchema>;
export type WechatMessagePage = z.infer<typeof wechatMessagePageSchema>;
export type WechatPendingAction = z.infer<typeof wechatPendingActionSchema>;
export type WechatAgentAction = z.infer<typeof wechatAgentActionSchema>;
