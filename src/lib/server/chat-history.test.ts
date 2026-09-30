// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

it("persists history metadata without losing transcripts or older-client pins", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lumaflow-history-"));
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
  vi.resetModules();
  try {
    const history = await import("./chat-history");
    const now = new Date().toISOString();
    const session = { id: randomUUID(), experience: "chat", title: "Original", createdAt: now, updatedAt: now, turns: [{ id: randomUUID(), user: "Question", assistant: "Answer", createdAt: now, versions: [{ id: randomUUID(), user: "分支中的完整正文", assistant: "Branch answer", createdAt: now }] }] };
    await history.saveChatSession(session);
    await history.updateChatSessionMetadata(session.id, { title: "Renamed", pinned: true, archived: true });
    const reopened = await history.readChatSession(session.id);
    expect(reopened).toMatchObject({ title: "Renamed", pinned: true, archived: true });
    expect(reopened?.turns[0]).toMatchObject({ user: "Question", assistant: "Answer" });
    await history.saveChatSession({ ...session, title: "Renamed" });
    expect(await history.listChatSessions()).toEqual([expect.objectContaining({ id: session.id, title: "Renamed", pinned: true, archived: true })]);
    await history.saveChatSession({ ...session, id: randomUUID(), title: "图片结果", turns: [{ id: randomUUID(), user: "请生成一张图片", assistant: "图片已由本机 Qwen-Image-2.1 生成。\n图片文件：/api/v1/assistant/image-operations/assets/0123456789abcdef0123456789abcdef.png", createdAt: now, attachments: [] }] });
    const listed = await history.listChatSessions();
    expect(listed.find((item) => item.id === session.id)?.hasImage).toBe(false);
    expect(listed.find((item) => item.id === session.id)?.searchableText).toContain("Question");
    expect(listed.find((item) => item.id === session.id)?.searchableText).toContain("分支中的完整正文");
    expect((await history.listChatSessions("分支中的完整正文")).map((item) => item.id)).toContain(session.id);
    expect(listed.find((item) => item.title === "图片结果")?.hasImage).toBe(true);
    await history.updateChatSessionMetadata(session.id, { archived: false });
    expect(await history.readChatSession(session.id)).toMatchObject({ pinned: true, archived: false });
  } finally {
    cwd.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
