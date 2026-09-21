import { apiError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";
import { getDatabaseHealth, getDataSnapshot } from "@/lib/server/data-repository";
import { getTianzhaoKnowledgeMetadata } from "@/lib/ai/tianzhao-knowledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 60);
    const [database, snapshot] = await Promise.all([getDatabaseHealth(), getDataSnapshot()]);
    const tianzhao = getTianzhaoKnowledgeMetadata();
    return apiJson({
      data: {
        status: database.configured && !database.reachable ? "degraded" : "ok",
        source: snapshot.source,
        database,
        knowledgeBases: {
          tianzhao: {
            snapshotDate: tianzhao.snapshotDate,
            productCount: tianzhao.productCount,
            imageCount: tianzhao.imageCount,
            ocrSidecarCount: tianzhao.ocrSidecarCount,
            sourceAudit: tianzhao.sourceAudit,
            exportAudit: tianzhao.exportAudit,
            releaseUrl: tianzhao.releaseUrl,
          },
        },
      },
      meta: { apiVersion: "v1", requestId: id, checkedAt: new Date().toISOString() },
    }, 200, id);
  } catch (error) {
    return apiError(error, id);
  }
}
