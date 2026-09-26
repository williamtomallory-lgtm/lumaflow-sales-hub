import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CodeAnswer } from "./code-answer";

afterEach(cleanup);

describe("code answer", () => {
  it("shows colored code, copy control and an isolated HTML preview", () => {
    const { container } = render(<CodeAnswer text={'页面：\n```html\n<html><head></head><body><h1>Hello</h1><script>document.body.dataset.ready = "1"</script></body></html>\n```'} />);
    expect(screen.getByRole("region", { name: "html 代码块" })).toBeInTheDocument();
    expect(container.querySelector(".hljs-tag")).not.toBeNull();
    expect(screen.getByRole("button", { name: "复制代码" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "预览 HTML" }));
    const preview = screen.getByTitle("HTML 隔离预览");
    expect(preview).toHaveAttribute("sandbox", "allow-scripts");
    expect(preview.getAttribute("srcdoc")).toContain("connect-src 'none'");
    expect(preview.getAttribute("srcdoc")).toContain("<h1>Hello</h1>");
  });

  it("waits for a complete answer before offering preview", () => {
    render(<CodeAnswer text={'```html\n<html><body>ok</body></html>\n```'} complete={false} />);
    expect(screen.queryByRole("button", { name: "预览 HTML" })).not.toBeInTheDocument();
  });

  it("creates the code card during a streamed, unfinished fence and renders markdown headings", () => {
    render(<CodeAnswer text={'## 说明\n\n```html\n<html><body>写到一半'} complete={false} />);
    expect(screen.getByRole("heading", { name: "说明" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "html 代码块" })).toHaveTextContent("正在生成");
    expect(screen.queryByRole("button", { name: "预览 HTML" })).not.toBeInTheDocument();
  });

  it("labels an unfinished final answer as incomplete rather than still generating", () => {
    render(<CodeAnswer text={'```html\n<html><body>未结束'} />);
    expect(screen.getByRole("region", { name: "html 代码块" })).toHaveTextContent("代码块未闭合");
    expect(screen.queryByText("正在生成…")).not.toBeInTheDocument();
  });
});
