import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getWorkAuth } from "@/lib/server/work-auth";

export async function proxy(request: NextRequest) {
  const auth = getWorkAuth();
  return auth ? auth.middleware(request) : NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"],
};
