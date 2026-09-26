import { getWorkAuth } from "@/lib/server/work-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = getWorkAuth();
  if (!auth) return Response.json({ configured: false, authenticated: false }, { headers: { "Cache-Control": "no-store" } });
  const session = await auth.getSession();
  return Response.json({ configured: true, authenticated: Boolean(session), name: session?.user.name || session?.user.email || "" }, { headers: { "Cache-Control": "no-store" } });
}
