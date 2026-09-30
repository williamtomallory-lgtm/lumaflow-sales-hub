import { randomUUID } from "node:crypto";
import { createFollowupSchema, followupListQuerySchema } from "@/lib/contracts/api";
import { ApiHttpError, apiError, apiJson, authorizeWrite, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { createFollowup, getDataSnapshot } from "@/lib/server/data-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 30); authorizeWrite(request);
    const input = await readValidatedJson(request, createFollowupSchema);
    const snapshot = await getDataSnapshot();
    const customer = snapshot.customers.find((item) => item.id === input.customerId);
    if (!customer) throw new ApiHttpError(404, "CUSTOMER_NOT_FOUND", "客户不存在，请刷新客户列表");
    const data = await createFollowup({ ...input, id: `task-${randomUUID()}`, customerName: customer.name, company: customer.company, status: "open", dueLabel: input.dueAt, createdAt: new Date().toISOString() }, id);
    return apiJson({ data, meta: { apiVersion: "v1", requestId: id } }, 201, id);
  } catch (error) { return apiError(error, id); }
}

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
