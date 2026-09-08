// @vitest-environment node

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testDirectory = path.join(process.cwd(), ".local-data", "knowledge-unit-tests");
vi.hoisted(() => {
  process.env.LUMAFLOW_KNOWLEDGE_TEST_DIR = `${process.cwd()}\\.local-data\\knowledge-unit-tests`;
});
vi.mock("server-only", () => ({}));

const { getKnowledgeRecord, getKnowledgeTextById, markClassificationFailed, readFileWithLimit, saveModelClassification, saveUploadedKnowledge, toPublicKnowledgeEntry, updateKnowledgeRecord, KnowledgeStoreError } = await import("./store");

beforeAll(async () => rm(testDirectory, { recursive: true, force: true }));
afterAll(async () => rm(testDirectory, { recursive: true, force: true }));

describe("local knowledge archive", () => {
  it("rejects a stream over the per-file limit, regardless of declared File size", async () => {
    const file = new File([new Uint8Array(11)], "too-large.bin", { type: "application/octet-stream" });
    await expect(readFileWithLimit(file, 10)).rejects.toMatchObject({ code: "FILE_TOO_LARGE", status: 413 });
  });

  it("stores an unreadable binary as an archive-only record and keeps the original bytes", async () => {
    const bytes = Buffer.from([0, 15, 100, 202, 1]);
    const saved = await saveUploadedKnowledge({ originalName: "../客户聊天.bin", mimeType: "application/octet-stream", bytes, parse: { status: "archive_only", error: "未接入二进制解析" } });
    expect(saved.record.originalName).not.toContain("/");
    expect(saved.record.classificationStatus).toBe("archived");
    expect(saved.record.summary).toContain("仅归档未理解");
    await expect(getKnowledgeTextById(saved.record.id)).resolves.toBeNull();
    expect(toPublicKnowledgeEntry(saved.record)).not.toHaveProperty("storageFileName");
    const download = await (await import("./store")).getKnowledgeDownload(saved.record.id);
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
  });

  it("deduplicates by the complete SHA-256 digest", async () => {
    const bytes = Buffer.from("same content");
    const first = await saveUploadedKnowledge({ originalName: "first.txt", mimeType: "text/plain", bytes, parse: { status: "parsed", text: "same content", characters: 12 } });
    const second = await saveUploadedKnowledge({ originalName: "renamed.txt", mimeType: "text/plain", bytes: Buffer.from(bytes), parse: { status: "parsed", text: "same content", characters: 12 } });
    expect(second.deduplicated).toBe(true);
    expect(second.record.id).toBe(first.record.id);
  });

  it("persists a failed classification as retryable and does not overwrite manual confirmation", async () => {
    const saved = await saveUploadedKnowledge({ originalName: `notes-${randomUUID()}.txt`, mimeType: "text/plain", bytes: Buffer.from("客户偏好黑色灯具"), parse: { status: "parsed", text: "客户偏好黑色灯具", characters: 9 } });
    const pending = await markClassificationFailed(saved.record.id);
    expect(pending.classificationStatus).toBe("pending");
    expect(pending.classificationError).toContain("模型分类失败");
    const confirmed = await updateKnowledgeRecord(saved.record.id, { category: "FAQ", status: "classified" });
    expect(confirmed.classificationSource).toBe("manual");
    const modelResult = await saveModelClassification(saved.record.id, { category: "案例", title: "模型不应覆盖", summary: "模型完成", tags: ["模型"], confidence: 0.9 });
    expect(modelResult.classificationSource).toBe("manual");
    expect(modelResult.title).toBe(confirmed.title);
    const loaded = await getKnowledgeRecord(saved.record.id);
    expect(loaded?.classificationSource).toBe("manual");
  });

  it("does not accept a path-like identifier", async () => {
    await expect(getKnowledgeRecord("../../secret")).rejects.toBeInstanceOf(KnowledgeStoreError);
  });
});
