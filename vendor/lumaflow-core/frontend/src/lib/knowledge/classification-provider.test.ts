// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { classifyKnowledgeText } from "./classification";
afterEach(() => vi.unstubAllGlobals());
describe("real classifier wire format", () => {
  it("sends structured schema and thinking-off options to the selected local model", async () => {
    let sent: Record<string, unknown> | undefined;
    const result = { title: "测试资料", summary: "测试分类结果", category: "产品知识", tags: ["测试"], confidence: 0.8 };
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({ id: "test", object: "chat.completion", created: 1, model: "lumaflow-qwen3-8b:latest", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(result) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 } });
    }));
    expect(await classifyKnowledgeText({ originalName: "sample.txt", text: "测试正文", modelProfileId: "local-qwen3-8b" })).toEqual(result);
    expect(sent).toMatchObject({ model: "lumaflow-qwen3-8b:latest", reasoning_effort: "none", response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } } });
  });
});
