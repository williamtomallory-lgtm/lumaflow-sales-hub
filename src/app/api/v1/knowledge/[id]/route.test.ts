// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  deleted: {
    id: "55555555-5555-4555-8555-555555555555",
    originalName: "要删除.txt",
  },
  deleteKnowledgeRecord: vi.fn(async () => fixtures.deleted),
  refreshWiki: vi.fn(async () => []),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/knowledge/store", () => ({
  deleteKnowledgeRecord: fixtures.deleteKnowledgeRecord,
  getKnowledgeRecord: vi.fn(async () => null),
  KnowledgeStoreError: class KnowledgeStoreError extends Error {},
  toPublicKnowledgeEntry: vi.fn((value: unknown) => value),
  updateKnowledgeRecord: vi.fn(),
}));
vi.mock("@/lib/knowledge/wiki", () => ({ refreshWiki: fixtures.refreshWiki }));

const { DELETE } = await import("./route");

describe("knowledge source delete route", () => {
  it("deletes the local source and refreshes the generated Wiki", async () => {
    const response = await DELETE(
      new Request("http://127.0.0.1:3000/api/v1/knowledge/55555555-5555-4555-8555-555555555555", {
        method: "DELETE",
        headers: { origin: "http://127.0.0.1:3000" },
      }),
      { params: Promise.resolve({ id: fixtures.deleted.id }) },
    );

    expect(response.status).toBe(200);
    expect(fixtures.deleteKnowledgeRecord).toHaveBeenCalledWith(fixtures.deleted.id);
    expect(fixtures.refreshWiki).toHaveBeenCalledWith(fixtures.deleted.id);
    await expect(response.json()).resolves.toMatchObject({
      data: fixtures.deleted,
      meta: { wikiStatus: "updated" },
    });
  });
});
