import { listKnowledgeRecords } from "@/lib/knowledge/store";
import { compileWiki, readWikiPage, saveWikiPages, searchWikiPages } from "@/lib/knowledge/wiki";
import { ApiHttpError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";
import { authorizeKnowledgeRead, knowledgeError } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 60);
    await authorizeKnowledgeRead(request);
    const pages = compileWiki(await listKnowledgeRecords());
    const params = new URL(request.url).searchParams;
    const query = (params.get("q") || "").trim().slice(0, 200);
    const selectedPath = params.get("page") || "index.md";
    const selected = pages.find((page) => page.path === selectedPath);
    if (!selected) throw new ApiHttpError(404, "WIKI_PAGE_NOT_FOUND", "知识维基页面不存在。");
    if ((await readWikiPage(selected.path)) !== selected.markdown) await saveWikiPages([selected]);
    return apiJson({
      data: {
        pages: pages.map(({ path, title, kind }) => ({ path, title, kind })),
        selected,
        query,
        matches: searchWikiPages(pages, query),
      },
      meta: { apiVersion: "v1" as const, requestId: id },
    }, 200, id);
  } catch (error) {
    return knowledgeError(error, id);
  }
}
