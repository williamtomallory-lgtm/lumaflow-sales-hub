// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("server-only", () => ({}));
vi.mock("./model-config", () => ({ assertModelConfigured: () => ({ baseURL: "http://127.0.0.1:8080/v1", model: "local", apiKey: "local" }) }));
import { assessWorkOutcome, inspectWorkEvidence } from "./work-outcome";
import type { WorkRun } from "../contracts/work-run";
const hash = "a".repeat(64);
function run(): WorkRun { return { id: randomUUID(), chatId: randomUUID(), agentId: "work", projectId: null, model: "local", goal: "保存文件并核验", state: "running", steps: [], receipts: [], updatedAt: new Date().toISOString() }; }
function fileReceipt(kind: "file-read" | "file-write", fileSha256?: string): WorkRun["receipts"][number] { return { id: randomUUID(), tool: "localComputer", action: kind === "file-read" ? "read_file" : "write_file", state: "succeeded", summary: "Actual receipt", facts: [{ kind, path: "D:/Work/report.txt", ...(fileSha256 ? { fileSha256 } : {}) }] }; }
afterEach(() => vi.unstubAllGlobals());
describe("Work requirement acceptance", () => {
  it("blocks an unchecked write before any semantic model judgment", async () => {
    const data = run(); data.receipts = [fileReceipt("file-write", hash)]; vi.stubGlobal("fetch", vi.fn());
    expect((await assessWorkOutcome(data, "已完成", "local:strata-coder", new AbortController().signal)).verdict).toBe("partial");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("detects file changes between write and read even when every tool succeeded", () => {
    const data = run(); data.receipts = [fileReceipt("file-write", hash), fileReceipt("file-read", "b".repeat(64))];
    expect(inspectWorkEvidence(data).find((check) => check.title.startsWith("文件写入后读回"))?.state).toBe("failed");
  });
  it("does not substitute a receipt for a different file or an earlier read", () => {
    const data = run(); const read = fileReceipt("file-read", hash); read.facts![0].path = "D:/Work/other.txt";
    data.receipts = [fileReceipt("file-read", hash), fileReceipt("file-write", hash), read];
    expect(inspectWorkEvidence(data).find((check) => check.title.startsWith("文件写入后读回"))?.state).toBe("unknown");
  });
  it("rejects invented IDs in an otherwise positive local judgment", async () => {
    const data = run(); data.receipts = [fileReceipt("file-write", hash), fileReceipt("file-read", hash)];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ choice: "complete", evidence: ["E999"], missing: [] }) } }] })));
    const result = await assessWorkOutcome(data, "已完成", "local:strata-coder", new AbortController().signal);
    expect(result.verdict).toBe("uncertain");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://127.0.0.1:8080/v1/chat/completions");
  });
  it("accepts completion only after factual gates and actual successful evidence", async () => {
    const data = run(); data.receipts = [fileReceipt("file-write", hash), fileReceipt("file-read", hash)];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ choice: "complete", evidence: ["E1", "E2"], missing: [] }) } }] })));
    expect((await assessWorkOutcome(data, "已完成", "local:strata-coder", new AbortController().signal)).verdict).toBe("checked");
  });
  it("preserves recovery when a missing file is then created and read successfully", () => {
    const data = run();
    const read = fileReceipt("file-read", hash); read.target = "D:/Work/report.txt";
    data.receipts = [{ id: randomUUID(), tool: "readLocalFiles", action: "readLocalFiles", target: "D:\\Work\\report.txt", state: "failed", summary: "File not found" }, fileReceipt("file-write", hash), read];
    expect(inspectWorkEvidence(data).every((check) => check.state === "passed")).toBe(true);
  });
  it("rejects unrelated successful receipts as proof of the requested file", async () => {
    const data = run(); data.goal = "请创建 missing.csv 并读回核验"; data.receipts = [fileReceipt("file-read", hash)];
    vi.stubGlobal("fetch", vi.fn());
    expect((await assessWorkOutcome(data, "已完成", "local:strata-coder", new AbortController().signal)).verdict).toBe("partial");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not call a successful search a verified action", async () => {
    const data = run(); data.receipts = [{ id: randomUUID(), tool: "webSearch", action: "webSearch", state: "succeeded", summary: "unrelated search results" }];
    vi.stubGlobal("fetch", vi.fn());
    expect((await assessWorkOutcome(data, "已完成", "local:strata-coder", new AbortController().signal)).verdict).toBe("uncertain");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires the independent reviewer to read every saved file", () => {
    const data = run(); data.reviewerIds = ["reviewer"];
    data.receipts = [fileReceipt("file-write", hash), { ...fileReceipt("file-read", hash), agentId: "lead" }];
    expect(inspectWorkEvidence(data).find((check) => check.title.startsWith("独立核验读回"))?.state).toBe("unknown");
    data.receipts.push({ ...fileReceipt("file-read", hash), agentId: "reviewer" });
    expect(inspectWorkEvidence(data).every((check) => check.state === "passed")).toBe(true);
  });
});
