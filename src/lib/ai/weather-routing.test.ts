// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/complete-answer-stream", () => ({ completeAnswerResponse: vi.fn(async () => new Response("ok")) }));
vi.mock("@/lib/ai/knowledge-context", () => ({ buildKnowledgeContext: vi.fn(async () => ({ text: "", coverage: [] })) }));
import { completeAnswerResponse } from "./complete-answer-stream";
import { POST } from "@/app/api/v1/assistant/chat/route";

beforeEach(() => {
  vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:8081/v1");
  vi.stubEnv("LLM_MODEL", "test-local");
  vi.stubEnv("LLM_BACKEND", "openai-compatible");
  vi.stubEnv("LLM_API_KEY", "test-only");
  vi.mocked(completeAnswerResponse).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("current weather routing", () => {
  it.each([
    ["帮我查查我这里现在的天气", "normal", true],
    ["今天Toronto天气怎么样", "normal", true],
    ["帮我查查我这里现在的天气", "plan", false],
    ["写一个天气网页并保存文件", "normal", false],
  ] as const)("routes %s in %s", async (text, workflowMode, expected) => {
    const response = await POST(new Request("http://localhost:3000/api/v1/assistant/chat", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ id: "weather-route", role: "user", parts: [{ type: "text", text }] }], experience: "chat", workflowMode, mode: "light" }),
    }));
    expect(response.status).toBe(200);
    expect(vi.mocked(completeAnswerResponse).mock.calls.at(-1)?.[0].options.weatherLookup).toBe(expected);
  });
});
