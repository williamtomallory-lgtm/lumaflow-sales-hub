import { describe, expect, it } from "vitest";
import { extractCompleteHtml, requestsCodeArtifact } from "./code-artifact";

describe("code artifact detection", () => {
  it("recognizes a requested HTML page without changing permissions", () => {
    expect(requestsCodeArtifact("创建一个离线 HTML 动画页面")).toBe(true);
    expect(requestsCodeArtifact("查询灯具库存")).toBe(false);
  });

  it("only downloads a closed HTML document", () => {
    expect(extractCompleteHtml("```html\n<!doctype html><html><body>ok</body></html>\n```"))
      .toContain("</html>");
    expect(extractCompleteHtml("```html\n<html><body>incomplete\n```")) .toBeNull();
  });
});
