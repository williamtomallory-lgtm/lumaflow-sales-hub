import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeHub } from "./knowledge-hub";
import { testKnowledge } from "../test/fixtures";
import type { KnowledgeEntry } from "../lib/knowledge/contracts";

vi.mock("@/hooks/use-model-catalog", () => ({ useModelCatalog: () => ({
  models: [{ id: "local-qwen3-8b", label: "本地 8B", configured: true, reachable: true }],
  modelProfileId: "local-qwen3-8b", selectedModel: { configured: true }, selectModel: vi.fn(), refresh: vi.fn(),
}) }));
vi.mock("@/hooks/use-model-health", () => ({ useModelHealth: () => ({ health: { reachable: true }, refresh: vi.fn() }) }));

const entry: KnowledgeEntry = {
  id: "11111111-1111-4111-8111-111111111111", originalName: "验收文本.txt", mimeType: "text/plain",
  extension: "txt", sizeBytes: 30, sizeLabel: "30 B", sha256Prefix: "a".repeat(12),
  uploadedAt: "2026-09-07T12:00:00.000Z", updatedAt: "2026-09-07T12:00:00.000Z",
  classificationStatus: "classified", classificationSource: "model", category: "产品知识",
  title: "模型分类结果", summary: "由模型整理的摘要", tags: ["灯具"], confidence: 0.8,
  classificationError: null, parseStatus: "parsed", parseError: null, characters: 10,
  classificationCharacters: 10, pages: null, truncated: false, hasText: true, source: "uploaded",
  version: "v1", owner: "本机用户", downloadUrl: "/api/v1/knowledge/11111111-1111-4111-8111-111111111111/download",
  textPreview: "模型确实读取的正文",
};
let records: KnowledgeEntry[];
let failUpload: boolean;
const mutations: RequestInit[] = [];
const requests: string[] = [];
const onToast = vi.fn();

beforeEach(() => {
  records = []; failUpload = false; mutations.length = 0; requests.length = 0; onToast.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (init?.method === "POST") {
      mutations.push(init);
      return failUpload ? Response.json({ error: { message: "上传失败，原件未保存" } }, { status: 413 }) : Response.json({ data: entry }, { status: 201 });
    }
    if (init?.method === "PATCH") {
      mutations.push(init);
      records = records.map((record) => ({ ...record, classificationSource: "manual" }));
      return Response.json({ data: records[0] });
    }
    const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") ?? 0);
    return Response.json({
      data: records.slice(offset, offset + 200),
      summary: { total: records.length, classified: records.length, pending: 0, archived: 0,
        byCategory: [{ category: "产品知识", count: records.length }], storageBytes: records.length * 30, storageLimitBytes: 2147483648, fileLimit: 500 },
      meta: { apiVersion: "v1", requestId: "test", source: "local-files", demoEntriesExcluded: true, limit: 200, offset },
    });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Knowledge hub", () => {
  it("renders relative-date seed knowledge separately from real upload counts", async () => {
    render(<KnowledgeHub initialEntries={testKnowledge.map((item) => ({ ...item, updatedAt: "今天" }))} onToast={onToast} />);
    await screen.findByText("还没有真实上传文件");
    expect(screen.getByText(`${testKnowledge.length} 条演示`)).toBeInTheDocument();
    const metrics = screen.getByRole("region", { name: "知识库真实统计" });
    expect(within(metrics).getAllByText("0")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: testKnowledge[0].title }));
    expect(screen.getByText(testKnowledge[0].content)).toBeInTheDocument();
  });

  it("lets the user confirm a model classification with the backend PATCH", async () => {
    records = [entry];
    render(<KnowledgeHub initialEntries={[]} onToast={onToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "确认并纳入检索" }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringContaining("已人工确认")));
    expect(JSON.parse(String(mutations[0].body))).toEqual({ category: "产品知识", status: "classified" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "确认并纳入检索" })).not.toBeInTheDocument());
  });

  it("submits any extension as multipart data and does not fake success on failure", async () => {
    failUpload = true;
    render(<KnowledgeHub initialEntries={[]} onToast={onToast} />);
    await screen.findByText("还没有真实上传文件");
    const file = new File([new Uint8Array([0, 255, 1])], "unknown.bin", { type: "application/octet-stream" });
    fireEvent.change(screen.getByLabelText("上传知识文件"), { target: { files: [file] } });
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("上传失败，原件未保存"));
    expect(mutations[0].body).toBeInstanceOf(FormData);
    expect((mutations[0].body as FormData).get("modelProfileId")).toBe("local-qwen3-8b");
    expect((mutations[0].body as FormData).get("file")).toBe(file);
    expect(screen.queryByText("unknown.bin")).not.toBeInTheDocument();
  });

  it("loads the next page instead of hiding uploaded files after number 200", async () => {
    records = Array.from({ length: 201 }, (_, index) => ({ ...entry, id: `entry-${index}`, title: `文件 ${index}` }));
    render(<KnowledgeHub initialEntries={[]} onToast={onToast} />);
    expect(await screen.findByText("文件 200")).toBeInTheDocument();
    expect(requests).toContain("/api/v1/knowledge?limit=200&offset=200");
  });
});
