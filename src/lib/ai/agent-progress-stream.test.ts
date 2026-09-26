// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./sales-agent", () => ({ salesAgent: { tools: {}, stream: vi.fn(async () => ({ stream: new ReadableStream({ start(controller) {
  controller.enqueue({ type: "text-start", id: "text" });
  controller.enqueue({ type: "text-delta", id: "text", text: "Final answer" });
  controller.enqueue({ type: "text-end", id: "text" });
  controller.close();
} }), finishReason: Promise.resolve("stop"), text: Promise.resolve("Final answer") })) } }));
import { completeAnswerResponse } from "./complete-answer-stream";
import { salesAgent } from "./sales-agent";

describe("collaboration progress stream", () => {
  it("preserves actual completed member replies when preparation fails before a final answer", async () => {
    const response = await completeAnswerResponse({
      uiMessages: [{ role: "user", parts: [{ type: "text", text: "Discuss" }] }],
      options: { mode: "light", modelProfileId: "configured", codeArtifact: false, browserLookup: false, weatherLookup: false, continuation: false, profile: { instructions: "Lead", toolNames: [] } },
      abortSignal: new AbortController().signal, timeoutMs: 10_000, headers: {},
      prepare: async (emit) => {
        emit({ agentId: "one", name: "One", round: 1, state: "completed", text: "Actual argument" });
        emit({ agentId: "one", name: "One", round: 2, state: "running" });
        throw new DOMException("Timed out", "TimeoutError");
      },
    });
    const raw = await response.text();
    expect(raw).toContain("未完成最终回复");
    expect(raw).toContain("Actual argument");
    expect(raw).toContain('"state":"failed"');
    expect(raw).toContain('"finishReason":"error"');
  });
  it("sends real member progress before discussion finishes, then passes notes to the lead", async () => {
    vi.mocked(salesAgent.stream).mockClear();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const response = await completeAnswerResponse({
      uiMessages: [{ role: "user", parts: [{ type: "text", text: "Discuss" }] }],
      options: { mode: "light", modelProfileId: "configured", codeArtifact: false, browserLookup: false, weatherLookup: false, continuation: false, profile: { instructions: "Lead", toolNames: [] } },
      abortSignal: new AbortController().signal, timeoutMs: 10_000, headers: {},
      prepare: async (emit) => {
        emit({ agentId: "one", name: "One", round: 1, state: "running" });
        await pending;
        emit({ agentId: "one", name: "One", round: 1, state: "completed", text: "Real report" });
        return " Team notes";
      },
    });
    const reader = response.body!.getReader();
    let raw = "";
    while (!raw.includes("data-agent-progress")) {
      const chunk = await reader.read();
      raw += new TextDecoder().decode(chunk.value);
    }
    expect(raw).toContain('"state":"running"');
    expect(salesAgent.stream).not.toHaveBeenCalled();
    release();
    while (true) { const chunk = await reader.read(); if (chunk.done) break; raw += new TextDecoder().decode(chunk.value); }
    expect(raw).toContain('"state":"completed"');
    expect(raw).toContain("Real report");
    expect(vi.mocked(salesAgent.stream)).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ profile: expect.objectContaining({ instructions: "Lead Team notes" }) }) }));
  });
  it("reserves time for a final answer after the member stage times out", async () => {
    const response = await completeAnswerResponse({
      uiMessages: [{ role: "user", parts: [{ type: "text", text: "Discuss" }] }],
      options: { mode: "light", modelProfileId: "configured", codeArtifact: false, browserLookup: false, weatherLookup: false, continuation: false, profile: { instructions: "Lead", toolNames: [] } },
      abortSignal: new AbortController().signal, timeoutMs: 200, headers: {},
      prepare: async (_emit, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return "Only completed reports; remaining work timed out.";
      },
    });
    const raw = await response.text();
    expect(raw).toContain("Final answer");
    expect(raw).toContain('"finishReason":"stop"');
  });
});
