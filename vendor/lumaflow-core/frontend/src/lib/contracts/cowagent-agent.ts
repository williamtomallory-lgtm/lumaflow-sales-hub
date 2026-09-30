import { z } from "zod";
import { AGENT_ROLE_IDS, type AgentRoleId } from "@/config/agent-roles";

export const cowAgentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

export const cowAgentCreateSchema = z.object({
  id: cowAgentIdSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1_000).default(""),
  cloneFrom: cowAgentIdSchema.nullable().default(null),
  knowledgeMode: z.enum(["shared", "own"]).default("shared"),
  type: z.enum(["local", "wechat"]),
  agentType: z.enum(["weixin_personal", "wecom_group"]).optional(),
  systemPrompt: z.string().trim().max(12_000).default(""),
  knowledgeBaseIds: z.array(z.string().max(200)).max(50).default([]),
  workspace: z.string().trim().max(2000).optional(),
  allowedPaths: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  permissions: z.object({ read: z.boolean(), create: z.boolean(), modify: z.boolean(), delete: z.boolean(), tools: z.boolean() }).strict().optional(),
  roleIds: z.array(z.enum(AGENT_ROLE_IDS)).min(1).max(AGENT_ROLE_IDS.length),
  revision: z.string().max(200).optional(),
}).strict().superRefine((value, context) => {
  if ((value.type === "wechat") !== Boolean(value.agentType)) context.addIssue({ code: "custom", message: "Agent 类型与微信类型不匹配", path: ["agentType"] });
  if (value.type === "wechat" && value.permissions && Object.values(value.permissions).some(Boolean)) context.addIssue({ code: "custom", message: "微信 Agent 不能拥有本机文件权限", path: ["permissions"] });
});

export const cowAgentDeleteSchema = z.object({
  id: cowAgentIdSchema,
  revision: z.string().max(200).optional(),
}).strict();

export type CowAgentProfile = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  type: "local" | "wechat";
  workspace: string;
  systemPrompt?: string;
  knowledgeBaseIds?: string[];
  permissions?: { read: boolean; create: boolean; modify: boolean; delete: boolean; tools: boolean };
  allowedPaths?: string[];
  wechat?: { botId?: string; accountType: "personal" | "other"; status: "waiting" | "connected"; instanceId: string };
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
