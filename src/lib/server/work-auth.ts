import { Auth0Client } from "@auth0/nextjs-auth0/server";

let client: Auth0Client | undefined;

export function workAuthConfigured(): boolean {
  return Boolean(
    process.env.AUTH0_DOMAIN &&
    process.env.AUTH0_CLIENT_ID &&
    process.env.AUTH0_CLIENT_SECRET &&
    process.env.AUTH0_SECRET &&
    process.env.WORK_PAIRING_SIGNING_KEY &&
    Buffer.byteLength(process.env.WORK_PAIRING_SIGNING_KEY) >= 32,
  );
}

export function getWorkAuth(): Auth0Client | null {
  if (!workAuthConfigured()) return null;
  client ??= new Auth0Client({ appBaseUrl: process.env.APP_BASE_URL || "https://lumaflow-sales-hub.vercel.app" });
  return client;
}
