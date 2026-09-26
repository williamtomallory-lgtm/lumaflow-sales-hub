import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkTicket, verifyWorkTicket } from "./work-ticket";

beforeEach(() => {
  vi.stubEnv("WORK_PAIRING_SIGNING_KEY", "test-key-for-work-ticket-signing-32-bytes-long");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Work pairing ticket", () => {
  it("binds a short-lived signed ticket to one account", () => {
    const { ticket } = createWorkTicket("auth0|visitor-1");
    expect(verifyWorkTicket(ticket)?.sub).toBe("auth0|visitor-1");
    expect(verifyWorkTicket(`${ticket}x`)).toBeNull();
    vi.advanceTimersByTime(301_000);
    expect(verifyWorkTicket(ticket)).toBeNull();
  });
});
