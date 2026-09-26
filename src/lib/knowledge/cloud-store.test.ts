// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const cloud = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>() }));
vi.mock("server-only", () => ({}));
vi.mock("@vercel/blob", () => ({
  put: vi.fn(async (pathname: string, body: Uint8Array | string, options: { access: string }) => {
    if (options.access !== "private") throw new Error("Private access required");
    cloud.objects.set(pathname, typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body));
    return { pathname };
  }),
  get: vi.fn(async (pathname: string, options: { access: string }) => {
    if (options.access !== "private") throw new Error("Private access required");
    const bytes = cloud.objects.get(pathname);
    return bytes ? { statusCode: 200, stream: new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).body, blob: { size: bytes.byteLength } } : null;
  }),
  list: vi.fn(async ({ prefix }: { prefix: string }) => ({ blobs: [...cloud.objects.keys()].filter((pathname) => pathname.startsWith(prefix)).map((pathname) => ({ pathname })), hasMore: false })),
  del: vi.fn(async (pathname: string) => { cloud.objects.delete(pathname); }),
}));

const { setKnowledgeOwner } = await import("@/lib/server/knowledge-scope");
const { deleteKnowledgeRecord, getKnowledgeDownload, getKnowledgeRecord, listKnowledgeRecords, saveUploadedKnowledge } = await import("./store");

afterEach(() => { cloud.objects.clear(); vi.unstubAllEnvs(); });

describe("private cloud knowledge archive", () => {
  it("stores original bytes and metadata privately within one account scope", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "unit-test-token");
    setKnowledgeOwner("auth0|alice");
    const bytes = Buffer.from("私有知识", "utf8");
    const saved = await saveUploadedKnowledge({ originalName: "notes.txt", mimeType: "text/plain", bytes, parse: { status: "parsed", text: "私有知识" } });
    expect(await getKnowledgeRecord(saved.record.id)).toMatchObject({ originalName: "notes.txt" });
    expect((await listKnowledgeRecords())).toHaveLength(1);
    const download = await getKnowledgeDownload(saved.record.id);
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    setKnowledgeOwner("auth0|bob");
    expect(await getKnowledgeRecord(saved.record.id)).toBeNull();
    expect(await listKnowledgeRecords()).toHaveLength(0);
  });

  it("deletes the private original and metadata together", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "unit-test-token");
    setKnowledgeOwner("auth0|delete-test");
    const saved = await saveUploadedKnowledge({ originalName: "remove.txt", mimeType: "text/plain", bytes: Buffer.from("删除"), parse: { status: "parsed", text: "删除" } });
    await deleteKnowledgeRecord(saved.record.id);
    await expect(getKnowledgeRecord(saved.record.id)).resolves.toBeNull();
    await expect(listKnowledgeRecords()).resolves.toHaveLength(0);
  });
});
