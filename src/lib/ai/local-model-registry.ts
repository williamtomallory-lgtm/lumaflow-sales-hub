import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { registeredLocalModelIdSchema } from "../contracts/api";

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const profileSchema = z.object({
  id: registeredLocalModelIdSchema,
  label: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(240),
  baseURL: z.url().refine((value) => {
    const url = new URL(value);
    return loopback.has(url.hostname) && ["http:", "https:"].includes(url.protocol)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname.replace(/\/$/, "") === "/v1";
  }, "Local models must use a loopback /v1 endpoint"),
  backend: z.enum(["openai-compatible", "ollama", "strata"]),
  description: z.string().max(500).default("已登记的本机模型"),
  family: z.string().max(80).default("本地模型"),
  parameterSizeB: z.number().positive().max(10000).nullable().default(null),
  contextTokens: z.number().int().min(4096).max(1048576).default(8192),
  maxOutputTokens: z.number().int().min(256).max(32768).default(4096),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).optional(),
  runtime: z.literal("strata").optional(),
  installationStatus: z.enum(["ready", "not-downloaded"]).default("ready"),
}).strict().refine((item) => !item.runtime || (item.id === "local:strata-coder" && item.model === "qwen3.8-flash-next-coder-iq1_m" && item.backend === "strata" && item.baseURL.replace(/\/$/, "") === "http://127.0.0.1:8080/v1"),
  "The managed Strata runtime uses 127.0.0.1:8080");

export type LocalModelProfile = z.infer<typeof profileSchema>;

/** Only the operator's local file can register a model or its credentials. */
export function getLocalModelProfiles(): LocalModelProfile[] {
  if (process.env.VERCEL === "1") return [];
  const file = process.env.LUMAFLOW_LOCAL_MODELS_FILE || path.join(process.cwd(), ".local-data", "local-models.json");
  let raw: string;
  try { raw = readFileSync(/*turbopackIgnore: true*/ file, "utf8").replace(/^\uFEFF/, ""); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const entries = z.array(profileSchema).max(32).parse(JSON.parse(raw));
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Local model IDs must be unique.");
  return entries;
}

export function getLocalModelProfile(id: string) {
  return id.startsWith("local:") ? getLocalModelProfiles().find((entry) => entry.id === id) : undefined;
}
