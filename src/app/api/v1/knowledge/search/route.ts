import { z } from "zod";
import { apiError, apiJson, authorizeAssistantRequest, authorizeLocalKnowledgeRead, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { searchWeb } from "@/lib/server/web-search";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const id = requestId(request);
  try {
    authorizeLocalKnowledgeRead(request);
    authorizeAssistantRequest(request);
    enforceRateLimit(request, 12);
    const { query } = await readValidatedJson(request, z.object({ query: z.string().trim().min(1).max(1000) }).strict());
    return apiJson({ results: await searchWeb(query, request.signal) }, 200, id);
  } catch (error) { return apiError(error, id); }
}
