import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarCloudOrigin, connectSharedCalendar, currentCalendarConnection, disconnectSharedCalendar, usesSharedCalendarConnection } from "./calendar-connection";

afterEach(() => { disconnectSharedCalendar(); vi.restoreAllMocks(); });

describe("shared calendar connection from a local installation", () => {
  it("keeps a signed connection for the current browser tab and rejects messages from another site", async () => {
    expect(usesSharedCalendarConnection()).toBe(true);
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    const connected = connectSharedCalendar();
    expect(open).toHaveBeenCalledWith(expect.stringContaining(`/api/v1/calendar/connect?origin=${encodeURIComponent(window.location.origin)}`), "lumaflow-calendar-connect", expect.any(String));
    const data = { type: "lumaflow-calendar-connected", token: "signed-token", expiresAt: Date.now() + 60_000, viewer: { id: "alice", email: "alice@example.com", name: "Alice" } };
    window.dispatchEvent(new MessageEvent("message", { data, origin: "https://wrong.example", source: popup }));
    expect(currentCalendarConnection()).toBeNull();
    window.dispatchEvent(new MessageEvent("message", { data, origin: calendarCloudOrigin, source: popup }));
    expect(await connected).toEqual(data && { token: data.token, expiresAt: data.expiresAt, viewer: data.viewer });
    expect(currentCalendarConnection()?.viewer.email).toBe("alice@example.com");
  });
});
