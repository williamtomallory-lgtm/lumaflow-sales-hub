import { z } from "zod";
import { ApiHttpError, apiError, authorizeAssistantRequest, authorizeLocalKnowledgeRead, readValidatedJson, requestId } from "@/lib/server/api-security";
import { createProject, deleteProject, listProjects, requireProject, updateProject } from "@/lib/server/projects";
import { projectPatchSchema } from "@/lib/contracts/project";
import { listChatSessions } from "@/lib/server/chat-history";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function authorize(request: Request, mutation = false) {
  if (process.env.VERCEL === "1" || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) throw new ApiHttpError(403, "LOCAL_PROJECTS_ONLY", "项目目前保存在本机工作区。");
  authorizeLocalKnowledgeRead(request); if (mutation) authorizeAssistantRequest(request);
}
export async function GET(request: Request) { const id = requestId(request); try { authorize(request); const projectId = new URL(request.url).searchParams.get("id"); return Response.json({ data: projectId ? { project: await requireProject(projectId), chats: (await listChatSessions()).filter((session) => session.projectId === projectId) } : await listProjects() }); } catch (error) { return apiError(error, id); } }
export async function POST(request: Request) { const id = requestId(request); try { authorize(request, true); const body = await readValidatedJson(request, z.object({ name: z.string().trim().min(1).max(80), memoryMode: z.enum(["project-only", "default"]).optional(), knowledgeBaseIds: z.array(z.string().uuid()).max(50).optional() }).strict()); return Response.json({ data: await createProject(body.name, body) }, { status: 201 }); } catch (error) { return apiError(error, id); } }
export async function PATCH(request: Request) { const id = requestId(request); try { authorize(request, true); const projectId = z.string().uuid().parse(new URL(request.url).searchParams.get("id")); const body = await readValidatedJson(request, projectPatchSchema, 2_000_000); return Response.json({ data: await updateProject(projectId, body) }); } catch (error) { return apiError(error, id); } }
export async function DELETE(request: Request) { const id = requestId(request); try { authorize(request, true); await deleteProject(z.string().uuid().parse(new URL(request.url).searchParams.get("id"))); return Response.json({ data: { deleted: true } }); } catch (error) { return apiError(error, id); } }
