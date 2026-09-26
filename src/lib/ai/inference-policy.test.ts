import { describe, expect, it } from "vitest";
import { getInferenceProfileInputBudget, resolveInferencePolicy } from "./inference-policy";

describe("inference policy", () => {
  it("exposes bounded current profile budgets for the UI", () => {
    expect(["light", "medium", "ultra"].map((profile) => getInferenceProfileInputBudget(profile as never)))
      .toEqual([4_000, 4_000, 4_000]);
    expect(resolveInferencePolicy({ mode: "medium", modelProfileId: "local-qwen3-8b" })).toMatchObject({
      requestedProfile: "medium",
      resolvedProfile: "medium",
      thinkingEnabled: true,
      maxOutputTokens: 2_048,
      timeoutMs: 180_000,
      inputBudget: { maxContextCharacters: 4_000 },
    });
    expect(resolveInferencePolicy({ mode: "ultra", modelProfileId: "configured", configuredSupportedModes: ["light", "medium", "ultra"] })).toMatchObject({
      maxOutputTokens: 3_072,
      timeoutMs: 290_000,
      inputBudget: { maxContextCharacters: 4_000 },
    });
  });

  it("uses the verified 32K runtime without increasing 8K model budgets", () => {
    expect(resolveInferencePolicy({ mode: "ultra", modelProfileId: "configured", configuredSupportedModes: ["ultra"], modelContextTokens: 32_768, modelMaxOutputTokens: 8_192 })).toMatchObject({
      maxOutputTokens: 6_144,
      inputBudget: { maxContextCharacters: 12_000 },
    });
    expect(resolveInferencePolicy({ mode: "ultra", modelProfileId: "configured", configuredSupportedModes: ["ultra"], modelContextTokens: 8_192, modelMaxOutputTokens: 8_192 })).toMatchObject({
      maxOutputTokens: 3_072,
      inputBudget: { maxContextCharacters: 4_000 },
    });
  });

  it("routes Pro from either local selection to the exact 14B profile", () => {
    expect(resolveInferencePolicy({ mode: "pro", modelProfileId: "local-qwen3-8b" })).toMatchObject({
      requestedModelProfileId: "local-qwen3-8b",
      resolvedModelProfileId: "local-qwen3-14b",
      maxOutputTokens: 4_096,
      timeoutMs: 300_000,
    });
    expect(resolveInferencePolicy({ mode: "pro", modelProfileId: "local-qwen3-14b" }).resolvedModelProfileId).toBe("local-qwen3-14b");
  });

  it("does not promise unsupported thinking modes for custom services", () => {
    expect(() => resolveInferencePolicy({ mode: "medium", modelProfileId: "configured" })).toThrowError(/未声明支持/);
    expect(resolveInferencePolicy({ mode: "medium", modelProfileId: "configured", configuredSupportedModes: ["instant", "medium"] }).resolvedProfile).toBe("medium");
    expect(() => resolveInferencePolicy({ mode: "pro", modelProfileId: "configured" })).toThrowError(/qwen3:14b/);
  });

  it("keeps legacy modes and timeout overrides compatible", () => {
    expect(resolveInferencePolicy({ mode: "fast", modelProfileId: "configured" })).toMatchObject({
      resolvedProfile: "legacy-fast",
      thinkingEnabled: false,
      timeoutMs: 120_000,
      inputBudget: { maxContextCharacters: 4_000 },
    });
    expect(resolveInferencePolicy({ mode: "deep", modelProfileId: "configured", configuredTimeoutMs: 500_000 })).toMatchObject({
      resolvedProfile: "legacy-deep",
      thinkingEnabled: true,
      timeoutMs: 300_000,
    });
    expect(resolveInferencePolicy({ mode: "high", modelProfileId: "local-qwen3-8b", configuredTimeoutMs: 10_000 }).timeoutMs).toBe(10_000);
  });
});
