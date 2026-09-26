import { z } from "zod";
import { ApiHttpError, apiError, apiJson, authorizeAssistantRequest, authorizeLocalKnowledgeRead, readValidatedJson, requestId } from "@/lib/server/api-security";
import { selectWorkspaceFolder } from "@/lib/server/folder-picker";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const id = requestId(request);
  try {
    if (process.env.VERCEL === "1" || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) throw new ApiHttpError(403, "LOCAL_FOLDER_ONLY", "请在本机页面选择工作目录。");
    authorizeLocalKnowledgeRead(request); authorizeAssistantRequest(request);
    const body = await readValidatedJson(request, z.object({ initialPath: z.string().max(2000).default("") }).strict());
    return apiJson({ data: await selectWorkspaceFolder(body.initialPath, request.signal) }, 200, id);
  } catch (error) { return apiError(error, id); }
}
