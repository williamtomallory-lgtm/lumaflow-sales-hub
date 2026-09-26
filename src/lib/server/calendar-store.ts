import "server-only";

import { BlobPreconditionFailedError, del, get, list, put } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { calendarEventInputSchema, calendarEventPatchSchema, calendarEventSchema, calendarMemberStatusSchema, type CalendarEvent } from "@/lib/contracts/calendar";
import { ApiHttpError } from "./api-security";

export type CalendarViewer = { id: string; email: string; name: string };
const cloudPrefix = "calendar/events/";
const localEventsSchema = z.array(calendarEventSchema).max(100_000);

function cloudEnabled() {
  if (process.env.VERCEL !== "1") return false;
  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) throw new ApiHttpError(503, "CALENDAR_STORAGE_UNAVAILABLE", "协作日历存储尚未配置。");
  return true;
}

function localDirectory() {
  return path.resolve(/* turbopackIgnore: true */ process.env.LUMAFLOW_CALENDAR_DIR || path.join(process.cwd(), ".local-data", "calendar"));
}

function localEventsFile() { return path.join(localDirectory(), "events.json"); }
function cloudPath(id: string) { return `${cloudPrefix}${id}.json`; }

async function readLocalEvents(): Promise<CalendarEvent[]> {
  try { return localEventsSchema.parse(JSON.parse(await readFile(localEventsFile(), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function mutateLocalEvents<T>(operation: (events: CalendarEvent[]) => T): Promise<T> {
  const root = localDirectory();
  await mkdir(root, { recursive: true });
  const lockPath = path.join(root, "write.lock");
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; !lock; attempt += 1) {
    try { lock = await open(lockPath, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const temporary = path.join(root, `${randomUUID()}.tmp`);
  try {
    const events = await readLocalEvents();
    const result = operation(events);
    await writeFile(temporary, JSON.stringify(localEventsSchema.parse(events), null, 2), { flag: "wx", mode: 0o600 });
    await rename(temporary, localEventsFile());
    return result;
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}

async function getCloudEvent(id: string): Promise<{ event: CalendarEvent; etag: string } | null> {
  const result = await get(cloudPath(id), { access: "private" });
  if (!result || result.statusCode !== 200) return null;
  return { event: calendarEventSchema.parse(await new Response(result.stream).json()), etag: result.blob.etag };
}

async function listCloudEvents(): Promise<CalendarEvent[]> {
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: cloudPrefix, cursor, limit: 1000 });
    paths.push(...page.blobs.map((item) => item.pathname).filter((pathname) => pathname.startsWith(cloudPrefix) && pathname.endsWith(".json")));
    if (paths.length > 10_000) throw new ApiHttpError(503, "CALENDAR_CAPACITY", "协作日历事件过多，请缩小工作区范围。");
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const events: CalendarEvent[] = [];
  for (let offset = 0; offset < paths.length; offset += 20) {
    const batch = await Promise.all(paths.slice(offset, offset + 20).map(async (pathname) => {
      const id = pathname.slice(cloudPrefix.length, -5);
      if (!z.uuid().safeParse(id).success) return null;
      return (await getCloudEvent(id))?.event ?? null;
    }));
    events.push(...batch.filter((event): event is CalendarEvent => Boolean(event)));
  }
  return events;
}

function visibleTo(event: CalendarEvent, viewer: CalendarViewer) {
  return viewer.id === event.createdById || event.participantEmails.includes(viewer.email);
}

export async function getCalendarEventForViewer(viewer: CalendarViewer, id: string) {
  const event = cloudEnabled() ? (await getCloudEvent(id))?.event : (await readLocalEvents()).find((item) => item.id === id);
  if (!event || !visibleTo(event, viewer)) throw new ApiHttpError(404, "CALENDAR_NOT_FOUND", "日程不存在或无权访问。");
  return event;
}

export async function listCalendarEventsForViewer(viewer: CalendarViewer, from: string, to: string) {
  const all = cloudEnabled() ? await listCloudEvents() : await readLocalEvents();
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  return all.filter((event) => visibleTo(event, viewer) && Date.parse(event.startAt) < toMs && Date.parse(event.endAt) > fromMs)
    .sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id));
}

export async function createCalendarEventForViewer(viewer: CalendarViewer, raw: z.input<typeof calendarEventInputSchema>) {
  const input = calendarEventInputSchema.parse(raw);
  const now = new Date().toISOString();
  const event = calendarEventSchema.parse({
    ...input,
    id: randomUUID(),
    status: "confirmed",
    participantEmails: [...new Set(input.participantEmails.filter((email) => email !== viewer.email))],
    memberStatuses: Object.fromEntries([viewer.email, ...input.participantEmails].map((email) => [email, email === viewer.email && input.kind === "meeting" ? "accepted" : "pending"])),
    memberNames: { [viewer.email]: viewer.name },
    createdById: viewer.id,
    createdByEmail: viewer.email,
    createdByName: viewer.name,
    updatedByName: viewer.name,
    createdAt: now,
    updatedAt: now,
    revision: randomUUID(),
  });
  if (cloudEnabled()) {
    await put(cloudPath(event.id), JSON.stringify(event), { access: "private", contentType: "application/json", cacheControlMaxAge: 0 });
  } else {
    await mutateLocalEvents((events) => { events.push(event); });
  }
  return event;
}

export async function updateCalendarEventForViewer(viewer: CalendarViewer, id: string, raw: z.input<typeof calendarEventPatchSchema>) {
  const patch = calendarEventPatchSchema.parse(raw);
  const buildUpdated = (current: CalendarEvent) => {
    if (!visibleTo(current, viewer)) throw new ApiHttpError(404, "CALENDAR_NOT_FOUND", "日程不存在或无权访问。");
    if (current.revision !== patch.revision) throw new ApiHttpError(409, "CALENDAR_CONFLICT", "日程已被其他成员修改，请刷新后重试。");
    const changes = { ...patch };
    delete (changes as Partial<typeof changes>).revision;
    const normalized = calendarEventInputSchema.parse({
      title: changes.title ?? current.title,
      description: changes.description ?? current.description,
      startAt: changes.startAt ?? current.startAt,
      endAt: changes.endAt ?? current.endAt,
      allDay: changes.allDay ?? current.allDay,
      kind: changes.kind ?? current.kind,
      participantEmails: changes.participantEmails ?? current.participantEmails,
    });
    const participantEmails = [...new Set(normalized.participantEmails.filter((email) => email !== current.createdByEmail))];
    return calendarEventSchema.parse({ ...current, ...normalized, ...changes,
      participantEmails,
      memberStatuses: Object.fromEntries([current.createdByEmail, ...participantEmails].map((email) => [email, current.memberStatuses[email] ?? (email === current.createdByEmail && current.kind === "meeting" ? "accepted" : "pending")])),
      memberNames: Object.fromEntries([current.createdByEmail, ...participantEmails].filter((email) => current.memberNames[email]).map((email) => [email, current.memberNames[email]])),
      updatedByName: viewer.name,
      updatedAt: new Date().toISOString(),
      revision: randomUUID(),
    });
  };
  if (cloudEnabled()) {
    const current = await getCloudEvent(id);
    if (!current) throw new ApiHttpError(404, "CALENDAR_NOT_FOUND", "日程不存在或无权访问。");
    const updated = buildUpdated(current.event);
    try {
      await put(cloudPath(id), JSON.stringify(updated), { access: "private", allowOverwrite: true, ifMatch: current.etag, contentType: "application/json", cacheControlMaxAge: 0 });
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new ApiHttpError(409, "CALENDAR_CONFLICT", "日程已被其他成员修改，请刷新后重试。");
      throw error;
    }
    return updated;
  }
  return mutateLocalEvents((events) => {
    const index = events.findIndex((event) => event.id === id);
    if (index < 0) throw new ApiHttpError(404, "CALENDAR_NOT_FOUND", "日程不存在或无权访问。");
    const updated = buildUpdated(events[index]);
    events[index] = updated;
    return updated;
  });
}

export async function setCalendarMemberStatusForViewer(viewer: CalendarViewer, id: string, raw: { revision: string; status: string }) {
  const input = z.object({ revision: z.uuid(), status: calendarMemberStatusSchema }).strict().parse(raw);
  const buildUpdated = (current: CalendarEvent) => {
    if (!visibleTo(current, viewer)) throw new ApiHttpError(404, "CALENDAR_NOT_FOUND", "日程不存在或无权访问。");
    if (current.revision !== input.revision) throw new ApiHttpError(409, "CALENDAR_CONFLICT", "日程已被其他成员修改，请刷新后重试。");
    const allowed = current.kind === "meeting" ? ["pending", "accepted", "declined"] : ["pending", "in_progress", "done"];
    if (!allowed.includes(input.status)) throw new ApiHttpError(422, "CALENDAR_STATUS_INVALID", "此事件类型不支持该参与状态。");
    return calendarEventSchema.parse({ ...current,
      memberStatuses: { ...current.memberStatuses, [viewer.email]: input.status },
      memberNames: { ...current.memberNames, [viewer.email]: viewer.name },
      updatedByName: viewer.name,
      updatedAt: new Date().toISOString(),
      revision: randomUUID(),
    });
  };
  if (cloudEnabled()) {
    const current = await getCloudEvent(id);
    if (!current) throw new ApiHttpError(404, "CALENDAR_NOT_FOUND", "日程不存在或无权访问。");
    const updated = buildUpdated(current.event);
    try {
      await put(cloudPath(id), JSON.stringify(updated), { access: "private", allowOverwrite: true, ifMatch: current.etag, contentType: "application/json", cacheControlMaxAge: 0 });
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new ApiHttpError(409, "CALENDAR_CONFLICT", "日程已被其他成员修改，请刷新后重试。");
      throw error;
    }
    return updated;
  }
  return mutateLocalEvents((events) => {
    const index = events.findIndex((event) => event.id === id);
    if (index < 0) throw new ApiHttpError(404, "CALENDAR_NOT_FOUND", "日程不存在或无权访问。");
    const updated = buildUpdated(events[index]);
    events[index] = updated;
    return updated;
  });
}

export async function deleteCalendarEventForViewer(viewer: CalendarViewer, id: string, revision: string) {
  const checkedRevision = z.uuid().parse(revision);
  const authorize = (event: CalendarEvent) => {
    if (event.createdById !== viewer.id) throw new ApiHttpError(403, "CALENDAR_DELETE_FORBIDDEN", "只有创建人可以删除这条事件。");
    if (event.revision !== checkedRevision) throw new ApiHttpError(409, "CALENDAR_CONFLICT", "日程已被其他成员修改，请刷新后再删除。");
  };
  if (cloudEnabled()) {
    const current = await getCloudEvent(id);
    if (!current) throw new ApiHttpError(404, "CALENDAR_NOT_FOUND", "日程不存在或已删除。");
    authorize(current.event);
    try { await del(cloudPath(id), { ifMatch: current.etag }); }
    catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new ApiHttpError(409, "CALENDAR_CONFLICT", "日程已被其他成员修改，请刷新后再删除。");
      throw error;
    }
    return { id };
  }
  return mutateLocalEvents((events) => {
    const index = events.findIndex((event) => event.id === id);
    if (index < 0) throw new ApiHttpError(404, "CALENDAR_NOT_FOUND", "日程不存在或已删除。");
    authorize(events[index]);
    events.splice(index, 1);
    return { id };
  });
}
