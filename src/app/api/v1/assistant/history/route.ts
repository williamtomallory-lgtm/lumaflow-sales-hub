import { ApiHttpError, apiError, authorizeAssistantRequest, authorizeLocalKnowledgeRead, readValidatedJson, requestId } from "@/lib/server/api-security";
import { chatSessionMetadataPatchSchema, chatSessionSchema } from "@/lib/contracts/chat-history";
import { deleteChatSession, listChatSessions, readChatSession, saveChatSession, updateChatSessionMetadata } from "@/lib/server/chat-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertLocal(request: Request) {
  if (process.env.VERCEL === "1" || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) {
    throw new ApiHttpError(403, "LOCAL_HISTORY_ONLY", "对话记录只保存在当前电脑的本地项目中。");
  }
}

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    assertLocal(request); authorizeLocalKnowledgeRead(request);
    const params = new URL(request.url).searchParams;
    const sessionId = params.get("id");
    const data = sessionId ? await readChatSession(sessionId) : await listChatSessions((params.get("q") ?? "").slice(0, 160));
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, id); }
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    assertLocal(request); authorizeAssistantRequest(request);
    const session = await readValidatedJson(request, chatSessionSchema, 2_100_000);
    return Response.json({ data: await saveChatSession(session) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, id); }
}

export async function PATCH(request: Request) {
  const id = requestId(request);
  try {
    assertLocal(request); authorizeAssistantRequest(request);
    const sessionId = new URL(request.url).searchParams.get("id");
    if (!sessionId) throw new ApiHttpError(422, "SESSION_ID_REQUIRED", "请选择要修改的对话。");
    if (!(await readChatSession(sessionId))) throw new ApiHttpError(404, "SESSION_NOT_FOUND", "对话记录不存在。");
    const patch = await readValidatedJson(request, chatSessionMetadataPatchSchema);
    return Response.json({ data: await updateChatSessionMetadata(sessionId, patch) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, id); }
}

export async function DELETE(request: Request) {
  const id = requestId(request);
  try {
    assertLocal(request); authorizeAssistantRequest(request);
    const sessionId = new URL(request.url).searchParams.get("id");
    if (!sessionId) throw new ApiHttpError(422, "SESSION_ID_REQUIRED", "请选择要删除的对话。");
    await deleteChatSession(sessionId);
    return Response.json({ data: { deleted: true } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, id); }
}
