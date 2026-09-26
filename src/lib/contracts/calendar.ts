import { z } from "zod";

const email = z.email().max(254).transform((value) => value.toLowerCase());
const instant = z.string().datetime({ offset: true });

export const calendarKindSchema = z.enum(["meeting", "task", "focus", "followup"]);
export const calendarStatusSchema = z.enum(["confirmed", "completed", "cancelled"]);
export const calendarMemberStatusSchema = z.enum(["pending", "accepted", "declined", "in_progress", "done"]);

export const calendarEventInputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(5_000).default(""),
  startAt: instant,
  endAt: instant,
  allDay: z.boolean().default(false),
  kind: calendarKindSchema,
  participantEmails: z.array(email).max(30).default([]),
}).strict().superRefine((value, context) => {
  const start = Date.parse(value.startAt);
  const end = Date.parse(value.endAt);
  if (end <= start) context.addIssue({ code: "custom", path: ["endAt"], message: "结束时间必须晚于开始时间" });
  if (end - start > 31 * 86_400_000) context.addIssue({ code: "custom", path: ["endAt"], message: "单个日程最长为 31 天" });
});

export const calendarEventPatchSchema = z.object({
  revision: z.string().uuid(),
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().trim().max(5_000).optional(),
  startAt: instant.optional(),
  endAt: instant.optional(),
  allDay: z.boolean().optional(),
  kind: calendarKindSchema.optional(),
  status: calendarStatusSchema.optional(),
  participantEmails: z.array(email).max(30).optional(),
}).strict();

export const calendarEventSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  startAt: instant,
  endAt: instant,
  allDay: z.boolean(),
  kind: calendarKindSchema,
  status: calendarStatusSchema,
  participantEmails: z.array(email),
  memberStatuses: z.record(z.string(), calendarMemberStatusSchema).default({}),
  memberNames: z.record(z.string(), z.string()).default({}),
  createdById: z.string(),
  createdByEmail: email,
  createdByName: z.string(),
  updatedByName: z.string(),
  createdAt: instant,
  updatedAt: instant,
  revision: z.string().uuid(),
});

export const calendarRangeSchema = z.object({
  from: instant,
  to: instant,
}).superRefine((value, context) => {
  const span = Date.parse(value.to) - Date.parse(value.from);
  if (span <= 0 || span > 366 * 86_400_000) context.addIssue({ code: "custom", path: ["to"], message: "日历查询范围必须在 1 年内" });
});

export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export type CalendarEventInput = z.input<typeof calendarEventInputSchema>;
export type CalendarEventPatch = z.input<typeof calendarEventPatchSchema>;
export type CalendarMemberStatus = z.infer<typeof calendarMemberStatusSchema>;
