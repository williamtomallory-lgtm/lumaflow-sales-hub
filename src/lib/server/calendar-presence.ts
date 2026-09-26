import "server-only";

import { get, put } from "@vercel/blob";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiHttpError } from "./api-security";
import { listCalendarEventsForViewer, type CalendarViewer } from "./calendar-store";

const presenceSchema = z.object({ email: z.email(), name: z.string(), lastSeenAt: z.string().datetime({ offset: true }) });
const onlineWindowMs = 90_000;

function presencePath(email: string) { return `calendar/presence/${createHash("sha256").update(email.toLowerCase()).digest("hex")}.json`; }

function storageReady() {
  if (process.env.VERCEL !== "1") return false;
  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) throw new ApiHttpError(503, "CALENDAR_STORAGE_UNAVAILABLE", "协作日历存储尚未配置。");
  return true;
}

export async function markCalendarViewerActive(viewer: CalendarViewer) {
  const entry = presenceSchema.parse({ email: viewer.email, name: viewer.name, lastSeenAt: new Date().toISOString() });
  if (storageReady()) await put(presencePath(viewer.email), JSON.stringify(entry), { access: "private", allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 0 });
  return entry;
}

export async function listVisibleCalendarPresence(viewer: CalendarViewer, from: string, to: string) {
  if (!storageReady()) return { [viewer.email]: { name: viewer.name, lastSeenAt: new Date().toISOString(), online: true } };
  const events = await listCalendarEventsForViewer(viewer, from, to);
  const emails = [...new Set([viewer.email, ...events.flatMap((event) => [event.createdByEmail, ...event.participantEmails])])].slice(0, 500);
  const entries: Record<string, { name: string; lastSeenAt: string; online: boolean }> = {};
  for (let offset = 0; offset < emails.length; offset += 20) {
    const found = await Promise.all(emails.slice(offset, offset + 20).map(async (email) => {
      const response = await get(presencePath(email), { access: "private" });
      if (!response || response.statusCode !== 200) return null;
      const parsed = presenceSchema.safeParse(await new Response(response.stream).json());
      if (!parsed.success || parsed.data.email !== email) return null;
      return parsed.data;
    }));
    for (const entry of found) if (entry) entries[entry.email] = { name: entry.name, lastSeenAt: entry.lastSeenAt, online: Date.now() - Date.parse(entry.lastSeenAt) < onlineWindowMs };
  }
  return entries;
}
