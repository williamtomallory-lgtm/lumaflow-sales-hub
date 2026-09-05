import { followupListQuerySchema } from "@/lib/contracts/api";
import { apiError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";
import { getDataSnapshot } from "@/lib/server/data-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request);
    const query = followupListQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const snapshot = await getDataSnapshot();
    const normalized = query.q.toLowerCase();
    const filtered = snapshot.followupTasks.filter((task) => {
      const statusMatches = !query.status || task.status === query.status;
      const queryMatches = !normalized || `${task.company}${task.customerName}${task.title}${task.description}`.toLowerCase().includes(normalized);
      return statusMatches && queryMatches;
    });
    const data = filtered.slice(query.offset, query.offset + query.limit);
    return apiJson({ data, meta: { apiVersion: "v1", requestId: id, source: snapshot.source, total: filtered.length, limit: query.limit, offset: query.offset } }, 200, id);
  } catch (error) {
    return apiError(error, id);
  }
}
