import { describe, expect, it } from "vitest";
import { extractCompleteHtml, requestsCodeArtifact } from "./code-artifact";
import { getModelGenerationOptions } from "./model-options";

describe("code artifact generation", () => {
  it("recognizes code tasks without classifying inventory as code", () => {
    expect(requestsCodeArtifact("创建一个html可以离线打开包含踩踏 车轮旋转 支持暂停")).toBe(true);
    expect(requestsCodeArtifact("查一下灯具库存")).toBe(false);
  });
  it("gives local compatible Instant enough space for complete code without enabling reasoning", () => {
    expect(getModelGenerationOptions("instant", "openai-compatible", 4096, true).maxOutputTokens).toBe(4096);
    expect(getModelGenerationOptions("instant", "openai-compatible", 2048, true).maxOutputTokens).toBe(2048);
    expect(getModelGenerationOptions("instant", "openai-compatible", 4096).maxOutputTokens).toBe(4096);
    expect(getModelGenerationOptions("instant", "ollama", 4096, true).maxOutputTokens).toBe(4096);
  });
  it("does not offer a truncated HTML download or execute the generated code", () => {
    expect(extractCompleteHtml("```html\n<html><body>unfinished")).toBeNull();
    expect(extractCompleteHtml("```html\n<html><body>ok</body></html>\n```")).toBe("<html><body>ok</body></html>");
  });
});
