import { assistantHealthResponseSchema } from "@/lib/contracts/api";
import { getModelHealth } from "@/lib/ai/model-config";
import { apiError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 60);
    const data = await getModelHealth();
    return apiJson(assistantHealthResponseSchema.parse({
      data,
      meta: { apiVersion: "v1", requestId: id, checkedAt: new Date().toISOString() },
    }), 200, id);
  } catch (error) {
    return apiError(error, id);
  }
}
