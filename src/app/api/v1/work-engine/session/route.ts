import { ApiHttpError, apiError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";
import { authorizeWorkEngineBrowser, createWorkEngineToken, readWorkEngineConfig, workEngineJson } from "@/lib/server/work-engine";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const id = requestId(request);
  try {
    authorizeWorkEngineBrowser(request, true); enforceRateLimit(request, 30);
    const config = await readWorkEngineConfig();
    if (!config) throw new ApiHttpError(503, "WORK_ENGINE_NOT_INSTALLED", "本机能力中心尚未安装。");
    await workEngineJson("/api/auth/me");
    return apiJson({ data: createWorkEngineToken(config) }, 200, id);
  } catch (error) { return apiError(error, id); }
}
