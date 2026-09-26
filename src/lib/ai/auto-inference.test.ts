import { describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateText: vi.fn(async () => ({ text: "medium" })) }));

import { generateText } from "ai";
import { chooseAutoInferenceMode } from "./auto-inference";

const model = { baseURL: "http://127.0.0.1:8081/v1", apiKey: "local", model: "test" };

describe("automatic inference mode", () => {
  it("uses the model's closed-set answer when the mode is supported", async () => {
    expect(await chooseAutoInferenceMode({ text: "解释一个概念", model, supportedModes: ["light", "medium", "ultra"], signal: new AbortController().signal })).toBe("medium");
  });

  it("respects a single supported mode without a second model request", async () => {
    vi.mocked(generateText).mockClear();
    expect(await chooseAutoInferenceMode({ text: "写一篇长文", model, supportedModes: ["light"], signal: new AbortController().signal })).toBe("light");
    expect(generateText).not.toHaveBeenCalled();
  });
});
