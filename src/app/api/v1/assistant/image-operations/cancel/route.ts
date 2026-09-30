import { z } from "zod";
import { ApiHttpError, apiError, apiJson, authorizeAssistantRequest, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const id = requestId(request);
  try {
    authorizeAssistantRequest(request);
    enforceRateLimit(request, 30);
    if (process.env.VERCEL === "1" || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) throw new ApiHttpError(403, "LOCAL_IMAGE_ONLY", "仅可停止本机图片任务。");
    const body = await readValidatedJson(request, z.object({ jobId: z.string().uuid() }).strict(), 512);
    const response = await fetch("http://127.0.0.1:8084/v1/image-operations/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new ApiHttpError(503, "IMAGE_CANCEL_FAILED", "图片任务暂时无法停止，请稍后重试。");
    const result = z.object({ data: z.object({ cancelled: z.boolean() }) }).parse(await response.json());
    return apiJson(result, 200, id);
  } catch (error) { return apiError(error, id); }
}
