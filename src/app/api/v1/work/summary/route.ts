import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { ApiHttpError, apiError, apiJson, authorizeLocalKnowledgeRead, enforceRateLimit, requestId } from "@/lib/server/api-security";
import { getCowAgentProfile } from "@/lib/server/cowagent-client";
import { assertLocalWorkAccess } from "@/lib/ai/work-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const run = promisify(execFile);

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) throw new ApiHttpError(403, "LOCAL_WORK_ONLY", "工作间信息仅在本机显示。");
    authorizeLocalKnowledgeRead(request);
    enforceRateLimit(request, 60);
    const agentId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).parse(new URL(request.url).searchParams.get("agentId"));
    const agent = await getCowAgentProfile(agentId);
    try { assertLocalWorkAccess(agent, "read", "读取工作间状态"); }
    catch { throw new ApiHttpError(403, "WORK_READ_REQUIRED", "当前 Agent 没有读取工作间的权限。"); }
    const workspace = agent.workspace;
    if (!workspace) return apiJson({ data: { workspace: "", projectName: agent.name, git: null } }, 200, id);
    const git = async (args: string[]) => (await run("git", ["-C", workspace, ...args], { timeout: 5000, maxBuffer: 1_000_000, windowsHide: true })).stdout.trim();
    let snapshot: { branch: string; additions: number; deletions: number; changedFiles: number; untrackedFiles: number } | null = null;
    try {
      await git(["rev-parse", "--show-toplevel"]);
      const [branch, diff, status] = await Promise.all([
        git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "尚无提交"),
        git(["diff", "--numstat", "HEAD", "--", "."]).catch(() => ""),
        git(["status", "--porcelain", "--untracked-files=normal", "--", "."]),
      ]);
      let additions = 0, deletions = 0;
      for (const row of diff.split("\n")) {
        const [added, removed] = row.split("\t");
        if (/^\d+$/.test(added || "")) additions += Number(added);
        if (/^\d+$/.test(removed || "")) deletions += Number(removed);
      }
      const rows = status.split("\n").filter(Boolean);
      snapshot = { branch, additions, deletions, changedFiles: rows.filter(row => !row.startsWith("??")).length, untrackedFiles: rows.filter(row => row.startsWith("??")).length };
    } catch { /* A normal workspace may not be a Git repository. */ }
    return apiJson({ data: { workspace, projectName: path.basename(workspace.replace(/[\\/]+$/, "")) || agent.name, git: snapshot } }, 200, id);
  } catch (error) { return apiError(error, id); }
}
