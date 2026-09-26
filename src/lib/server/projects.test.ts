// @vitest-environment node
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../ai/knowledge-context", () => ({ buildKnowledgeContext: async (ids: string[]) => ({ text: ids.length ? "FILE_REFERENCE" : "", coverage: [] }) }));
it("persists project rules/sources and isolates previous chats, then preserves chats on deletion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lumaflow-projects-"));
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory); vi.resetModules();
  try {
    const projects = await import("./projects"); const history = await import("./chat-history");
    const first = await projects.createProject("Thesis"); const other = await projects.createProject("Other");
    await projects.updateProject(first.id, { instructions: "Use verified experiment data", knowledgeBaseIds: [randomUUID()], sources: [{ id: randomUUID(), title: "Result", text: "SOURCE_RESULT", createdAt: new Date().toISOString() }] });
    const now = new Date().toISOString();
    const save = (projectId: string, text: string) => history.saveChatSession({ id: randomUUID(), projectId, title: "Chat", experience: "chat", createdAt: now, updatedAt: now, turns: [{ id: randomUUID(), user: text, assistant: "public answer", createdAt: now }] });
    const chat = await save(first.id, "THESIS_CONTEXT"); await save(other.id, "UNRELATED_SECRET");
    const context = await projects.buildProjectContext(first.id, undefined, 5000);
    expect(context.instructions).toContain("Use verified experiment data");
    expect(context.text).toContain("THESIS_CONTEXT"); expect(context.text).toContain("SOURCE_RESULT"); expect(context.text).toContain("FILE_REFERENCE"); expect(context.text).not.toContain("UNRELATED_SECRET");
    expect((await projects.buildProjectContext(first.id, chat.id, 5000)).text).not.toContain("THESIS_CONTEXT");
    const bounded = await projects.buildProjectContext(first.id, undefined, 600);
    expect(bounded.text.length + bounded.instructions.length).toBeLessThanOrEqual(600);
    await projects.updateProject(other.id, { pinned: true });
    expect((await projects.listProjects())[0]).toMatchObject({ id: other.id, pinned: true });
    expect((await projects.readProject(first.id))?.workspace).toBe(projects.projectWorkspacePath(first.id));
    await projects.deleteProject(first.id);
    expect((await stat(projects.projectWorkspacePath(first.id))).isDirectory()).toBe(true);
    expect(await projects.readProject(first.id)).toBeNull();
    expect(await history.readChatSession(chat.id)).toMatchObject({ projectId: null, turns: [{ user: "THESIS_CONTEXT" }] });
    expect(await projects.readProject(other.id)).not.toBeNull();
  } finally { cwd.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});
