import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type TicketClaims = { aud: "lumaflow-local-work"; sub: string; iat: number; exp: number; nonce: string };

function signingKey(): string {
  const key = process.env.WORK_PAIRING_SIGNING_KEY;
  if (!key || Buffer.byteLength(key) < 32) throw new Error("Work pairing signing key is not configured");
  return key;
}

function signature(payload: string): Buffer {
  return createHmac("sha256", signingKey()).update(payload).digest();
}

export function createWorkTicket(subject: string): { ticket: string; expiresAt: string } {
  if (!subject || subject.length > 512) throw new Error("Invalid account identity");
  const now = Math.floor(Date.now() / 1000);
  const claims: TicketClaims = { aud: "lumaflow-local-work", sub: subject, iat: now, exp: now + 300, nonce: randomBytes(16).toString("base64url") };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { ticket: `${body}.${signature(body).toString("base64url")}`, expiresAt: new Date(claims.exp * 1000).toISOString() };
}

export function verifyWorkTicket(ticket: string): TicketClaims | null {
  if (!ticket || ticket.length > 2048) return null;
  const [body, supplied, extra] = ticket.split(".");
  if (!body || !supplied || extra) return null;
  let received: Buffer;
  try { received = Buffer.from(supplied, "base64url"); } catch { return null; }
  const expected = signature(body);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object") return null;
    const record = claims as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (record.aud !== "lumaflow-local-work" || typeof record.sub !== "string" || !record.sub || typeof record.nonce !== "string" || typeof record.iat !== "number" || typeof record.exp !== "number") return null;
    if (record.iat > now + 30 || record.exp < now || record.exp > record.iat + 300) return null;
    return record as TicketClaims;
  } catch { return null; }
}
