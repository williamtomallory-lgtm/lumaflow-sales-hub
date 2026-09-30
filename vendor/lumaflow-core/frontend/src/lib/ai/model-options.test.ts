// @vitest-environment node

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModelConfig, getModelHealth } from "./model-config";
import { getModelGenerationOptions, type ModelBackend } from "./model-options";

vi.mock("server-only", () => ({}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function serializedRequest(backend: ModelBackend, mode: "fast" | "normal" | "deep") {
  let body: Record<string, unknown> = {};
  const provider = createOpenAICompatible({
    name: "vllm",
    baseURL: "http://model.test/v1",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        id: "completion-test",
        model: "local-qwen",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  await provider.chatModel("local-qwen").doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...getModelGenerationOptions(mode, backend),
  });
  return body;
}

describe("local model backend options", () => {
  it("serializes vLLM thinking options using the provider's wire format", async () => {
    const body = await serializedRequest("vllm", "deep");
    expect(body).toMatchObject({
      reasoning_effort: "xhigh",
      chat_template_kwargs: { enable_thinking: true },
      top_k: 20,
      temperature: 1,
      top_p: 0.95,
      max_tokens: 8_192,
    });
    expect(body).not.toHaveProperty("reasoningEffort");
  });

  it("disables thinking only on the vLLM fast path", async () => {
    expect(await serializedRequest("vllm", "fast")).toMatchObject({
      reasoning_effort: "low",
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0.7,
      top_p: 0.8,
    });
  });

  it.each(["fast", "normal", "deep"] as const)("does not send vLLM-only parameters to generic runtimes in %s mode", async (mode) => {
    const body = await serializedRequest("openai-compatible", mode);
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("chat_template_kwargs");
    expect(body).not.toHaveProperty("top_k");
    expect(body).toMatchObject({ temperature: 0.7, top_p: 0.8 });
  });

  it.each(["fast", "normal", "deep"] as const)("keeps local Ollama thinking off with a laptop-sized budget in %s mode", async (mode) => {
    const body = await serializedRequest("ollama", mode);
    expect(body.reasoning_effort).toBe("none");
    expect(body).not.toHaveProperty("chat_template_kwargs");
    expect(body).not.toHaveProperty("top_k");
    expect(body.max_tokens).toBeLessThanOrEqual(2_048);
  });

  it("keeps the optional 14B profile within its conservative laptop output ceiling", () => {
    const config = getModelConfig("local-qwen3-14b");
    for (const mode of ["fast", "normal", "deep"] as const) {
      expect(getModelGenerationOptions(mode, config.backend, config.maxOutputTokens).maxOutputTokens)
        .toBeLessThanOrEqual(4_096);
    }
  });

  it("respects the configured ceiling for every mode and backend", () => {
    for (const backend of ["vllm", "openai-compatible"] as const) {
      for (const mode of ["fast", "normal", "deep"] as const) {
        expect(getModelGenerationOptions(mode, backend, 1_024).maxOutputTokens).toBe(1_024);
      }
      expect(getModelGenerationOptions("deep", backend, 16_384).maxOutputTokens).toBe(16_384);
    }
  });

  it("rejects unknown backend configuration and invalid output ceilings", () => {
    vi.stubEnv("LLM_BACKEND", "ollma-typo");
    expect(getModelConfig).toThrow("LLM_BACKEND must be vllm or openai-compatible");
    vi.stubEnv("LLM_BACKEND", "openai-compatible");
    for (const invalid of ["NaN", "255", "32769", "1024.5"]) {
      vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", invalid);
      expect(getModelConfig).toThrow("LLM_MAX_OUTPUT_TOKENS must be an integer");
    }
  });

  it("defaults to vLLM with enough room for a thinking response", () => {
    vi.stubEnv("LLM_BACKEND", undefined);
    vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", undefined);
    expect(getModelConfig()).toMatchObject({ backend: "vllm", maxOutputTokens: 8_192 });
    expect(getModelGenerationOptions("normal", "vllm")).toMatchObject({
      maxOutputTokens: 8_192,
      providerOptions: { vllm: { reasoningEffort: "medium" } },
    });
  });
});

describe("model health must verify the configured model", () => {
  it.each([
    { label: "empty model list", payload: { data: [] } },
    { label: "missing model list", payload: {} },
    { label: "different model", payload: { data: [{ id: "other-model" }] } },
    { label: "malformed model records", payload: { data: [null, { id: 123 }] } },
  ])("reports unavailable for $label", async ({ payload }) => {
    vi.stubEnv("LLM_BACKEND", "openai-compatible");
    vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "8192");
    vi.stubEnv("LLM_BASE_URL", "http://model.test/v1");
    vi.stubEnv("LLM_MODEL", "local-qwen");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
    expect(await getModelHealth()).toMatchObject({ configured: true, reachable: false, model: "local-qwen" });
  });

  it("reports reachable only when the exact model id is advertised", async () => {
    vi.stubEnv("LLM_BACKEND", "openai-compatible");
    vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "8192");
    vi.stubEnv("LLM_BASE_URL", "http://model.test/v1");
    vi.stubEnv("LLM_MODEL", "local-qwen");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{ id: "local-qwen" }] })));
    expect(await getModelHealth()).toMatchObject({ configured: true, reachable: true, model: "local-qwen" });
  });
});
