import { z } from "zod";
import { calendarEventPatchSchema } from "@/lib/contracts/calendar";
import { apiError, apiJson, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { calendarCorsHeaders, calendarOptions, getCalendarRequestViewer } from "@/lib/server/calendar-shared-auth";
import { deleteCalendarEventForViewer, getCalendarEventForViewer, updateCalendarEventForViewer } from "@/lib/server/calendar-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = calendarOptions;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request, 120);
    const viewer = await getCalendarRequestViewer(request);
    const { id } = await params;
    const eventId = z.uuid().parse(id);
    return apiJson({ data: await getCalendarEventForViewer(viewer, eventId) }, 200, requestIdentifier, calendarCorsHeaders(request));
  } catch (error) { const response = apiError(error, requestIdentifier); for (const [key, value] of Object.entries(calendarCorsHeaders(request))) response.headers.set(key, value); return response; }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request, 60);
    const viewer = await getCalendarRequestViewer(request, true);
    const { id } = await params;
    const eventId = z.uuid().parse(id);
    const patch = await readValidatedJson(request, calendarEventPatchSchema);
    return apiJson({ data: await updateCalendarEventForViewer(viewer, eventId, patch) }, 200, requestIdentifier, calendarCorsHeaders(request));
  } catch (error) { const response = apiError(error, requestIdentifier); for (const [key, value] of Object.entries(calendarCorsHeaders(request))) response.headers.set(key, value); return response; }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request, 30);
    const viewer = await getCalendarRequestViewer(request, true);
    const { id } = await params;
    const eventId = z.uuid().parse(id);
    const body = await readValidatedJson(request, z.object({ revision: z.uuid() }).strict());
    return apiJson({ data: await deleteCalendarEventForViewer(viewer, eventId, body.revision) }, 200, requestIdentifier, calendarCorsHeaders(request));
  } catch (error) { const response = apiError(error, requestIdentifier); for (const [key, value] of Object.entries(calendarCorsHeaders(request))) response.headers.set(key, value); return response; }
}
