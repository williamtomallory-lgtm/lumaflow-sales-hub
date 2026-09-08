import "server-only";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const slug = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
export const salesToolNameSchema = z.enum([
  "searchProducts", "getProductDetails", "checkInventory", "searchKnowledge", "getProductAssets", "createQuoteDraft",
]);
export type SalesToolName = z.infer<typeof salesToolNameSchema>;

const profileSchema = z.object({
  id: slug,
  version,
  name: z.string().trim().min(1).max(120),
  skills: z.array(slug).min(1).max(16).refine((ids) => new Set(ids).size === ids.length, "Duplicate skill ids"),
}).strict();

const skillSchema = z.object({
  id: slug,
  version,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  tools: z.array(salesToolNameSchema).max(6),
  instructions: z.array(z.string().trim().min(1).max(2_000)).min(1).max(20),
}).strict();

async function readJson(path: string) {
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("Agent profile file is too large.");
  return JSON.parse(text) as unknown;
}

// Only administrator-owned files are loaded. Requests cannot specify a path or add tools.
// Read each run so a reviewed skill update is used without rebuilding the frontend.
export async function loadSalesProfile(directory = resolve(process.cwd(), "agent")) {
  const profile = profileSchema.parse(await readJson(resolve(directory, "profile.json")));
  const skills = await Promise.all(profile.skills.map(async (id) => {
    const skill = skillSchema.parse(await readJson(resolve(directory, "skills", `${id}.json`)));
    if (skill.id !== id) throw new Error(`Skill id does not match its file: ${id}`);
    return skill;
  }));
  const toolNames = [...new Set(skills.flatMap((skill) => skill.tools))];
  return {
    id: profile.id,
    version: profile.version,
    name: profile.name,
    skills,
    toolNames,
    instructions: skills.map((skill) => `Skill ${skill.id}@${skill.version} · ${skill.name}\n${skill.instructions.map((line) => `- ${line}`).join("\n")}`).join("\n\n"),
  };
}

export type SalesProfile = Awaited<ReturnType<typeof loadSalesProfile>>;
