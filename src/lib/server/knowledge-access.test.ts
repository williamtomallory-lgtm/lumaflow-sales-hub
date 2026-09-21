// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { authorizeLocalKnowledgeRead } from "./api-security";
afterEach(() => vi.unstubAllEnvs());
describe("local uploaded file boundary", () => {
  it("accepts same-origin page reads and rejects cross-site or unauthenticated direct reads", () => {
    const url = "http://localhost:3000/api/v1/knowledge";
    expect(() => authorizeLocalKnowledgeRead(new Request(url, { headers: { "sec-fetch-site": "same-origin" } }))).not.toThrow();
    expect(() => authorizeLocalKnowledgeRead(new Request(url, { headers: { origin: "http://localhost:3000" } }))).not.toThrow();
    expect(() => authorizeLocalKnowledgeRead(new Request(url))).toThrow("当前知识库页面");
    expect(() => authorizeLocalKnowledgeRead(new Request(url, { headers: { origin: "https://evil.invalid" } }))).toThrow("Cross-origin");
    expect(() => authorizeLocalKnowledgeRead(new Request("https://app.example/api/v1/knowledge", { headers: { origin: "https://app.example" } }))).toThrow("尚未启用");
  });
  it("allows only same-origin browser access when remote knowledge is enabled", () => {
    vi.stubEnv("REMOTE_KNOWLEDGE_ENABLED", "true");
    const url = "https://app.example/api/v1/knowledge";
    expect(() => authorizeLocalKnowledgeRead(new Request(url, { headers: { origin: "https://app.example" } }))).not.toThrow();
    expect(() => authorizeLocalKnowledgeRead(new Request(url, { headers: { "sec-fetch-site": "same-origin" } }))).not.toThrow();
    expect(() => authorizeLocalKnowledgeRead(new Request(url))).toThrow("当前知识库页面");
    expect(() => authorizeLocalKnowledgeRead(new Request(url, { headers: { origin: "https://evil.invalid" } }))).toThrow("Cross-origin");
    expect(() => authorizeLocalKnowledgeRead(new Request(url, { headers: { "sec-fetch-site": "cross-site" } }))).toThrow("Cross-origin");
  });
  it("allows an explicit server API token, not arbitrary bearer text", () => {
    vi.stubEnv("ASSISTANT_API_TOKEN", "test-only-token");
    const url = "http://internal.invalid/api/v1/knowledge";
    expect(() => authorizeLocalKnowledgeRead(new Request(url, { headers: { authorization: "Bearer test-only-token" } }))).not.toThrow();
    expect(() => authorizeLocalKnowledgeRead(new Request(url, { headers: { authorization: "Bearer wrong" } }))).toThrow();
  });
});
