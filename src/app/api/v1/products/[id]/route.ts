import { resourceIdSchema, updateProductSchema } from "@/lib/contracts/api";
import { ApiHttpError, apiError, apiJson, authorizeWrite, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { getDataSnapshot, updateProduct } from "@/lib/server/data-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProductRouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: ProductRouteContext) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request);
    const id = resourceIdSchema.parse((await context.params).id);
    const snapshot = await getDataSnapshot();
    const product = snapshot.products.find((item) => item.id === id);
    if (!product) throw new ApiHttpError(404, "PRODUCT_NOT_FOUND", "Product not found.");
    return apiJson({ data: product, meta: { apiVersion: "v1", requestId: requestIdentifier, source: snapshot.source } }, 200, requestIdentifier);
  } catch (error) {
    return apiError(error, requestIdentifier);
  }
}

export async function PATCH(request: Request, context: ProductRouteContext) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request, 60);
    authorizeWrite(request);
    const id = resourceIdSchema.parse((await context.params).id);
    const patch = await readValidatedJson(request, updateProductSchema);
    const product = await updateProduct(id, patch, requestIdentifier);
    if (!product) throw new ApiHttpError(404, "PRODUCT_NOT_FOUND", "Product not found.");
    return apiJson({ data: product, meta: { apiVersion: "v1", requestId: requestIdentifier } }, 200, requestIdentifier);
  } catch (error) {
    return apiError(error, requestIdentifier);
  }
}
