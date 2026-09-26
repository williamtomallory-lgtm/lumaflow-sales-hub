import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { z } from "zod";
import { ApiHttpError, apiError, apiJson, authorizeAssistantRequest, authorizeLocalKnowledgeRead, readValidatedJson, requestId } from "@/lib/server/api-security";
import { projectWorkspacePath, requireProject } from "@/lib/server/projects";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const id = requestId(request);
  try {
    if (process.env.VERCEL === "1" || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) throw new ApiHttpError(403, "LOCAL_PROJECT_ONLY", "请在本机打开项目工作目录。");
    authorizeLocalKnowledgeRead(request); authorizeAssistantRequest(request);
    const body = await readValidatedJson(request, z.object({ projectId: z.string().uuid() }).strict());
    const project = await requireProject(body.projectId);
    if (project.workspace === projectWorkspacePath(project.id)) await mkdir(project.workspace, { recursive: true });
    if (!(await stat(project.workspace).catch(() => null))?.isDirectory()) throw new ApiHttpError(422, "PROJECT_WORKSPACE_MISSING", "项目工作目录不存在，请编辑项目重新选择文件夹。");
    if (process.platform !== "win32") throw new ApiHttpError(422, "WINDOWS_EXPLORER_REQUIRED", "请在 Windows 本机打开资源管理器。");
    await new Promise<void>((resolve, reject) => {
      const process = spawn("explorer.exe", [project.workspace], { windowsHide: true, stdio: "ignore", detached: true });
      process.once("error", () => reject(new ApiHttpError(503, "EXPLORER_FAILED", "无法打开资源管理器。")));
      process.once("spawn", () => { process.unref(); resolve(); });
    });
    return apiJson({ data: { opened: true, workspace: project.workspace } }, 200, id);
  } catch (error) { return apiError(error, id); }
}
