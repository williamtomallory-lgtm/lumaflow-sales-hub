// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cloud = vi.hoisted(() => ({ objects: new Map<string, { body: string; etag: string }>(), serial: 0 }));
vi.mock("server-only", () => ({}));
vi.mock("@vercel/blob", () => {
  class BlobPreconditionFailedError extends Error {}
  return {
    BlobPreconditionFailedError,
    put: vi.fn(async (pathname: string, body: string, options: { access: string; allowOverwrite?: boolean; ifMatch?: string }) => {
      if (options.access !== "private") throw new Error("private access required");
      const existing = cloud.objects.get(pathname);
      if (existing && !options.allowOverwrite) throw new Error("already exists");
      if (options.ifMatch && options.ifMatch !== existing?.etag) throw new BlobPreconditionFailedError("stale");
      const etag = String(++cloud.serial);
      cloud.objects.set(pathname, { body, etag });
      return { pathname, etag };
    }),
    get: vi.fn(async (pathname: string, options: { access: string }) => {
      if (options.access !== "private") throw new Error("private access required");
      const object = cloud.objects.get(pathname);
      return object ? { statusCode: 200, stream: new Response(object.body).body, blob: { etag: object.etag } } : null;
    }),
    del: vi.fn(async (pathname: string, options: { ifMatch?: string }) => {
      const existing = cloud.objects.get(pathname);
      if (options.ifMatch && options.ifMatch !== existing?.etag) throw new BlobPreconditionFailedError("stale");
      cloud.objects.delete(pathname);
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({ blobs: [...cloud.objects.keys()].filter((pathname) => pathname.startsWith(prefix)).map((pathname) => ({ pathname })), hasMore: false })),
  };
});

const { createCalendarEventForViewer, getCalendarEventForViewer, listCalendarEventsForViewer, updateCalendarEventForViewer, setCalendarMemberStatusForViewer, deleteCalendarEventForViewer } = await import("./calendar-store");
const { markCalendarViewerActive, listVisibleCalendarPresence } = await import("./calendar-presence");
const alice = { id: "alice-id", email: "alice@example.com", name: "Alice" };
const bob = { id: "bob-id", email: "bob@example.com", name: "Bob" };
const mallory = { id: "mallory-id", email: "mallory@example.com", name: "Mallory" };
const input = { title: "跟进报价", description: "核对客户问题", startAt: "2026-09-25T14:00:00.000Z", endAt: "2026-09-25T15:00:00.000Z", allDay: false, kind: "followup" as const, participantEmails: ["Bob@Example.com"] };
const from = "2026-09-01T00:00:00.000Z", to = "2026-10-01T00:00:00.000Z";

afterEach(() => { cloud.objects.clear(); cloud.serial = 0; vi.unstubAllEnvs(); });

describe("collaborative calendar storage", () => {
  it("keeps private cloud events visible only to the creator and invited accounts", async () => {
    vi.stubEnv("VERCEL", "1"); vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const created = await createCalendarEventForViewer(alice, input);
    expect(created.participantEmails).toEqual([bob.email]);
    expect(created.memberStatuses).toEqual({ [alice.email]: "pending", [bob.email]: "pending" });
    expect((await listCalendarEventsForViewer(bob, from, to)).map((event) => event.id)).toEqual([created.id]);
    expect(await listCalendarEventsForViewer(mallory, from, to)).toEqual([]);
    await expect(updateCalendarEventForViewer(mallory, created.id, { revision: created.revision, title: "窃改" })).rejects.toMatchObject({ status: 404 });
    const updated = await updateCalendarEventForViewer(bob, created.id, { revision: created.revision, status: "completed" });
    expect(updated.status).toBe("completed");
    expect(updated.updatedByName).toBe("Bob");
    await expect(updateCalendarEventForViewer(alice, created.id, { revision: created.revision, title: "过期修改" })).rejects.toMatchObject({ status: 409 });
    expect((await listCalendarEventsForViewer(alice, from, to))[0].status).toBe("completed");
  });

  it("records a participant's own progress and rejects unrelated accounts or stale edits", async () => {
    vi.stubEnv("VERCEL", "1"); vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const created = await createCalendarEventForViewer(alice, input);
    await expect(setCalendarMemberStatusForViewer(mallory, created.id, { revision: created.revision, status: "done" })).rejects.toMatchObject({ status: 404 });
    const updated = await setCalendarMemberStatusForViewer(bob, created.id, { revision: created.revision, status: "in_progress" });
    expect(updated.memberStatuses).toEqual({ [alice.email]: "pending", [bob.email]: "in_progress" });
    expect(updated.memberNames[bob.email]).toBe("Bob");
    await expect(setCalendarMemberStatusForViewer(alice, created.id, { revision: created.revision, status: "done" })).rejects.toMatchObject({ status: 409 });
    expect((await listCalendarEventsForViewer(alice, from, to))[0].memberStatuses[bob.email]).toBe("in_progress");
  });

  it("shows online state only for people on a visible event", async () => {
    vi.stubEnv("VERCEL", "1"); vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    await createCalendarEventForViewer(alice, input);
    await markCalendarViewerActive(alice);
    await markCalendarViewerActive(bob);
    await markCalendarViewerActive(mallory);
    const visible = await listVisibleCalendarPresence(alice, from, to);
    expect(Object.keys(visible).sort()).toEqual([alice.email, bob.email]);
    expect(visible[bob.email]).toMatchObject({ name: "Bob", online: true });
    const bobPath = [...cloud.objects.keys()].find((key) => key.startsWith("calendar/presence/") && JSON.parse(cloud.objects.get(key)!.body).email === bob.email)!;
    const saved = cloud.objects.get(bobPath)!;
    cloud.objects.set(bobPath, { ...saved, body: JSON.stringify({ email: bob.email, name: "Bob", lastSeenAt: "2020-01-01T00:00:00.000Z" }) });
    expect((await listVisibleCalendarPresence(alice, from, to))[bob.email].online).toBe(false);
  });

  it("opens an invited event detail and lets only its creator delete the current revision", async () => {
    vi.stubEnv("VERCEL", "1"); vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const created = await createCalendarEventForViewer(alice, input);
    expect((await getCalendarEventForViewer(bob, created.id)).createdByName).toBe("Alice");
    await expect(getCalendarEventForViewer(mallory, created.id)).rejects.toMatchObject({ status: 404 });
    await expect(deleteCalendarEventForViewer(bob, created.id, created.revision)).rejects.toMatchObject({ status: 403 });
    await expect(deleteCalendarEventForViewer(alice, created.id, "33333333-3333-4333-8333-333333333333")).rejects.toMatchObject({ status: 409 });
    await deleteCalendarEventForViewer(alice, created.id, created.revision);
    await expect(getCalendarEventForViewer(alice, created.id)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects one of two simultaneous cloud edits with Blob ETag preconditions", async () => {
    vi.stubEnv("VERCEL", "1"); vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const created = await createCalendarEventForViewer(alice, input);
    const attempts = await Promise.allSettled([
      updateCalendarEventForViewer(alice, created.id, { revision: created.revision, title: "Alice's edit" }),
      updateCalendarEventForViewer(bob, created.id, { revision: created.revision, title: "Bob's edit" }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected && rejected.status === "rejected" ? rejected.reason : null).toMatchObject({ status: 409 });
  });

  it("persists local events and validates simultaneous edits against a revision", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lumaflow-calendar-test-"));
    vi.stubEnv("VERCEL", "0"); vi.stubEnv("LUMAFLOW_CALENDAR_DIR", directory);
    try {
      const created = await createCalendarEventForViewer(alice, input);
      expect((await listCalendarEventsForViewer(bob, from, to)).map((event) => event.id)).toEqual([created.id]);
      const changed = await updateCalendarEventForViewer(bob, created.id, { revision: created.revision, title: "修订的跟进" });
      expect(changed.title).toBe("修订的跟进");
      await expect(updateCalendarEventForViewer(alice, created.id, { revision: created.revision, title: "旧版" })).rejects.toMatchObject({ status: 409 });
      expect((await listCalendarEventsForViewer(alice, from, to))[0].title).toBe("修订的跟进");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
