import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assistantModelProfileIdSchema } from "@/lib/contracts/api";
import { ensureLocalModel, leaseLocalModel } from "@/lib/ai/local-model-runtime";
import { ApiHttpError, apiError, apiJson, authorizeAssistantRequest, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const file = z.object({
  type: z.literal("file"),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  filename: z.string().max(160).optional(),
  url: z.string().max(3_600_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
}).strict().refine((item) => item.url.startsWith(`data:${item.mediaType};base64,`));
const bodySchema = z.object({
  prompt: z.string().trim().max(4000),
  operation: z.enum(["generate", "edit", "analyze"]),
  images: z.array(file).max(4).default([]),
  restoreModelProfileId: assistantModelProfileIdSchema.optional(),
  jobId: z.string().uuid().optional(),
}).strict().refine((body) => body.operation === "generate" || body.images.length > 0, "An uploaded image is required")
  .refine((body) => body.images.reduce((sum, item) => sum + item.url.length, 0) <= 3_600_000, "Image attachments exceed the request limit");

export async function POST(request: Request) {
  const id = requestId(request);
  let release = () => {};
  let restore: z.infer<typeof assistantModelProfileIdSchema> | undefined;
  try {
    authorizeAssistantRequest(request);
    enforceRateLimit(request, 10);
    if (process.env.VERCEL === "1" || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) {
      throw new ApiHttpError(403, "LOCAL_IMAGE_ONLY", "图片处理仅在你电脑上的本机项目开放。");
    }
    const body = await readValidatedJson(request, bodySchema, 4 * 1024 * 1024);
    const checkpoint = path.join(process.cwd(), ".local-data/models/Qwen-Image-2.1-3GB/LOCAL_IMAGE_MODEL.json");
    if (!existsSync(checkpoint)) throw new ApiHttpError(503, "IMAGE_MODEL_NOT_INSTALLED", "Qwen-Image-2.1 本机压缩权重尚未安装完成，暂时无法生成或编辑图片。");
    restore = body.restoreModelProfileId;
    release = await leaseLocalModel("image");
    const jobId = body.jobId ?? crypto.randomUUID();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(590_000)]);
    const cancel = () => { void fetch("http://127.0.0.1:8084/v1/image-operations/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId }), signal: AbortSignal.timeout(2000) }).catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) throw new ApiHttpError(499, "IMAGE_OPERATION_CANCELLED", "图片操作已停止。");
    let response: Response;
    try {
      response = await fetch("http://127.0.0.1:8084/v1/image-operations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, jobId }), signal,
      });
    } finally { signal.removeEventListener("abort", cancel); }
    const payload = await response.json();
    if (payload?.error?.code === "IMAGE_OPERATION_CANCELLED") throw new ApiHttpError(499, "IMAGE_OPERATION_CANCELLED", "图片操作已停止。");
    if (!response.ok || !payload.data) throw new ApiHttpError(503, "IMAGE_OPERATION_FAILED", "本机图片模型处理失败，请缩小图片或稍后重试。");
    const images = z.array(z.object({ filename: z.string().regex(/^[a-f0-9]{32}\.png$/), width: z.number().int().positive(), height: z.number().int().positive() })).parse(payload.data.images);
    return apiJson({ data: {
      text: z.string().parse(payload.data.text), operation: body.operation, model: "Qwen/Qwen-Image-2.1",
      images: images.map((image) => ({ ...image, url: `/api/v1/assistant/image-operations/assets/${image.filename}` })),
    } }, 200, id);
  } catch (error) { return apiError(error, id); }
  finally {
    release();
    if (restore) {
      // A cancelled fetch can finish before the worker has released its CUDA
      // tensors. Let cooperative cancellation settle before changing models.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const response = await fetch("http://127.0.0.1:8084/health", { signal: AbortSignal.timeout(1500), cache: "no-store" });
          const health = await response.json();
          if (!health.busy) break;
        } catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await ensureLocalModel(restore).catch((error) => console.error("Image operation finished; text model restore failed:", error instanceof Error ? error.message : "unknown"));
    }
  }
}
