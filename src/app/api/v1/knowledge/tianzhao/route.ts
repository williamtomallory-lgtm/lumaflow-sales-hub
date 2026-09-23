import { listTianzhaoProducts } from "@/lib/ai/tianzhao-knowledge";
import { apiError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request);
    const params = new URL(request.url).searchParams;
    const query = params.get("q") ?? "";
    const category = params.get("category") ?? "";
    const rawOffset = Number(params.get("offset") ?? 0);
    const rawLimit = Number(params.get("limit") ?? 24);
    if (!Number.isInteger(rawOffset) || rawOffset < 0 || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100 || query.length > 160 || category.length > 100) {
      return apiJson({ error: { code: "INVALID_QUERY", message: "无效的知识库筛选参数" } }, 400, id);
    }
    const catalog = listTianzhaoProducts({ query, category, offset: rawOffset, limit: rawLimit });
    return apiJson({ data: catalog.products, meta: { apiVersion: "v1", requestId: id, total: catalog.total, offset: catalog.offset, limit: catalog.limit, knowledgeBase: catalog.metadata } }, 200, id);
  } catch (error) {
    return apiError(error, id);
  }
}
