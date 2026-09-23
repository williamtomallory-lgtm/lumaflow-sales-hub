import { z } from "zod";
import { createCustomerSchema, createFollowupSchema, customerSchema, followupTaskSchema, productSchema } from "../contracts/api";
import type { Product } from "../catalog";
import type { FollowupTaskStatus } from "../crm";

const productMutationResponseSchema = z.object({ data: productSchema, meta: z.object({ apiVersion: z.literal("v1"), requestId: z.string() }) });
const followupMutationResponseSchema = z.object({ data: followupTaskSchema, meta: z.object({ apiVersion: z.literal("v1"), requestId: z.string() }) });
const customerMutationResponseSchema = z.object({ data: customerSchema, meta: z.object({ apiVersion: z.literal("v1"), requestId: z.string() }) });

export class BackendApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "BackendApiError";
  }
}

async function requestJson(path: string, init: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...init.headers },
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = payload as { error?: { code?: string; message?: string } };
    throw new BackendApiError(response.status, error.error?.code ?? "API_ERROR", error.error?.message ?? `Backend returned ${response.status}`);
  }
  return payload;
}

export async function createProductViaApi(product: Omit<Product, "id">) {
  const payload = await requestJson("/api/v1/products", { method: "POST", body: JSON.stringify(product) });
  return productMutationResponseSchema.parse(payload).data;
}

export async function updateFollowupStatusViaApi(taskId: string, status: FollowupTaskStatus) {
  const payload = await requestJson(`/api/v1/followups/${encodeURIComponent(taskId)}`, { method: "PATCH", body: JSON.stringify({ status }) });
  return followupMutationResponseSchema.parse(payload).data;
}

export async function createCustomerViaApi(input: z.input<typeof createCustomerSchema>) {
  return customerMutationResponseSchema.parse(await requestJson("/api/v1/customers", { method: "POST", body: JSON.stringify(input) })).data;
}

export async function createFollowupViaApi(input: z.infer<typeof createFollowupSchema>) {
  return followupMutationResponseSchema.parse(await requestJson("/api/v1/followups", { method: "POST", body: JSON.stringify(input) })).data;
}

export async function listFollowupsViaApi() {
  const all = [];
  for (let offset = 0; ; offset += 100) {
    const page = z.object({ data: z.array(followupTaskSchema), meta: z.object({ total: z.number() }) }).parse(await requestJson(`/api/v1/followups?limit=100&offset=${offset}`, { method: "GET", cache: "no-store" }));
    all.push(...page.data);
    if (all.length >= page.meta.total || !page.data.length) return all;
  }
}
