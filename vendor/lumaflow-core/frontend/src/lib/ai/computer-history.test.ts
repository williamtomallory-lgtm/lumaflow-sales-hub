import { expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { compactComputerHistory } from "./computer-history";

it("compacts old pages without changing the current page, identity or real receipts", () => {
  const page = "x".repeat(4000);
  const messages: ModelMessage[] = [
    { role: "user", content: "执行我的任务" },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "one", toolName: "localComputer", output: { type: "json", value: { path: "file.html", content: page, offsetCharacters: 0, nextOffset: 4000 } } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "two", toolName: "localComputer", output: { type: "json", value: { path: "file.html", content: page, offsetCharacters: 4000, nextOffset: null } } }] },
  ];
  const result = compactComputerHistory(messages);
  expect(result[0]).toEqual(messages[0]);
  expect(JSON.stringify(result[1])).toContain("正文已折叠");
  expect(JSON.stringify(result[1])).toContain('"nextOffset":4000');
  expect(result[2]).toEqual(messages[2]);
  expect(JSON.stringify(messages[1])).not.toContain("已折叠");
});

it("folds already-submitted large file payloads, but not replacement snippets", () => {
  const messages: ModelMessage[] = [{ role: "assistant", content: [
    { type: "tool-call", toolCallId: "write", toolName: "localComputer", input: { action: "write_file", path: "file.html", content: "x".repeat(2000) } },
    { type: "tool-call", toolCallId: "edit", toolName: "localComputer", input: { action: "edit_file", oldText: "old", newText: "new" } },
  ] }];
  const result = compactComputerHistory(messages);
  expect(JSON.stringify(result)).toContain("已提交的文件内容已折叠");
  expect(JSON.stringify(result)).toContain('"newText":"new"');
});
