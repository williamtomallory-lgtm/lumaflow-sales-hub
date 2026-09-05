import { listQuerySchema } from "@/lib/contracts/api";
import { apiError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";
import { getDataSnapshot } from "@/lib/server/data-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request);
    const query = listQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const snapshot = await getDataSnapshot();
    const normalized = query.q.toLowerCase();
    const filtered = snapshot.customers.filter((customer) => !normalized || `${customer.company}${customer.name}${customer.industry}${customer.location}${customer.tags.join("")}`.toLowerCase().includes(normalized));
    const data = filtered.slice(query.offset, query.offset + query.limit);
    return apiJson({ data, meta: { apiVersion: "v1", requestId: id, source: snapshot.source, total: filtered.length, limit: query.limit, offset: query.offset } }, 200, id);
  } catch (error) {
    return apiError(error, id);
  }
}
