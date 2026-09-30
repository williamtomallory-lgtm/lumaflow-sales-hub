import { z } from "zod";

const agentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const instanceId = z.string().regex(/^wecom-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

export const cowAgentWecomIdentitySchema = z.object({ agentId, instanceId }).strict()
  .refine((value) => value.instanceId === `wecom-${value.agentId}`, "企微实例必须与智能体匹配");

export const cowAgentWecomActionSchema = z.discriminatedUnion("action", [
  cowAgentWecomIdentitySchema.extend({
    action: z.literal("connect"),
    botId: z.string().trim().min(1).max(256),
    botSecret: z.string().trim().min(1).max(512),
    keywordEnabled: z.boolean().default(false),
    keywords: z.array(z.string().trim().min(1).max(64)).max(30).default([]),
  }),
  cowAgentWecomIdentitySchema.extend({ action: z.literal("disconnect") }),
  cowAgentWecomIdentitySchema.extend({
    action: z.literal("update-policy"),
    keywordEnabled: z.boolean(),
    keywords: z.array(z.string().trim().min(1).max(64)).max(30),
  }),
  cowAgentWecomIdentitySchema.extend({
    action: z.literal("create-task"),
    name: z.string().trim().min(1).max(120),
    receiver: z.string().trim().min(1).max(256),
    content: z.string().trim().min(1).max(10_000),
    enabled: z.boolean().default(false),
    schedule: z.discriminatedUnion("type", [
      z.object({ type: z.literal("once"), runAt: z.string().datetime() }),
      z.object({ type: z.literal("cron"), expression: z.string().trim().min(1).max(120) }),
      z.object({ type: z.literal("interval"), seconds: z.number().int().min(60).max(31_536_000) }),
    ]),
  }),
  cowAgentWecomIdentitySchema.extend({
    action: z.literal("toggle-task"),
    taskId: z.string().trim().min(1).max(128),
    enabled: z.boolean(),
  }),
]);

export type CowAgentWecomRecipient = { receiver: string; name: string; isGroup: boolean };
export type CowAgentWecomTask = { id: string; name: string; enabled: boolean; nextRunAt?: string };

export type CowAgentWecomState = {
  engine: "CowAgent";
  instanceId: string;
  boundAgentId: string;
  active: boolean;
  loginStatus?: string;
  keywordEnabled: boolean;
  keywords: string[];
  recipients: CowAgentWecomRecipient[];
  tasks: CowAgentWecomTask[];
};
