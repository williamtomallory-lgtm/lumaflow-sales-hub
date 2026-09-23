import { z } from "zod";
import { AGENT_ROLE_IDS, type AgentRoleId } from "@/config/agent-roles";

export const cowAgentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

export const cowAgentCreateSchema = z.object({
  id: cowAgentIdSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1_000).default(""),
  cloneFrom: cowAgentIdSchema.nullable().default(null),
  knowledgeMode: z.enum(["shared", "own"]).default("shared"),
  agentType: z.enum(["weixin_personal", "wecom_group"]),
  roleIds: z.array(z.enum(AGENT_ROLE_IDS)).min(1).max(AGENT_ROLE_IDS.length),
  revision: z.string().max(200).optional(),
}).strict();

export const cowAgentDeleteSchema = z.object({
  id: cowAgentIdSchema,
  revision: z.string().max(200).optional(),
}).strict();

export type CowAgentProfile = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  workspace: string;
  model?: string;
  /** LLM provider override from CowAgent; channel routing never reads this field. */
  botType?: string;
  /** Channel role, deliberately separate from the LLM provider. */
  agentType?: "weixin_personal" | "wecom_group";
  roleIds?: AgentRoleId[];
  avatar?: string;
  avatarRev?: string;
  knowledgeMode: "shared" | "own";
};

export type CowAgentRoster = {
  agents: CowAgentProfile[];
  defaultAgentId: string;
  revision: string;
};
