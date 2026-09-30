import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectSidebar, ProjectWorkspace } from "./project-workspace";
const project = { id: "11111111-1111-4111-8111-111111111111", name: "Thesis", instructions: "Check results", knowledgeBaseIds: [], memoryMode: "project-only", sources: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("creates a persistent project from the sidebar", async () => {
  const onSelect = vi.fn(); const posts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => { if (init?.method === "POST") { posts.push(JSON.parse(init.body)); return Response.json({ data: project }); } return Response.json({ data: [] }); }));
  render(<ProjectSidebar onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
  fireEvent.change(screen.getByRole("textbox", { name: "新项目名称" }), { target: { value: "Thesis" } });
  fireEvent.click(screen.getByRole("dialog").querySelector("button[type=submit]")!);
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(project.id)); expect(posts).toEqual([{ name: "Thesis", memoryMode: "project-only", knowledgeBaseIds: [] }]);
});
it("saves project instructions and opens an independent project chat", async () => {
  const changes: unknown[] = []; const onNewChat = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url, init) => { if (init?.method === "PATCH") { const body = JSON.parse(init.body); changes.push(body); return Response.json({ data: { ...project, ...body } }); } return Response.json({ data: String(url).includes("knowledge") ? [] : { project, chats: [] } }); }));
  render(<ProjectWorkspace projectId={project.id} onBack={vi.fn()} onOpenChat={vi.fn()} onNewChat={onNewChat} />);
  const input = await screen.findByRole("textbox", { name: "项目规则" });
  fireEvent.change(input, { target: { value: "Always cite experiment files" } });
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(changes).toEqual([expect.objectContaining({ instructions: "Always cite experiment files", memoryMode: "project-only" })]));
  fireEvent.click(screen.getByRole("button", { name: "新聊天" })); expect(onNewChat).toHaveBeenCalledWith(project.id, "chat");
  fireEvent.click(screen.getByRole("button", { name: /^Work$/ }));
  fireEvent.click(screen.getByRole("button", { name: "新聊天" }));
  expect(onNewChat).toHaveBeenLastCalledWith(project.id, "work");
  expect(screen.queryByRole("button", { name: "Wechat Agent" })).not.toBeInTheDocument();
});
it("opens the project context menu and requires confirmation before removal", async () => {
  const onRemoved = vi.fn(); const deletes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init?.method === "DELETE") { deletes.push(String(url)); return Response.json({ data: { deleted: true } }); }
    return Response.json({ data: String(url).includes("history") ? [] : [project] });
  }));
  render(<ProjectSidebar onSelect={vi.fn()} onRemoved={onRemoved} />);
  fireEvent.contextMenu(await screen.findByRole("button", { name: /^Thesis$/ }), { clientX: 100, clientY: 150 });
  expect(screen.getByRole("menuitem", { name: "在资源管理器中打开" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: /归档/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "移除项目" }));
  expect(deletes).toHaveLength(0); expect(screen.getByRole("dialog", { name: "移除项目确认" })).toHaveTextContent("文件和工作目录会保留");
  fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
  await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(project.id)); expect(deletes).toHaveLength(1);
});

it("keeps image conversations in their own sidebar category", async () => {
  const textChat = { id: "22222222-2222-4222-8222-222222222222", experience: "chat", title: "普通对话", turnCount: 1, hasImage: false };
  const imageChat = { id: "33333333-3333-4333-8333-333333333333", experience: "chat", title: "图片生成", turnCount: 1, hasImage: true };
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url).includes("assistant/history")) return Response.json({ data: [imageChat, textChat] });
    return Response.json({ data: [] });
  }));
  const onOpenHistory = vi.fn();
  render(<ProjectSidebar onSelect={vi.fn()} onOpenHistory={onOpenHistory} recentAvailable={false} recentContent={<div data-testid="history-host" />} />);
  expect(screen.getByTestId("history-host")).toHaveAttribute("data-history-category", "chat");
  await waitFor(() => expect(screen.getByRole("tabpanel", { name: "Chat 对话" })).toHaveTextContent("普通对话"));
  expect(screen.getByRole("tabpanel", { name: "Chat 对话" })).not.toHaveTextContent("图片生成");
  fireEvent.click(screen.getByRole("tab", { name: "Image" }));
  expect(screen.getByTestId("history-host")).toHaveAttribute("data-history-category", "image");
  expect(screen.getByRole("tabpanel", { name: "Image 对话" })).toHaveTextContent("图片生成");
  expect(screen.getByRole("tabpanel", { name: "Image 对话" })).not.toHaveTextContent("普通对话");
  fireEvent.click(screen.getByRole("button", { name: "图片生成 · 1 轮" }));
  expect(onOpenHistory).toHaveBeenCalledWith("image", imageChat.id, null);
});

it("offers a new-session action for the selected history category", () => {
  const onNewHistory = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })));
  render(<ProjectSidebar onSelect={vi.fn()} onNewHistory={onNewHistory} recentContent={<div />} />);
  fireEvent.click(screen.getByRole("tab", { name: "Work" }));
  fireEvent.click(screen.getByRole("button", { name: "新建Work对话" }));
  expect(onNewHistory).toHaveBeenCalledWith("work");
});

it("shows the two scrollable areas without extra horizontal resize handles", () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })));
  render(<ProjectSidebar onSelect={vi.fn()} recentContent={<div />} />);
  expect(screen.getByLabelText("项目")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "对话记录列表" })).toBeInTheDocument();
  expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Image" }));
  expect(screen.getByRole("tabpanel", { name: "Image 对话" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "对话记录列表" })).toBeInTheDocument();
});

it("keeps WeChat history searchable and selectable when another workspace page is open", async () => {
  const onOpenHistory = vi.fn();
  const time = "2026-09-26T10:00:00.000Z";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("action=conversations")) return Response.json({ data: { items: [{ id: "wechat-a", title: "采购资料", createdAt: time, updatedAt: time, preview: "采购摘要" }, { id: "wechat-b", title: "售后记录", createdAt: time, updatedAt: time, preview: "售后摘要" }], nextCursor: null } });
    if (url.includes("action=messages")) { const conversationId = new URL(url, "http://localhost").searchParams.get("conversationId") || ""; const first = conversationId === "wechat-a"; return Response.json({ data: { items: [{ id: `message-${first ? "a" : "b"}`, conversationId, role: "assistant", text: first ? "正文里才有的订单关键字" : "其他正文", createdAt: time, source: "work", status: "completed" }], nextCursor: null, pendingActions: [] } }); }
    return Response.json({ data: [] });
  }));
  render(<ProjectSidebar onSelect={vi.fn()} onOpenHistory={onOpenHistory} recentContent={<div />} />);
  fireEvent.click(await screen.findByRole("tab", { name: "Wechat Agent" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "采购资料" })).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("搜索对话"), { target: { value: "订单关键字" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "采购资料" })).toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "售后记录" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "采购资料" }));
  expect(onOpenHistory).toHaveBeenCalledWith("wechat", "wechat-a");
});
