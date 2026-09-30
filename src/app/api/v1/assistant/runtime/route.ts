import { assistantModelProfileIdSchema } from "@/lib/contracts/api";
import { getModelHealth } from "@/lib/ai/model-config";
import { ensureLocalModel } from "@/lib/ai/local-model-runtime";
import { ApiHttpError, apiError, authorizeAssistantRequest, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 30);
    authorizeAssistantRequest(request);
    if (process.env.VERCEL === "1" || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) {
      throw new ApiHttpError(403, "LOCAL_RUNTIME_ONLY", "模型按需加载只允许在本机 LumaFlow 中执行。");
    }
    const profile = await readValidatedJson(request, assistantModelProfileIdSchema);
    const started = performance.now();
    const managed = await ensureLocalModel(profile);
    const health = await getModelHealth(profile);
    if (managed && !health.reachable) throw new ApiHttpError(503, "LOCAL_MODEL_NOT_READY", "所选模型加载后未通过连接检查，请重试。");
    return Response.json({ data: { profile, ready: health.reachable, managed, elapsedMs: Math.round(performance.now() - started) }, meta: { apiVersion: "v1", requestId: id } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, id); }
}
