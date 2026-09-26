import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkSummaryPanel } from "./work-summary-panel";
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { workspace: "C:/repo", projectName: "repo", git: { branch: "main", additions: 12, deletions: 4, changedFiles: 2, untrackedFiles: 1 } } }))));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("Work summary panel", () => {
  it("counts the latest round of each Agent once and expands real sources and outputs", async () => {
    const open = vi.fn(), add = vi.fn();
    render(<WorkSummaryPanel agentId="agent" progress={[{ agentId: "a", name: "A", round: 1, state: "completed" }, { agentId: "a", name: "A", round: 2, state: "running" }, { agentId: "b", name: "B", round: 1, state: "completed" }]} outputs={[{ id: "file", name: "实际报告.docx", onOpen: open }]} sources={Array.from({ length: 4 }, (_, index) => ({ id: `${index}`, name: `资料${index}` }))} onAddSource={add} />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    expect(screen.getByText("1 运行中 · 1 完成")).toBeInTheDocument();
    expect(screen.queryByText("资料3")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看全部 4 项" }));
    expect(screen.getByText("资料3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "实际报告.docx" })); expect(open).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "添加引用来源" })); expect(add).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "展开工作概况" }));
    expect(screen.getByText("2 个已跟踪文件变更 · 1 个未跟踪项")).toBeInTheDocument();
  });
});
