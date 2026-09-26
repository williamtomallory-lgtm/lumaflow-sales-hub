import { verifyWorkTicket } from "@/lib/server/work-ticket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!process.env.WORK_PAIRING_SIGNING_KEY || Buffer.byteLength(process.env.WORK_PAIRING_SIGNING_KEY) < 32) {
    return Response.json({ valid: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const bearer = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!bearer) return Response.json({ valid: false }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const claims = verifyWorkTicket(bearer);
  if (!claims) return Response.json({ valid: false }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return Response.json({ valid: true, userId: claims.sub, expiresAt: new Date(claims.exp * 1000).toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
