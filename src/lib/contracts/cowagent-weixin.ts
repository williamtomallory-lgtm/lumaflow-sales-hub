import { z } from "zod";

export const cowAgentWeixinIdentitySchema = z.object({
  agentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  instanceId: z.string().regex(/^weixin-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
}).strict().refine((value) => value.instanceId === `weixin-${value.agentId}`, "微信实例必须与智能体匹配");

export const cowAgentWeixinActionSchema = z.discriminatedUnion("action", [
  cowAgentWeixinIdentitySchema.extend({ action: z.literal("create-qr") }),
  cowAgentWeixinIdentitySchema.extend({ action: z.literal("poll") }),
  cowAgentWeixinIdentitySchema.extend({ action: z.literal("disconnect") }),
]);

export type CowAgentWeixinPhase = "idle" | "waiting" | "scanned" | "connected" | "error";

export type CowAgentWeixinState = {
  engine: "CowAgent";
  phase: CowAgentWeixinPhase;
  active: boolean;
  boundAgentId?: string;
  instanceId?: string;
  loginStatus?: string;
  qrImage?: string;
  qrUrl?: string;
  message?: string;
};
