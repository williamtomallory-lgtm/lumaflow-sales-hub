import { readFile } from "node:fs/promises";
import path from "node:path";
import { ApiHttpError, apiError, authorizeLocalKnowledgeRead, requestId } from "@/lib/server/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ filename: string }> }) {
  const id = requestId(request);
  try {
    if (process.env.VERCEL === "1" || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) throw new ApiHttpError(403, "LOCAL_IMAGE_ONLY", "生成图片保存在当前电脑中。");
    authorizeLocalKnowledgeRead(request);
    const { filename } = await context.params;
    if (!/^[a-f0-9]{32}\.png$/.test(filename)) throw new ApiHttpError(404, "IMAGE_NOT_FOUND", "图片不存在。");
    const image = await readFile(path.join(process.cwd(), ".local-data/generated-images", filename)).catch(() => null);
    if (!image) throw new ApiHttpError(404, "IMAGE_NOT_FOUND", "图片不存在。");
    return new Response(image, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return apiError(error, id); }
}
