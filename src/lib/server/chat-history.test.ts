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
    const session = { id: randomUUID(), experience: "chat", title: "Original", createdAt: now, updatedAt: now, turns: [{ id: randomUUID(), user: "Question", assistant: "Answer", createdAt: now }] };
    await history.saveChatSession(session);
    await history.updateChatSessionMetadata(session.id, { title: "Renamed", pinned: true, archived: true });
    const reopened = await history.readChatSession(session.id);
    expect(reopened).toMatchObject({ title: "Renamed", pinned: true, archived: true });
    expect(reopened?.turns[0]).toMatchObject({ user: "Question", assistant: "Answer" });
    await history.saveChatSession({ ...session, title: "Renamed" });
    expect(await history.listChatSessions()).toEqual([expect.objectContaining({ id: session.id, title: "Renamed", pinned: true, archived: true })]);
    await history.updateChatSessionMetadata(session.id, { archived: false });
    expect(await history.readChatSession(session.id)).toMatchObject({ pinned: true, archived: false });
  } finally {
    cwd.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
