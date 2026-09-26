import "server-only";

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Small, local-only preference store used by the assistant tools.
 *
 * This is deliberately separate from CRM context memory: it stores user
 * preferences that apply to the local assistant, not customer facts.  The
 * store is not a cloud memory service and never infers a location or identity.
 */
const memorySchema = z.object({
  id: z.string().uuid(),
  text: z.string().trim().min(1).max(2_000),
  category: z.string().trim().min(1).max(80),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const memoryFileSchema = z.array(memorySchema).max(500);
export type AssistantMemory = z.infer<typeof memorySchema>;

function memoryPath() {
  const testPath = process.env.NODE_ENV === "test" ? process.env.LUMAFLOW_MEMORY_TEST_FILE?.trim() : undefined;
  return path.resolve(testPath || path.join(process.cwd(), ".local-data", "assistant", "memory.json"));
}

const globalState = globalThis as typeof globalThis & {
  lumaflowAssistantMemoryMutation?: Promise<void>;
};

function withMemoryLock<T>(operation: () => Promise<T>) {
  const previous = globalState.lumaflowAssistantMemoryMutation ?? Promise.resolve();
  const run = previous.then(operation);
  globalState.lumaflowAssistantMemoryMutation = run.then(() => undefined, () => undefined);
  return run;
}

async function readMemoryFile() {
  try {
    const value: unknown = JSON.parse(await readFile(memoryPath(), "utf8"));
    const parsed = memoryFileSchema.safeParse(value);
    return parsed.success ? parsed.data : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeMemoryFile(records: AssistantMemory[]) {
  const target = memoryPath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(records, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function normalize(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export async function saveAssistantMemory(text: string, category = "偏好") {
  const cleanText = text.trim().slice(0, 2_000);
  const cleanCategory = category.trim().slice(0, 80) || "偏好";
  if (!cleanText) throw new Error("记忆内容不能为空。");
  return withMemoryLock(async () => {
    const records = await readMemoryFile();
    const now = new Date().toISOString();
    const existing = records.find((record) => normalize(record.text) === normalize(cleanText) && normalize(record.category) === normalize(cleanCategory));
    if (existing) {
      const updated = { ...existing, text: cleanText, category: cleanCategory, updatedAt: now };
      await writeMemoryFile(records.map((record) => record.id === existing.id ? updated : record));
      return updated;
    }
    const record: AssistantMemory = {
      id: randomUUID(), text: cleanText, category: cleanCategory, createdAt: now, updatedAt: now,
    };
    await writeMemoryFile([record, ...records].slice(0, 500));
    return record;
  });
}

export async function searchAssistantMemory(query = "", limit = 20) {
  const records = await readMemoryFile();
  const needle = normalize(query);
  if (!needle) return records.slice(0, Math.max(1, Math.min(50, limit)));
  const terms = [...new Set(needle.split(/[\s，。？！、/\\\-_:：；;（）()]+/).filter((term) => term.length >= 1))];
  return records
    .map((record) => ({ record, score: terms.filter((term) => normalize(`${record.category} ${record.text}`).includes(term)).length }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
    .slice(0, Math.max(1, Math.min(50, limit)))
    .map(({ record }) => record);
}

export async function listAssistantMemory() {
  return readMemoryFile();
}
