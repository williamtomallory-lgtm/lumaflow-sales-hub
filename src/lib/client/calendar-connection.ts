export type CalendarIdentity = { id: string; email: string; name: string };
export type CalendarConnection = { token: string; expiresAt: number; viewer: CalendarIdentity };

const storageKey = "lumaflow-calendar-connection-v1";
export const calendarCloudOrigin = (process.env.NEXT_PUBLIC_CALENDAR_URL || "https://lumaflow-sales-hub.vercel.app").replace(/\/$/, "");

export function usesSharedCalendarConnection() {
  return typeof window !== "undefined" && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

export function currentCalendarConnection(): CalendarConnection | null {
  if (!usesSharedCalendarConnection()) return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("token" in value) || !("expiresAt" in value) || !("viewer" in value)) return null;
    const connection = value as CalendarConnection;
    if (typeof connection.token !== "string" || typeof connection.expiresAt !== "number" || connection.expiresAt <= Date.now() || typeof connection.viewer?.email !== "string" || typeof connection.viewer?.name !== "string") {
      window.sessionStorage.removeItem(storageKey);
      return null;
    }
    return connection;
  } catch { return null; }
}

export function disconnectSharedCalendar() {
  if (typeof window !== "undefined") window.sessionStorage.removeItem(storageKey);
}

export function connectSharedCalendar(): Promise<CalendarConnection> {
  if (!usesSharedCalendarConnection()) return Promise.reject(new Error("当前页面已直接使用云端日历。"));
  return new Promise((resolve, reject) => {
    const destination = new URL("/api/v1/calendar/connect", calendarCloudOrigin);
    destination.searchParams.set("origin", window.location.origin);
    const popup = window.open(destination.toString(), "lumaflow-calendar-connect", "popup,width=520,height=680");
    if (!popup) { reject(new Error("浏览器拦截了登录窗口，请允许弹出窗口后重试。")); return; }
    let finished = false;
    const cleanup = () => { window.removeEventListener("message", onMessage); window.clearInterval(closedCheck); window.clearTimeout(timeout); };
    const fail = (message: string) => { if (finished) return; finished = true; cleanup(); reject(new Error(message)); };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== popup || event.origin !== calendarCloudOrigin || event.data?.type !== "lumaflow-calendar-connected") return;
      const connection = { token: event.data.token, expiresAt: event.data.expiresAt, viewer: event.data.viewer } as CalendarConnection;
      if (typeof connection.token !== "string" || typeof connection.expiresAt !== "number" || connection.expiresAt <= Date.now() || typeof connection.viewer?.email !== "string" || typeof connection.viewer?.name !== "string") {
        fail("日历连接返回的数据无效，请重试。"); return;
      }
      try { window.sessionStorage.setItem(storageKey, JSON.stringify(connection)); }
      catch { fail("浏览器无法保存临时日历连接，请检查隐私设置。"); return; }
      finished = true;
      cleanup();
      popup.close();
      resolve(connection);
    };
    window.addEventListener("message", onMessage);
    const closedCheck = window.setInterval(() => { if (popup.closed) fail("连接窗口已关闭，请重试。"); }, 500);
    const timeout = window.setTimeout(() => { popup.close(); fail("连接等待超时，请重试。"); }, 5 * 60_000);
  });
}
