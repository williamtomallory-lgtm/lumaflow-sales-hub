// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getModelConfig,
  getModelHealth,
  getModelOptions,
  LOCAL_MODEL_ID,
  LOCAL_QWEN3_14B_MODEL_ID,
} from "./model-config";
import { assistantModelsResponseSchema } from "../contracts/api";

vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.stubEnv("LLM_BACKEND", "openai-compatible");
  vi.stubEnv("LLM_BASE_URL", "http://configured.invalid/v1");
  vi.stubEnv("LLM_MODEL", "custom-model");
  vi.stubEnv("LLM_API_KEY", "server-secret-do-not-expose");
  vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "8192");
  vi.stubEnv("LLM_CONNECTION_KIND", "protocol-mock");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("allowlisted model profiles", () => {
  it("isolates local settings from custom model environment values", () => {
    expect(getModelConfig("local-qwen3-8b")).toMatchObject({
      model: LOCAL_MODEL_ID,
      baseURL: "http://127.0.0.1:11434/v1",
      backend: "ollama",
      maxOutputTokens: 4_096,
      connectionKind: "live",
      contextTokens: 8_192,
    });
    expect(getModelConfig()).toMatchObject({ model: "custom-model", profileId: "configured", contextTokens: null });
  });

  it("configures the optional 14B profile against the official Ollama tag", () => {
    expect(getModelConfig("local-qwen3-14b")).toMatchObject({
      model: LOCAL_QWEN3_14B_MODEL_ID,
      baseURL: "http://127.0.0.1:11434/v1",
      backend: "ollama",
      maxOutputTokens: 4_096,
      connectionKind: "live",
      contextTokens: 8_192,
    });
    expect(getModelConfig("local-qwen3-14b").description).toContain("CPU/GPU 混合");
  });

  it("reports unavailable when Ollama responds but the requested alias is not installed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{ id: "qwen3:8b" }] })));
    expect(await getModelHealth("local-qwen3-8b")).toMatchObject({
      configured: true, reachable: false, model: LOCAL_MODEL_ID, profileId: "local-qwen3-8b",
    });
  });

  it("reports the 14B profile reachable only for the exact official tag", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{ id: LOCAL_QWEN3_14B_MODEL_ID }] })));
    expect(await getModelHealth("local-qwen3-14b")).toMatchObject({
      configured: true, reachable: true, model: LOCAL_QWEN3_14B_MODEL_ID, profileId: "local-qwen3-14b",
    });
  });

  it("publishes only display metadata and never the service URL or key", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({
      data: url.includes("11434")
        ? [{ id: LOCAL_MODEL_ID }, { id: LOCAL_QWEN3_14B_MODEL_ID }]
        : [{ id: "custom-model" }],
    })));
    const models = await getModelOptions();
    const payload = assistantModelsResponseSchema.parse({
      data: { defaultProfileId: "local-qwen3-8b", models },
      meta: { apiVersion: "v1", requestId: "models-test" },
    });
    expect(payload.data.models).toHaveLength(3);
    expect(payload.data.models.every((item) => item.reachable)).toBe(true);
    expect(payload.data.models[0]).toMatchObject({ family: "Qwen3", parameterSizeB: 8, supportedModes: ["instant", "medium", "high", "extra-high"] });
    expect(payload.data.models[1]).toMatchObject({ family: "Qwen3", parameterSizeB: 14, supportedModes: ["instant", "medium", "high", "extra-high", "pro"] });
    expect(payload.data.models[2]).toMatchObject({ family: "custom", parameterSizeB: null, supportedModes: ["instant"] });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("server-secret");
    expect(serialized).not.toContain("http://");
    expect(serialized).not.toContain("Qwen3.8");
  });

  it("validates the health query allowlist before probing a service", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { GET } = await import("../../app/api/v1/assistant/health/route");
    const response = await GET(new Request("http://localhost:3000/api/v1/assistant/health?modelProfileId=unknown"));
    expect(response.status).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the local model selectable when an optional custom profile is invalid", async () => {
    vi.stubEnv("LLM_BACKEND", "bad-backend");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{ id: LOCAL_MODEL_ID }] })));
    const models = await getModelOptions();
    expect(models[0]).toMatchObject({ id: "local-qwen3-8b", reachable: true, configured: true });
    expect(models[2]).toMatchObject({ id: "configured", reachable: false, configured: false });
  });

  it("serves the model catalog with the local profile as the UI default", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({
      data: url.includes("11434")
        ? [{ id: LOCAL_MODEL_ID }, { id: LOCAL_QWEN3_14B_MODEL_ID }]
        : [{ id: "custom-model" }],
    })));
    const { GET } = await import("../../app/api/v1/assistant/models/route");
    const response = await GET(new Request("http://localhost:3000/api/v1/assistant/models"));
    expect(response.status).toBe(200);
    const payload = assistantModelsResponseSchema.parse(await response.json());
    expect(payload.data.defaultProfileId).toBe("local-qwen3-8b");
    expect(payload.data.models.map((item) => item.id)).toEqual(["local-qwen3-8b", "local-qwen3-14b", "configured"]);
  });
});
