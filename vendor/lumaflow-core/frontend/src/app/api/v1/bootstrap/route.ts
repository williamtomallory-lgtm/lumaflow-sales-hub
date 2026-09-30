import { bootstrapResponseSchema } from "@/lib/contracts/api";
import { buildDashboardSummary } from "@/lib/data-snapshot";
import { apiError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";
import { getDataSnapshot } from "@/lib/server/data-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request);
    const data = await getDataSnapshot();
    const response = bootstrapResponseSchema.parse({
      data,
      dashboard: buildDashboardSummary(data),
      meta: { apiVersion: "v1", requestId: id, generatedAt: new Date().toISOString(), source: data.source },
    });
    return apiJson(response, 200, id);
  } catch (error) {
    return apiError(error, id);
  }
}
