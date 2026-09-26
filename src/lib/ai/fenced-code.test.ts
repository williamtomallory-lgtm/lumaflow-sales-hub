import { describe, expect, it } from "vitest";
import { splitFencedAnswer } from "./fenced-code";

describe("code answer splitting", () => {
  it("keeps prose around complete fenced code and incomplete streams visible", () => {
    expect(splitFencedAnswer("说明\n```js\nconst x = 1;\n```\n结束")).toEqual([
      { kind: "text", content: "说明\n" },
      { kind: "code", language: "js", content: "const x = 1;", complete: true },
      { kind: "text", content: "结束" },
    ]);
    expect(splitFencedAnswer("```html\n<html>尚未结束")).toEqual([
      { kind: "code", language: "html", content: "<html>尚未结束", complete: false },
    ]);
    expect(splitFencedAnswer("说明\n```ht")).toEqual([
      { kind: "text", content: "说明\n" },
      { kind: "code", language: "ht", content: "", complete: false },
    ]);
  });

  it("recognizes complete HTML and code returned without a fence", () => {
    expect(splitFencedAnswer("网页如下：\n<html><body>ok</body></html>")[1])
      .toMatchObject({ kind: "code", language: "html" });
    expect(splitFencedAnswer("const x = 1;\nfunction add() {\n  return x + 1;\n}"))
      .toEqual([{ kind: "code", language: "javascript", content: "const x = 1;\nfunction add() {\n  return x + 1;\n}" }]);
  });
});
