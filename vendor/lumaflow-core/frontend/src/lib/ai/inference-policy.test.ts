import { describe, expect, it } from "vitest";
import { getInferenceProfileInputBudget, resolveInferencePolicy } from "./inference-policy";

describe("inference policy", () => {
  it("exposes bounded current profile budgets for the UI", () => {
    expect(["instant", "medium", "high", "extra-high", "pro"].map((profile) => getInferenceProfileInputBudget(profile as never)))
      .toEqual([4_000, 2_000, 2_000, 1_500, 1_200]);
    expect(resolveInferencePolicy({ mode: "medium", modelProfileId: "local-qwen3-8b" })).toMatchObject({
      requestedProfile: "medium",
      resolvedProfile: "medium",
      thinkingEnabled: true,
      maxOutputTokens: 1_536,
      timeoutMs: 180_000,
      inputBudget: { maxContextCharacters: 2_000 },
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
    expect(() => resolveInferencePolicy({ mode: "medium", modelProfileId: "configured" })).toThrowError(/only exposes the instant/);
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
