import { Readable } from "node:stream";
import { getKnowledgeDownload } from "@/lib/knowledge/store";
import { enforceRateLimit, requestId } from "@/lib/server/api-security";
import { authorizeKnowledgeRead, knowledgeError } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DownloadRouteContext = { params: Promise<{ id: string }> };

function downloadName(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").slice(0, 180) || "knowledge-file";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(request: Request, context: DownloadRouteContext) {
  const requestIdentifier = requestId(request);
  try {
    enforceRateLimit(request, 60);
    authorizeKnowledgeRead(request);
    const { id } = await context.params;
    const download = await getKnowledgeDownload(id);
    return new Response(Readable.toWeb(download.stream) as unknown as ReadableStream, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Length": String(download.sizeBytes),
        "Content-Type": download.mimeType,
        "Content-Disposition": downloadName(download.originalName),
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestIdentifier,
      },
    });
  } catch (error) {
    return knowledgeError(error, requestIdentifier);
  }
}
