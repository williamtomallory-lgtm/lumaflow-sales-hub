// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => {
  const objects = new Map<string, string>();
  const put = vi.fn(async (pathname: string, body: string | Uint8Array) => {
    objects.set(pathname, typeof body === "string" ? body : new TextDecoder().decode(body));
    return { pathname };
  });
  const get = vi.fn(async (pathname: string) => {
    const body = objects.get(pathname);
    return body === undefined ? null : { statusCode: 200, stream: new Response(body).body };
  });
  const record = {
    id: "44444444-4444-4444-8444-444444444444",
    originalName: "refresh.txt",
    title: "refresh",
    summary: "refresh summary",
    category: "产品知识",
    tags: ["文本"],
    classificationStatus: "pending",
    classificationSource: "none",
    parseStatus: "parsed",
    extractedText: "refresh text",
    uploadedAt: "2026-09-23T15:00:00.000Z",
    updatedAt: "2026-09-23T15:00:00.000Z",
    sha256Prefix: "d".repeat(12),
    sha256: "d".repeat(64),
    downloadUrl: "/api/v1/knowledge/44444444-4444-4444-8444-444444444444/download",
  };
  return { objects, put, get, record };
});

vi.mock("server-only", () => ({}));
vi.mock("@vercel/blob", () => ({ put: fixtures.put, get: fixtures.get }));
vi.mock("@/lib/knowledge/store", () => ({ listKnowledgeRecords: vi.fn(async () => [fixtures.record]) }));

const { setKnowledgeOwner } = await import("@/lib/server/knowledge-scope");
const { refreshWiki } = await import("./wiki");

afterEach(() => {
  fixtures.objects.clear();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("refreshWiki persistence", () => {
  it("does not rewrite unchanged pages on a subsequent refresh", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "unit-test-token");
    setKnowledgeOwner("auth0|wiki-refresh-test");

    await refreshWiki(fixtures.record.id);
    const firstWriteCount = fixtures.put.mock.calls.length;
    expect(firstWriteCount).toBeGreaterThan(0);

    await refreshWiki(fixtures.record.id);
    expect(fixtures.put).toHaveBeenCalledTimes(firstWriteCount);
  });
});
