import { apiError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";
import { authorizeWorkEngineBrowser, getWorkEngineStatus } from "@/lib/server/work-engine";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const id = requestId(request);
  try { authorizeWorkEngineBrowser(request); enforceRateLimit(request, 60); return apiJson({ data: await getWorkEngineStatus() }, 200, id); }
  catch (error) { return apiError(error, id); }
}
