import { authorizeWorkEngineGateway } from "@/lib/server/work-engine";
import { getModelOptions, getModelConfig } from "@/lib/ai/model-config";
import { gatewayError } from "@/lib/ai/work-engine-gateway";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await authorizeWorkEngineGateway(request);
    const models = (await getModelOptions()).filter((entry) => {
      try { return entry.configured && entry.connectionKind === "live" && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(getModelConfig(entry.id).baseURL || "").hostname); } catch { return false; }
    });
    return Response.json({ object: "list", data: models.map(({ id, label }) => ({ id, object: "model", owned_by: "lumaflow-local", name: label })) }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return gatewayError(error); }
}
