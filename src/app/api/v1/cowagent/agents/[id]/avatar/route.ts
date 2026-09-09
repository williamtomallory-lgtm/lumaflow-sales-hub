import { apiError, apiJson, authorizeAssistantRequest, authorizeLocalKnowledgeRead, enforceRateLimit, requestId, ApiHttpError } from "@/lib/server/api-security";
import { cowAgentIdSchema } from "@/lib/contracts/cowagent-agent";
import { readCowAgentAvatar, uploadCowAgentAvatar } from "@/lib/server/cowagent-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  try {
    authorizeLocalKnowledgeRead(request);
    enforceRateLimit(request, 60);
    const { id } = await context.params;
    const parsedId = cowAgentIdSchema.safeParse(id);
    if (!parsedId.success) throw new ApiHttpError(422, "INVALID_AGENT_ID", "智能体 ID 无效。");
    const avatar = await readCowAgentAvatar(parsedId.data);
    const body = new ArrayBuffer(avatar.bytes.byteLength);
    new Uint8Array(body).set(avatar.bytes);
    return new Response(body, { status: 200, headers: { "content-type": avatar.contentType, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff", "x-request-id": requestIdentifier } });
  } catch (error) { return apiError(error, requestIdentifier); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  try {
    authorizeLocalKnowledgeRead(request);
    authorizeAssistantRequest(request);
    enforceRateLimit(request, 10);
    const { id } = await context.params;
    const parsedId = cowAgentIdSchema.safeParse(id);
    if (!parsedId.success) throw new ApiHttpError(422, "INVALID_AGENT_ID", "智能体 ID 无效。");
    const form = await request.formData();
    const avatar = form.get("avatar");
    if (!(avatar instanceof File) || avatar.size === 0) throw new ApiHttpError(422, "AVATAR_REQUIRED", "请选择头像文件。");
    if (avatar.size > 2 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(avatar.type)) {
      throw new ApiHttpError(422, "AVATAR_INVALID", "头像仅支持 PNG、JPG、WebP 或 GIF，且不能超过 2 MB。");
    }
    await uploadCowAgentAvatar(parsedId.data, avatar);
    return apiJson({ data: { uploaded: true } }, 200, requestIdentifier);
  } catch (error) { return apiError(error, requestIdentifier); }
}
