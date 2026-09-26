import { randomBytes } from "node:crypto";
import { ApiHttpError, apiError, requestId } from "@/lib/server/api-security";
import { getCalendarViewer } from "@/lib/server/calendar-auth";
import { issueCalendarBrowserToken, localCalendarOrigin } from "@/lib/server/calendar-shared-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    if (process.env.VERCEL !== "1") throw new ApiHttpError(503, "CALENDAR_CONNECT_UNAVAILABLE", "请连接已部署的云端日历服务。");
    const url = new URL(request.url);
    const origin = localCalendarOrigin(url.searchParams.get("origin"));
    if (!origin) throw new ApiHttpError(403, "CALENDAR_ORIGIN_DENIED", "只允许连接本机打开的 LumaFlow 页面。");
    let viewer;
    try { viewer = await getCalendarViewer(); }
    catch (error) {
      if (!(error instanceof ApiHttpError) || error.status !== 401) throw error;
      const login = new URL("/auth/login", url);
      login.searchParams.set("returnTo", `${url.pathname}${url.search}`);
      return Response.redirect(login, 302);
    }
    const { token, expiresAt } = issueCalendarBrowserToken(viewer, origin);
    const nonce = randomBytes(18).toString("base64");
    const message = JSON.stringify({ type: "lumaflow-calendar-connected", token, expiresAt, viewer }).replace(/[<>&]/g, (character) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" })[character]!);
    const target = JSON.stringify(origin);
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>连接协作日历</title><body><p id="status">正在连接协作日历…</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${message},${target});document.getElementById("status").textContent="连接成功，可以关闭此窗口。";setTimeout(()=>window.close(),600)}else{document.getElementById("status").textContent="请从本地 LumaFlow 日历点击「连接云端日历」后再试。"}</script></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return apiError(error, id); }
}
