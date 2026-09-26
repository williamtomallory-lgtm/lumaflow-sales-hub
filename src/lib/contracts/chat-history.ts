import { z } from "zod";
import { agentProgressSchema, collaborationModeSchema } from "./agent-progress";

const turnVersionSchema = z.object({
  id: z.string().uuid(),
  user: z.string().trim().min(1).max(12_000),
  assistant: z.string().max(150_000),
  createdAt: z.string().datetime(),
  attachments: z.array(z.string().max(160)).max(4).default([]),
  parentVersionId: z.string().uuid().optional(),
  agentId: z.string().min(1).max(100).optional(),
  collaboratorAgentIds: z.array(z.string().min(1).max(100)).max(3).optional(),
  collaborationMode: collaborationModeSchema.optional(),
  agentActivity: z.array(agentProgressSchema).max(16).optional(),
}).strict();

const turnSchema = z.object({
  id: z.string().uuid(),
  user: z.string().trim().min(1).max(12_000),
  assistant: z.string().max(150_000),
  createdAt: z.string().datetime(),
  attachments: z.array(z.string().max(160)).max(4).default([]),
  parentVersionId: z.string().uuid().optional(),
  agentId: z.string().min(1).max(100).optional(),
  collaboratorAgentIds: z.array(z.string().min(1).max(100)).max(3).optional(),
  collaborationMode: collaborationModeSchema.optional(),
  agentActivity: z.array(agentProgressSchema).max(16).optional(),
  // Older sessions omit this field. New generations append a paired prompt
  // and answer here so browsing a branch never needs another model request.
  versions: z.array(turnVersionSchema).max(20).optional(),
}).strict();
export const chatSessionSchema = z.object({
  id: z.string().uuid(),
  experience: z.enum(["chat", "work"]),
  title: z.string().trim().min(1).max(120),
  agentId: z.string().max(100).optional(),
  projectId: z.string().uuid().nullable().optional(),
  // These fields were added after the first local-session format. Keep them
  // optional so existing JSON files remain valid and old clients can still
  // save a session without accidentally changing its metadata.
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  turns: z.array(turnSchema).max(100),
}).strict().refine((session) => JSON.stringify(session).length <= 2_000_000, "Conversation is too large");
export type LocalChatSession = z.infer<typeof chatSessionSchema>;
export type LocalChatTurn = z.infer<typeof turnSchema>;
export type LocalChatTurnVersion = z.infer<typeof turnVersionSchema>;
export type LocalChatSummary = Pick<LocalChatSession, "id" | "experience" | "title" | "agentId" | "createdAt" | "updatedAt" | "pinned" | "archived" | "projectId"> & { turnCount: number };

/** Metadata changes are deliberately narrow so a history action cannot
 * overwrite the saved conversation body. */
export const chatSessionMetadataPatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  projectId: z.string().uuid().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "至少提供一项对话记录设置");
export type LocalChatMetadataPatch = z.infer<typeof chatSessionMetadataPatchSchema>;
