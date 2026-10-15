import { apiError, apiJson, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { authorizeWorkEngineBrowser } from "@/lib/server/work-engine";
import { workEngineRouteRequestSchema } from "@/lib/contracts/work-engine";
import { routeWorkCapability } from "@/lib/ai/work-capability-routing";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const id = requestId(request);
  try {
    authorizeWorkEngineBrowser(request, true); enforceRateLimit(request, 30);
    const body = await readValidatedJson(request, workEngineRouteRequestSchema);
    return apiJson({ data: await routeWorkCapability(body.text) }, 200, id);
  } catch (error) { return apiError(error, id); }
}
