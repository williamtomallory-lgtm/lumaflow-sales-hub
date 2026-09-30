import { assistantModelsResponseSchema } from "@/lib/contracts/api";
import { getDefaultModelProfileId, getModelOptions } from "@/lib/ai/model-config";
import { apiError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 60);
    return apiJson(assistantModelsResponseSchema.parse({
      data: { defaultProfileId: getDefaultModelProfileId(), models: await getModelOptions() },
      meta: { apiVersion: "v1", requestId: id },
    }), 200, id);
  } catch (error) {
    return apiError(error, id);
  }
}
