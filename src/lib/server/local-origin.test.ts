// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { authorizeAssistantRequest, authorizeLocalKnowledgeRead, authorizeWrite } from "./api-security";
afterEach(() => vi.unstubAllEnvs());

describe("production loopback origin normalization", () => {
  const url = "http://localhost:3010/api/v1/assistant/chat";
  it("accepts a browser same-origin request on 127.0.0.1 without weakening origin checks", () => {
    const request = new Request(url, { headers: { host: "127.0.0.1:3010", origin: "http://127.0.0.1:3010", "sec-fetch-site": "same-origin" } });
    expect(() => authorizeAssistantRequest(request)).not.toThrow();
    expect(() => authorizeLocalKnowledgeRead(request)).not.toThrow();
    vi.stubEnv("DEMO_WRITES_ENABLED", "true");
    expect(() => authorizeWrite(request)).not.toThrow();
  });
  it("rejects different origins, DNS rebinding names, ports, and spoofed proxy headers", () => {
    const rejectedHeaders: Record<string, string>[] = [
      { host: "127.0.0.1:3010", origin: "http://localhost:3010" },
      { host: "127.0.0.1:3010", origin: "https://evil.invalid" },
      { host: "rebind.invalid:3010", origin: "http://rebind.invalid:3010" },
      { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
      { host: "evil@localhost:3010", origin: "http://localhost:3010" },
      { host: "127.0.0.1:3010", origin: "https://evil.invalid", "x-forwarded-host": "evil.invalid" },
    ];
    for (const headers of rejectedHeaders) {
      const request = new Request(url, { headers });
      expect(() => authorizeAssistantRequest(request)).toThrow();
      expect(() => authorizeLocalKnowledgeRead(request)).toThrow();
    }
  });
  it("does not allow a cross-site read just because its normalized host is loopback", () => {
    expect(() => authorizeLocalKnowledgeRead(new Request(url, { headers: { host: "evil.invalid:3010", "sec-fetch-site": "same-origin" } }))).toThrow();
    expect(() => authorizeLocalKnowledgeRead(new Request(url, { headers: { host: "127.0.0.1:3010", "sec-fetch-site": "cross-site" } }))).toThrow();
  });
});
