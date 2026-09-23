// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

afterEach(() => { vi.unstubAllEnvs(); });

describe("cloud knowledge archive boundary", () => {
  it("shows an empty archive instead of a server error when Vercel has no durable file store", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("REMOTE_KNOWLEDGE_ENABLED", "true");
    const { GET } = await import("./route");
    const response = await GET(new Request("https://example.com/api/v1/knowledge?limit=1", {
      headers: { origin: "https://example.com", "sec-fetch-site": "same-origin" },
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([]);
    expect(body.meta.archiveAvailable).toBe(false);
  });

  it("rejects uploads before accepting bytes without durable storage", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("REMOTE_KNOWLEDGE_ENABLED", "true");
    const { POST } = await import("./route");
    const response = await POST(new Request("https://example.com/api/v1/knowledge", {
      method: "POST",
      headers: { origin: "https://example.com" },
      body: new FormData(),
    }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("LOCAL_ARCHIVE_UNAVAILABLE");
  });
});
