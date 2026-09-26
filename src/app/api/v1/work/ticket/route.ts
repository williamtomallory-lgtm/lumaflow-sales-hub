import { getWorkAuth } from "@/lib/server/work-auth";
import { createWorkTicket } from "@/lib/server/work-ticket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = getWorkAuth();
  if (!auth) return Response.json({ error: "Work 登录尚未配置" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "请求来源无效" }, { status: 403 });
  const session = await auth.getSession();
  if (!session?.user.sub) return Response.json({ error: "请先登录" }, { status: 401 });
  return Response.json(createWorkTicket(session.user.sub), { headers: { "Cache-Control": "no-store" } });
}
