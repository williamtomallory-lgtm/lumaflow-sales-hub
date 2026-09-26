import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiHttpError } from "./api-security";
import { getWorkAuth } from "./work-auth";
import type { CalendarViewer } from "./calendar-store";

export async function getCalendarViewer(): Promise<CalendarViewer> {
  if (process.env.VERCEL !== "1") return { id: "local", email: "local@lumaflow.invalid", name: "本机用户" };
  const auth = getWorkAuth();
  if (!auth) throw new ApiHttpError(503, "CALENDAR_AUTH_UNAVAILABLE", "协作日历登录尚未配置。");
  const session = await auth.getSession();
  if (!session?.user.sub) throw new ApiHttpError(401, "CALENDAR_LOGIN_REQUIRED", "请先登录 LumaFlow，再使用协作日历。");
  const email = z.email().safeParse(session.user.email?.trim().toLowerCase());
  if (!email.success || session.user.email_verified === false) throw new ApiHttpError(403, "CALENDAR_EMAIL_REQUIRED", "请先在账号中验证邮箱，再使用协作日历。");
  return {
    id: createHash("sha256").update(session.user.sub).digest("hex"),
    email: email.data,
    name: (session.user.name || email.data).slice(0, 120),
  };
}
