// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { issueCalendarBrowserToken, verifyCalendarBrowserToken, localCalendarOrigin, getCalendarRequestViewer, calendarOptions } = await import("./calendar-shared-auth");
const viewer = { id: "alice", email: "alice@example.com", name: "Alice" };

afterEach(() => vi.unstubAllEnvs());

describe("local browser calendar connection", () => {
  it("accepts only loopback origins and binds signed tokens to the originating app", () => {
    vi.stubEnv("WORK_PAIRING_SIGNING_KEY", "test-signing-key-with-more-than-thirty-two-bytes");
    expect(localCalendarOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(localCalendarOrigin("http://192.168.1.5:3000")).toBeNull();
    expect(localCalendarOrigin("http://127.0.0.1:9999")).toBeNull();
    expect(localCalendarOrigin("https://evil.example")).toBeNull();
    const { token } = issueCalendarBrowserToken(viewer, "http://127.0.0.1:3000");
    expect(verifyCalendarBrowserToken(token, "http://127.0.0.1:3000")).toEqual(viewer);
    expect(() => verifyCalendarBrowserToken(token, "http://localhost:3000")).toThrow();
    expect(() => verifyCalendarBrowserToken(`${token}x`, "http://127.0.0.1:3000")).toThrow();
  });

  it("allows an authenticated local browser to call the shared cloud API", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("WORK_PAIRING_SIGNING_KEY", "test-signing-key-with-more-than-thirty-two-bytes");
    const origin = "http://127.0.0.1:3000";
    const { token } = issueCalendarBrowserToken(viewer, origin);
    const request = new Request("https://lumaflow-sales-hub.vercel.app/api/v1/calendar/events", { method: "POST", headers: { Origin: origin, Authorization: `Bearer ${token}` } });
    expect(await getCalendarRequestViewer(request, true)).toEqual(viewer);
    const preflight = calendarOptions(new Request(request.url, { method: "OPTIONS", headers: { Origin: origin } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    await expect(getCalendarRequestViewer(new Request(request.url, { headers: { Origin: origin } }))).rejects.toMatchObject({ status: 401 });
  });
});
