import { calendarEventInputSchema, calendarRangeSchema } from "@/lib/contracts/calendar";
import { ApiHttpError, apiError, apiJson, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { calendarCorsHeaders, calendarOptions, getCalendarRequestViewer } from "@/lib/server/calendar-shared-auth";
import { createCalendarEventForViewer, listCalendarEventsForViewer } from "@/lib/server/calendar-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = calendarOptions;

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 120);
    const viewer = await getCalendarRequestViewer(request);
    const params = new URL(request.url).searchParams;
    const range = calendarRangeSchema.safeParse({ from: params.get("from"), to: params.get("to") });
    if (!range.success) throw new ApiHttpError(422, "CALENDAR_RANGE_INVALID", "请选择不超过一年的有效日历范围。");
    return apiJson({ data: await listCalendarEventsForViewer(viewer, range.data.from, range.data.to) }, 200, id, { ...calendarCorsHeaders(request), "Cache-Control": "private, no-store" });
  } catch (error) { const response = apiError(error, id); for (const [key, value] of Object.entries(calendarCorsHeaders(request))) response.headers.set(key, value); return response; }
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 30);
    const viewer = await getCalendarRequestViewer(request, true);
    const input = await readValidatedJson(request, calendarEventInputSchema);
    return apiJson({ data: await createCalendarEventForViewer(viewer, input) }, 201, id, calendarCorsHeaders(request));
  } catch (error) { const response = apiError(error, id); for (const [key, value] of Object.entries(calendarCorsHeaders(request))) response.headers.set(key, value); return response; }
}
