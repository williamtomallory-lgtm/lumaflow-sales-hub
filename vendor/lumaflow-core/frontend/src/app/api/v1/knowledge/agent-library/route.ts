import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { cowAgentIdSchema } from "@/lib/contracts/cowagent-agent";
import { assignAgentLibrary, getAgentLibraryStatus, importPersonalAgentDemo, searchAgentLibrary } from "@/lib/knowledge/agent-library";
import { ApiHttpError, apiJson, authorizeAssistantRequest, authorizeLocalKnowledgeRead, enforceRateLimit, readValidatedJson, requestId } from "@/lib/server/api-security";
import { getCowAgentProfile } from "@/lib/server/cowagent-client";
import { knowledgeError } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const querySchema = z.object({ agentId: cowAgentIdSchema, q: z.string().max(500).default(""), documentId: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(6).default(4), offset: z.coerce.number().int().min(0).max(500).default(0) });
const updateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("import-demo"), agentId: cowAgentIdSchema }).strict(),
  z.object({ action: z.literal("assign"), agentId: cowAgentIdSchema, documentIds: z.array(z.string().uuid()).max(500), includeDemo: z.boolean() }).strict(),
]);

function bridgeAuthorized(request: Request) {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = process.env.LUMAFLOW_KNOWLEDGE_TOKEN;
  if (!supplied) return false;
  if (!expected || expected.length < 32 || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw new ApiHttpError(403, "BRIDGE_TOKEN_INVALID", "知识桥接凭据无效。");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(request.url).hostname)) throw new ApiHttpError(403, "LOCAL_ONLY", "知识桥接仅供本机使用。");
  return true;
}

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 180);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const internal = bridgeAuthorized(request);
    if (!internal) authorizeLocalKnowledgeRead(request);
    const data = internal ? await searchAgentLibrary(query) : await getAgentLibraryStatus(query.agentId);
    return apiJson({ data, meta: { apiVersion: "v1", source: "website-agent-library", requestId: id, bodyIncluded: internal,
      bridgeConfigured: Boolean(process.env.LUMAFLOW_KNOWLEDGE_TOKEN && process.env.LUMAFLOW_KNOWLEDGE_TOKEN.length >= 32) } }, 200, id);
  } catch (error) { return knowledgeError(error, id); }
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    authorizeLocalKnowledgeRead(request);
    authorizeAssistantRequest(request);
    enforceRateLimit(request, 30);
    const input = await readValidatedJson(request, updateSchema);
    const profile = await getCowAgentProfile(input.agentId);
    if (!profile.enabled) throw new ApiHttpError(409, "AGENT_DISABLED", "请先启用该 Agent。");
    const data = input.action === "import-demo" ? await importPersonalAgentDemo(input.agentId) : await assignAgentLibrary(input);
    return apiJson({ data, meta: { apiVersion: "v1", requestId: id, source: "website-agent-library" } }, 200, id);
  } catch (error) { return knowledgeError(error, id); }
}
