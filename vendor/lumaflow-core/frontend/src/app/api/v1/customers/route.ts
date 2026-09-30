import { randomUUID } from "node:crypto";
import { createCustomerSchema, customerSchema, listQuerySchema } from "@/lib/contracts/api";
import { apiError, apiJson, authorizeWrite, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { createCustomer, getDataSnapshot } from "@/lib/server/data-repository";

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

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 30);
    authorizeWrite(request);
    const input = await readValidatedJson(request, createCustomerSchema);
    const now = new Date().toISOString();
    const data = customerSchema.parse({
      id: `customer-${randomUUID()}`,
      company: input.company,
      name: input.name,
      role: input.role || "未填写",
      avatar: input.name.slice(0, 1),
      industry: input.industry || "未填写",
      location: input.location || "未填写",
      stage: "新客",
      source: input.source || "手动录入",
      tags: [],
      email: input.email,
      phone: input.phone,
      owner: input.owner || "未分配",
      estimatedValue: 0,
      lastContactAt: now,
      lastContactLabel: "尚无联系记录",
      unreadCount: 0,
      contacts: [],
      conversations: [],
      needs: [],
      quotes: [],
      contextMemory: [],
    });
    const created = await createCustomer(data, id);
    return apiJson({ data: created, meta: { apiVersion: "v1", requestId: id } }, 201, id, { Location: `/api/v1/customers/${created.id}` });
  } catch (error) {
    return apiError(error, id);
  }
}
