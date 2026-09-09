import { z } from "zod";

export const cowAgentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

export const cowAgentCreateSchema = z.object({
  id: cowAgentIdSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1_000).default(""),
  cloneFrom: cowAgentIdSchema.nullable().default(null),
  knowledgeMode: z.enum(["shared", "own"]).default("shared"),
  agentType: z.enum(["weixin_personal", "wecom_group"]),
  revision: z.string().max(200).optional(),
}).strict();

export type CowAgentProfile = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  workspace: string;
  model?: string;
  botType?: "weixin_personal" | "wecom_group" | string;
  avatar?: string;
  avatarRev?: string;
  knowledgeMode: "shared" | "own";
};

export type CowAgentRoster = {
  agents: CowAgentProfile[];
  defaultAgentId: string;
  revision: string;
};
