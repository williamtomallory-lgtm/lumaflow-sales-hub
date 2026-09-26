import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneratedFilePanel } from "./generated-file-panel";

afterEach(cleanup);

describe("generated file preview", () => {
  it("shows the entire document in a scrollable preview with local export options", () => {
    const content = `# 长文标题\n\n${"完整正文段落。\n\n".repeat(120)}文档结尾。`;
    render(<GeneratedFilePanel title="我的文档" content={content} kind="document" busy={false} onClose={vi.fn()} />);
    expect(screen.getByRole("complementary", { name: "生成文件预览" })).toHaveTextContent("文档结尾。");
    expect(screen.getByRole("button", { name: "下载 Markdown" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "下载 Word" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "下载 PDF" })).toBeEnabled();
  });

  it("offers Excel export while keeping the full table visible", () => {
    render(<GeneratedFilePanel title="报价" content={"| 型号 | 价格 |\n| --- | --- |\n| A1 | 99 |"} kind="spreadsheet" busy={false} onClose={vi.fn()} />);
    expect(screen.getByRole("complementary", { name: "生成文件预览" })).toHaveTextContent("A1");
    expect(screen.getByRole("button", { name: "下载 Excel" })).toBeEnabled();
  });

  it("uses PDF as the file name and primary export for a PDF request", () => {
    render(<GeneratedFilePanel title="短文" content="# 回声之站\n\n正文。" kind="document" preferredFormat="pdf" busy={false} onClose={vi.fn()} />);
    expect(screen.getByRole("complementary", { name: "生成文件预览" })).toHaveTextContent("短文.pdf");
    expect(screen.getByRole("button", { name: "下载 PDF" })).toBeEnabled();
  });

  it("renders complete HTML in an isolated full-size preview", () => {
    render(<GeneratedFilePanel title="网页" content={'```html\n<html><head></head><body><h1>页面</h1></body></html>\n```'} kind="html" busy={false} onClose={vi.fn()} />);
    const preview = screen.getByTitle("生成的 HTML 页面预览");
    expect(preview).toHaveAttribute("sandbox", "allow-scripts");
    expect(preview.getAttribute("srcdoc")).toContain("<h1>页面</h1>");
    expect(screen.getByRole("button", { name: "下载 HTML" })).toBeEnabled();
  });
});
