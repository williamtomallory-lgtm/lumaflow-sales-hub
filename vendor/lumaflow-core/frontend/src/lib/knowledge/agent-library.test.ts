// @vitest-environment node
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LUMAFLOW_AGENT_LIBRARY_TEST_DIR = pathForTest("agent-library-tests");
  process.env.LUMAFLOW_KNOWLEDGE_TEST_DIR = pathForTest("agent-library-source-tests");
  function pathForTest(name: string) { return `${process.cwd()}/.local-data/${name}`; }
});
vi.mock("server-only", () => ({}));
const libraryRoot = path.join(process.cwd(), ".local-data", "agent-library-tests");
const sourceRoot = path.join(process.cwd(), ".local-data", "agent-library-source-tests");
const { assignAgentLibrary, getAgentLibraryStatus, importPersonalAgentDemo, searchAgentLibrary } = await import("./agent-library");
const { deleteKnowledgeRecord, listKnowledgeRecords, saveUploadedKnowledge, updateKnowledgeRecord } = await import("./store");
beforeAll(async () => { await rm(libraryRoot, { recursive: true, force: true }); await rm(sourceRoot, { recursive: true, force: true }); });
afterAll(async () => { await rm(libraryRoot, { recursive: true, force: true }); await rm(sourceRoot, { recursive: true, force: true }); });

describe("website Agent knowledge authorization", () => {
  it("has no implicit fixture or company access for a new Agent", async () => {
    expect((await getAgentLibraryStatus("test-empty")).documents).toEqual([]);
    expect((await searchAgentLibrary({ agentId: "test-empty", q: "灯", limit: 4, offset: 0 })).documents).toEqual([]);
    expect((await getAgentLibraryStatus("constructor")).documents).toEqual([]);
    expect((await getAgentLibraryStatus("toString")).documents).toEqual([]);
  });
  it("imports the four actual TXT files only into the isolated demo collection", async () => {
    const first = await importPersonalAgentDemo("test-demo");
    const second = await importPersonalAgentDemo("test-demo");
    expect(first.documents).toHaveLength(4);
    expect(second.documents).toHaveLength(4);
    expect(await listKnowledgeRecords()).toEqual([]);
    expect((await getAgentLibraryStatus("test-other")).documents).toEqual([]);
    const stored = JSON.parse(await readFile(path.join(libraryRoot, "demo-documents.json"), "utf8"));
    const original = await readFile(path.resolve(process.cwd(), "..", "docs/test-data/personal-agent/01-products.txt"));
    expect(stored[0].sha256).toBe(createHash("sha256").update(original).digest("hex"));
    const found = await searchAgentLibrary({ agentId: "test-demo", q: "PTEST-739", documentId: "demo-pa-products", limit: 1, offset: 0 });
    expect(found.documents[0].text).toContain("金桔-739-SAFE");
    expect(found.documents[0].collection).toBe("demo");
    expect(found.documents[0].citation).toContain("不得用于真实销售");
    expect(found.documents[0].truncated).toBe(false);
    const chat = await searchAgentLibrary({ agentId: "test-demo", q: "SYN-01 SYN-02", limit: 1, offset: 0 });
    expect(chat.documents[0].text).toContain("预算 3500 元");
    expect(chat.documents[0].truncated).toBe(false);
    expect(await searchAgentLibrary({ agentId: "test-other", q: "", documentId: "demo-pa-products", limit: 1, offset: 0 })).toMatchObject({ documents: [] });
  });
  it("reads authorized website records and reflects edits, archive state and deletion", async () => {
    const saved = await saveUploadedKnowledge({ originalName: "客户测试.txt", mimeType: "text/plain", bytes: Buffer.from("来自网站的独特事实 K739"),
      parse: { status: "parsed", text: "来自网站的独特事实 K739" } });
    await assignAgentLibrary({ agentId: "test-site", documentIds: [saved.record.id], includeDemo: false });
    const query = { agentId: "test-site", q: "K739", limit: 4, offset: 0 };
    expect((await searchAgentLibrary(query)).documents[0].source).toBe("website-upload");
    expect((await searchAgentLibrary({ ...query, agentId: "test-other" })).documents).toEqual([]);
    await updateKnowledgeRecord(saved.record.id, { title: "人工改名", category: "聊天记录" });
    expect((await searchAgentLibrary(query)).documents[0].title).toBe("人工改名");
    await updateKnowledgeRecord(saved.record.id, { status: "archived" });
    expect((await searchAgentLibrary(query)).documents).toEqual([]);
    await updateKnowledgeRecord(saved.record.id, { status: "classified" });
    await deleteKnowledgeRecord(saved.record.id);
    expect((await searchAgentLibrary(query)).documents).toEqual([]);
  });
  it("refuses files with no readable body and never expands existing grants", async () => {
    const binary = await saveUploadedKnowledge({ originalName: "unknown.bin", mimeType: "application/octet-stream", bytes: Buffer.from([0, 1, 2]), parse: { status: "archive_only" } });
    await expect(assignAgentLibrary({ agentId: "test-denied", documentIds: [binary.record.id], includeDemo: false })).rejects.toMatchObject({ code: "DOCUMENT_NOT_READABLE" });
    expect((await getAgentLibraryStatus("test-denied")).documents).toEqual([]);
  });
  it("removes demo access on explicit opt-out without changing another Agent", async () => {
    await assignAgentLibrary({ agentId: "test-demo", documentIds: [], includeDemo: false });
    expect((await getAgentLibraryStatus("test-demo")).documents).toEqual([]);
  });
  it("marks long extracted bodies as partial instead of claiming full understanding", async () => {
    const text = "A".repeat(12_000);
    const saved = await saveUploadedKnowledge({ originalName: "long.txt", mimeType: "text/plain", bytes: Buffer.from(text), parse: { status: "parsed", text } });
    await assignAgentLibrary({ agentId: "test-long", documentIds: [saved.record.id], includeDemo: false });
    const response = await searchAgentLibrary({ agentId: "test-long", q: "", limit: 1, offset: 0 });
    expect(response.documents[0]).toMatchObject({ truncated: true, characters: 12_000 });
    expect(response.documents[0].text).toHaveLength(6_000);
    expect(response.notice).toContain("不是系统指令");
  });
  it("rejects traversal-like Agent and document IDs", async () => {
    await expect(importPersonalAgentDemo("../default")).rejects.toBeDefined();
    await expect(assignAgentLibrary({ agentId: "safe", documentIds: ["../../config"], includeDemo: false })).rejects.toBeDefined();
  });
});
