import { loadSalesProfile } from "@/lib/ai/skill-profile";
import { apiError, apiJson, enforceRateLimit, requestId } from "@/lib/server/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    enforceRateLimit(request, 60);
    const profile = await loadSalesProfile();
    return apiJson({
      data: {
        id: profile.id,
        version: profile.version,
        name: profile.name,
        skills: profile.skills.map(({ id, name, version, description, tools }) => ({ id, name, version, description, tools })),
        memoryPersistence: "not-implemented",
      },
      meta: { apiVersion: "v1", requestId: id },
    }, 200, id);
  } catch (error) {
    return apiError(error, id);
  }
}
