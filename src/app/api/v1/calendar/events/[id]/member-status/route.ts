import { z } from "zod";
import { calendarMemberStatusSchema } from "@/lib/contracts/calendar";
import { apiError, apiJson, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { calendarCorsHeaders, calendarOptions, getCalendarRequestViewer } from "@/lib/server/calendar-shared-auth";
import { setCalendarMemberStatusForViewer } from "@/lib/server/calendar-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = calendarOptions;

const responseSchema = z.object({ revision: z.uuid(), status: calendarMemberStatusSchema }).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 60);
    const viewer = await getCalendarRequestViewer(request, true);
    const { id: eventId } = await params;
    const result = await setCalendarMemberStatusForViewer(viewer, z.uuid().parse(eventId), await readValidatedJson(request, responseSchema));
    return apiJson({ data: result }, 200, id, calendarCorsHeaders(request));
  } catch (error) { const response = apiError(error, id); for (const [key, value] of Object.entries(calendarCorsHeaders(request))) response.headers.set(key, value); return response; }
}
