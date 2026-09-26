import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationHistoryList, type ConversationHistoryItem } from "./conversation-history-list";

afterEach(() => cleanup());

const items: ConversationHistoryItem[] = [
  { id: "one", title: "今天的天气", pinned: true },
  { id: "two", title: "客户资料整理" },
  { id: "three", title: "已归档的记录", archived: true },
];

function renderList(overrides: Partial<React.ComponentProps<typeof ConversationHistoryList>> = {}) {
  return render(<ConversationHistoryList items={items} selectedId="one" onSelect={vi.fn()} onRename={vi.fn()} onPin={vi.fn()} onMoveToProject={vi.fn()} onDelete={vi.fn()} onShare={vi.fn()} {...overrides} />);
}

describe("ConversationHistoryList", () => {
  it("renders compact titles, selects a row, and keeps the pinned row first", () => {
    const onSelect = vi.fn();
    renderList({ onSelect });
    const list = screen.getByRole("region", { name: "对话记录列表" });
    expect(within(list).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["今天的天气", "客户资料整理", "已归档的记录"]);
    expect(within(list).queryByText("2026")).not.toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "客户资料整理" }));
    expect(onSelect).toHaveBeenCalledWith("two");
  });

  it("supports search and shows legacy archived chats without an archive control", () => {
    renderList();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索对话" }), { target: { value: "客户" } });
    expect(screen.getByRole("button", { name: "客户资料整理" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "今天的天气" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "已归档" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清除搜索" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getByRole("button", { name: "已归档的记录" })).toBeInTheDocument();
  });

  it("exposes keyboard friendly menu actions and inline rename", () => {
    const onRename = vi.fn();
    const onPin = vi.fn();
    const onMoveToProject = vi.fn();
    const onDelete = vi.fn();
    const onShare = vi.fn();
    renderList({ onRename, onPin, onMoveToProject, onDelete, onShare });
    fireEvent.click(screen.getByRole("button", { name: "更多操作 客户资料整理" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "分享" })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "重命名 客户资料整理" });
    fireEvent.change(input, { target: { value: "客户跟进" } });
    fireEvent.submit(input.closest("form")!);
    expect(onRename).toHaveBeenCalledWith("two", "客户跟进");

    fireEvent.click(screen.getByRole("button", { name: "更多操作 客户资料整理" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));
    expect(onPin).toHaveBeenCalledWith("two", true);
    fireEvent.click(screen.getByRole("button", { name: "更多操作 客户资料整理" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "移至项目" }));
    expect(onMoveToProject).toHaveBeenCalledWith("two");
    fireEvent.click(screen.getByRole("button", { name: "更多操作 今天的天气" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "分享" }));
    expect(onShare).toHaveBeenCalledWith("one");
    fireEvent.click(screen.getByRole("button", { name: "更多操作 今天的天气" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(onDelete).toHaveBeenCalledWith("one");
  });
});
