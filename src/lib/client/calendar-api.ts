import { z } from "zod";
import { calendarEventSchema, type CalendarEventInput, type CalendarEventPatch, type CalendarMemberStatus } from "@/lib/contracts/calendar";
import { calendarCloudOrigin, currentCalendarConnection, usesSharedCalendarConnection } from "./calendar-connection";

const eventResponse = z.object({ data: calendarEventSchema });
const eventsResponse = z.object({ data: z.array(calendarEventSchema) });

async function calendarRequest(path: string, init: RequestInit = {}) {
  const local = usesSharedCalendarConnection();
  const connection = local ? currentCalendarConnection() : null;
  if (local && !connection) throw new Error("请先连接云端协作日历。每位成员需用自己的账号登录。");
  const response = await fetch(local ? `${calendarCloudOrigin}${path}` : path, {
    ...init,
    cache: "no-store",
    headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(connection ? { Authorization: `Bearer ${connection.token}` } : {}), ...init.headers },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const result = payload as { error?: { code?: string; message?: string } } | null;
    throw new Error(result?.error?.message || `日历服务返回 ${response.status}`);
  }
  return payload;
}

export async function getCalendarIdentity() {
  return z.object({ data: z.object({ id: z.string(), email: z.email(), name: z.string() }) }).parse(await calendarRequest("/api/v1/calendar/me")).data;
}

export type CalendarPresence = Record<string, { name: string; lastSeenAt: string; online: boolean }>;

export async function listCalendarPresence(range: { from: string; to: string }): Promise<CalendarPresence> {
  const params = new URLSearchParams(range);
  return z.object({ data: z.record(z.string(), z.object({ name: z.string(), lastSeenAt: z.string(), online: z.boolean() })) }).parse(await calendarRequest(`/api/v1/calendar/presence?${params}`)).data;
}

export async function sendCalendarHeartbeat() {
  await calendarRequest("/api/v1/calendar/presence", { method: "POST" });
}

export async function listCalendarEvents(range: { from: string; to: string }) {
  const params = new URLSearchParams(range);
  return eventsResponse.parse(await calendarRequest(`/api/v1/calendar/events?${params}`)).data;
}

export async function getCalendarEvent(id: string) {
  return eventResponse.parse(await calendarRequest(`/api/v1/calendar/events/${encodeURIComponent(id)}`)).data;
}

export async function createCalendarEvent(input: CalendarEventInput) {
  return eventResponse.parse(await calendarRequest("/api/v1/calendar/events", { method: "POST", body: JSON.stringify(input) })).data;
}

export async function updateCalendarEvent(id: string, patch: CalendarEventPatch) {
  return eventResponse.parse(await calendarRequest(`/api/v1/calendar/events/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) })).data;
}

export async function updateCalendarMemberStatus(id: string, revision: string, status: CalendarMemberStatus) {
  return eventResponse.parse(await calendarRequest(`/api/v1/calendar/events/${encodeURIComponent(id)}/member-status`, { method: "PATCH", body: JSON.stringify({ revision, status }) })).data;
}

export async function deleteCalendarEvent(id: string, revision: string) {
  return z.object({ data: z.object({ id: z.uuid() }) }).parse(await calendarRequest(`/api/v1/calendar/events/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ revision }) })).data;
}
