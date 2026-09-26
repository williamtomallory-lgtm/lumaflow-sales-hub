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
