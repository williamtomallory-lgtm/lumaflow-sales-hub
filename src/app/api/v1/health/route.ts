import { apiError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";
import { getDatabaseHealth, getDataSnapshot } from "@/lib/server/data-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 60);
    const [database, snapshot] = await Promise.all([getDatabaseHealth(), getDataSnapshot()]);
    return apiJson({
      data: {
        status: database.configured && !database.reachable ? "degraded" : "ok",
        source: snapshot.source,
        database,
      },
      meta: { apiVersion: "v1", requestId: id, checkedAt: new Date().toISOString() },
    }, 200, id);
  } catch (error) {
    return apiError(error, id);
  }
}
