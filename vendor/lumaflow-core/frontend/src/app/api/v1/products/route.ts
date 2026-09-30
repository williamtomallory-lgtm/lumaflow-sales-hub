import { randomUUID } from "node:crypto";
import { createProductSchema, productListQuerySchema, productSchema } from "@/lib/contracts/api";
import { apiError, apiJson, authorizeWrite, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { createProduct, getDataSnapshot } from "@/lib/server/data-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request);
    const url = new URL(request.url);
    const query = productListQuerySchema.parse(Object.fromEntries(url.searchParams));
    const snapshot = await getDataSnapshot();
    const normalized = query.q.toLowerCase();
    const filtered = snapshot.products.filter((product) => {
      const categoryMatches = !query.category || product.category === query.category;
      const queryMatches = !normalized || `${product.name}${product.model}${product.sku}${product.category}${product.material}${product.scenarios.join("")}`.toLowerCase().includes(normalized);
      return categoryMatches && queryMatches;
    });
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
    const input = await readValidatedJson(request, createProductSchema);
    const product = productSchema.parse({ ...input, id: `product-${randomUUID()}` });
    const created = await createProduct(product, id);
    return apiJson({ data: created, meta: { apiVersion: "v1", requestId: id } }, 201, id, { Location: `/api/v1/products/${created.id}` });
  } catch (error) {
    return apiError(error, id);
  }
}
