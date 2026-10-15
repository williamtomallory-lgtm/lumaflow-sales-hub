import { z } from "zod";

export const workEngineSectionIds = ["chat", "experts", "teams", "memory", "skills", "plugins", "schedules", "connectors", "knowledge", "browser", "terminal", "desktop", "acp", "channels", "models", "users", "settings", "backup"] as const;
export const workEngineSectionIdSchema = z.enum(workEngineSectionIds);
export type WorkEngineSectionId = z.infer<typeof workEngineSectionIdSchema>;
export type WorkEngineSection = { id: WorkEngineSectionId; label: string; path: string; availability: "available" | "offline" | "needs-account"; detail: string };
export type WorkEngineStatus = {
  connected: boolean; installed: boolean; version: string | null; baseUrl: string;
  agentIds: { work: string; researcher: string; verifier: string; team: string };
  sections: WorkEngineSection[]; models: { id: string; label: string; reachable: boolean }[];
  message: string; typesafe: { configured: boolean; enabled: boolean };
};

export const workEngineRouteRequestSchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
