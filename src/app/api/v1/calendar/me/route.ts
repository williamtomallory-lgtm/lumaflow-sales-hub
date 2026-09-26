import { apiError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";
import { calendarCorsHeaders, calendarOptions, getCalendarRequestViewer } from "@/lib/server/calendar-shared-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = calendarOptions;

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 120);
    const viewer = await getCalendarRequestViewer(request);
    return apiJson({ data: viewer }, 200, id, calendarCorsHeaders(request));
  } catch (error) { const response = apiError(error, id); for (const [key, value] of Object.entries(calendarCorsHeaders(request))) response.headers.set(key, value); return response; }
}
