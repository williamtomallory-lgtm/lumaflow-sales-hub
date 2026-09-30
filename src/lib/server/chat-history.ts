import "server-only";

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { chatSessionMetadataPatchSchema, chatSessionSchema, type LocalChatMetadataPatch, type LocalChatSession, type LocalChatSummary } from "@/lib/contracts/chat-history";

const directory = path.join(process.cwd(), ".local-data", "chat", "sessions");
function sessionPath(id: string) { return path.join(directory, `${z.string().uuid().parse(id)}.json`); }

// Image-operation turns have two stable signals that survive a browser
// reload: image attachments and the local asset URL written into the answer.
// The text hints cover records saved by earlier builds before the asset URL
// was included in the answer. This is intentionally deterministic so history
// categorisation never calls an AI model or reads image pixels.
const imageAssetPattern = /\/api\/v1\/assistant\/image-operations\/assets\/[0-9a-f]{32}\.png/i;
const imageTextPattern = /(?:qwen[- ]?image(?:[- ]?2\.1)?|图片文件\s*[:：]|图片模型|图片操作|生图功能|生成一张图片|编辑图片|修改图片|识别图片|查看我附加的图片)/i;
const imageFilePattern = /\.(?:png|jpe?g|webp|gif|bmp|avif)$/i;

function sessionHasImage(session: LocalChatSession): boolean {
  return session.turns.some((turn) => {
    const attachment = turn.attachments.some((name) => imageFilePattern.test(name) || name.trim() === "图片");
    return attachment || imageAssetPattern.test(turn.assistant) || imageTextPattern.test(turn.user) || imageTextPattern.test(turn.assistant);
  });
}

function sessionSearchText(session: LocalChatSession): string {
  return [session.title, ...session.turns.flatMap((turn) => [turn.user, turn.assistant, ...(turn.versions || []).flatMap((version) => [version.user, version.assistant])])].join("\n");
}

export async function readChatSession(id: string): Promise<LocalChatSession | null> {
  try { return chatSessionSchema.parse(JSON.parse(await readFile(sessionPath(id), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function listChatSessions(query = ""): Promise<LocalChatSummary[]> {
  await mkdir(directory, { recursive: true });
  const names = (await readdir(directory)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name));
  const sessions = await Promise.all(names.map(async (name) => readChatSession(name.slice(0, -5)).catch(() => null)));
  const needle = query.trim().toLocaleLowerCase();
    return sessions.flatMap((session) => {
    if (!session) return [];
    const searchableText = sessionSearchText(session);
    if (needle && !searchableText.toLocaleLowerCase().includes(needle)) return [];
    return [{
    id: session.id, experience: session.experience, title: session.title, agentId: session.agentId, projectId: session.projectId,
    createdAt: session.createdAt, updatedAt: session.updatedAt, pinned: session.pinned, archived: session.archived,
    turnCount: session.turns.length,
    hasImage: sessionHasImage(session),
    searchableText,
    }];
  }).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveChatSession(value: unknown): Promise<LocalChatSession> {
  const parsed = chatSessionSchema.parse(value);
  if (parsed.projectId) await (await import("./projects")).requireProject(parsed.projectId);
  // A session saved by an older browser does not carry metadata. Merge the
  // existing values so a normal answer save cannot clear a user's pin or
  // archive state.
  const existing = await readChatSession(parsed.id);
  const session = chatSessionSchema.parse({
    ...parsed,
    pinned: parsed.pinned ?? existing?.pinned,
    archived: parsed.archived ?? existing?.archived,
    projectId: parsed.projectId === undefined ? existing?.projectId : parsed.projectId,
  });
  await mkdir(directory, { recursive: true });
  const target = sessionPath(session.id);
  const temporary = path.join(directory, `${session.id}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(session), { encoding: "utf8", flag: "wx" }); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
  return session;
}

export async function updateChatSessionMetadata(id: string, value: unknown): Promise<LocalChatSession> {
  const patch: LocalChatMetadataPatch = chatSessionMetadataPatchSchema.parse(value);
  if (patch.projectId) await (await import("./projects")).requireProject(patch.projectId);
  const session = await readChatSession(id);
  if (!session) throw Object.assign(new Error("对话记录不存在。"), { code: "SESSION_NOT_FOUND" });
  return saveChatSession({
    ...session,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteChatSession(id: string) {
  await rm(sessionPath(id), { force: true });
}
