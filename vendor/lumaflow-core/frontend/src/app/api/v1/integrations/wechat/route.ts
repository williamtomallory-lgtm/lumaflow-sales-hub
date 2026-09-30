import { apiError, apiJson, authorizeLocalKnowledgeRead, authorizeAssistantRequest, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { wechatActionSchema } from "@/lib/contracts/wechat";
import { connectWechat, detectWechat, disconnectWechat, readWechat } from "@/lib/server/wechat-desktop";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const id = requestId(request);
  try { authorizeLocalKnowledgeRead(request); enforceRateLimit(request, 30); return apiJson({ data: await detectWechat() }, 200, id); }
  catch (error) { return apiError(error, id); }
}
export async function POST(request: Request) {
  const id = requestId(request);
  try {
    authorizeLocalKnowledgeRead(request); authorizeAssistantRequest(request); enforceRateLimit(request, 30);
    const body = await readValidatedJson(request, wechatActionSchema);
    if (body.action === "connect") return apiJson({ data: await connectWechat(body.processId) }, 200, id);
    if (body.action === "read") return apiJson({ data: await readWechat(body.connectionId, body.limit) }, 200, id);
    disconnectWechat(body.connectionId); return apiJson({ data: { disconnected: true } }, 200, id);
  } catch (error) { return apiError(error, id); }
}
