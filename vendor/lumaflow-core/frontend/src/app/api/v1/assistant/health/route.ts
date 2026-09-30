import { assistantHealthResponseSchema, assistantModelProfileIdSchema } from "@/lib/contracts/api";
import { getModelHealth } from "@/lib/ai/model-config";
import { apiError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 60);
    const modelProfileId = assistantModelProfileIdSchema.optional().parse(new URL(request.url).searchParams.get("modelProfileId") ?? undefined);
    const data = await getModelHealth(modelProfileId);
    return apiJson(assistantHealthResponseSchema.parse({
      data,
      meta: { apiVersion: "v1", requestId: id, checkedAt: new Date().toISOString() },
    }), 200, id);
  } catch (error) {
    return apiError(error, id);
  }
}
