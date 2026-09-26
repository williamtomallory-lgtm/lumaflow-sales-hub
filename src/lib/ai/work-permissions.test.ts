// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { CowAgentProfile } from "../contracts/cowagent-agent";

vi.mock("server-only", () => ({}));
vi.mock("../server/web-search", () => ({ searchWeb: vi.fn(async () => [{ title: "Source", url: "https://example.com", content: "Evidence" }]) }));
vi.mock("../server/cowagent-client", () => ({
  getCowAgentProfile: vi.fn(),
  executeCowAgentComputer: vi.fn(async () => ({ exitCode: 0 })),
}));

import { executeCowAgentComputer, getCowAgentProfile } from "../server/cowagent-client";
import { browserTools } from "./browser-tools";
import { computerTools } from "./computer-tools";
import { workAccess } from "./work-permissions";

const read = { read: true, create: false, modify: false, delete: false, tools: false };
const write = { read: true, create: true, modify: true, delete: false, tools: false };
const full = { read: true, create: true, modify: true, delete: true, tools: true };
const profile = (permissions = read): CowAgentProfile => ({ id: "local", name: "Local", enabled: true, type: "local", workspace: "C:/work", knowledgeMode: "own", permissions });
const run = (value: { execute?: unknown }, input: object) => (value.execute as (input: object) => Promise<unknown>)(input);
const accepts = (schema: unknown, input: object) => (schema as z.ZodType).safeParse(input).success;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCowAgentProfile).mockResolvedValue(profile());
});

describe("Work execution permissions", () => {
  it("maps missing permissions to read-only and exposes only allowed actions", () => {
    expect(workAccess()).toBe("read");
    expect(workAccess(read)).toBe("read");
    expect(workAccess(write)).toBe("write");
    expect(workAccess(full)).toBe("full");
    expect(accepts(computerTools("local", read).localComputer.inputSchema, { action: "command" })).toBe(false);
    expect(accepts(computerTools("local", write).localComputer.inputSchema, { action: "edit_file" })).toBe(true);
    expect(accepts(computerTools("local", write).localComputer.inputSchema, { action: "delete_file" })).toBe(false);
    expect(Object.keys(computerTools("local", read))).toEqual(["localComputer"]);
    expect(accepts(browserTools("local", read).webSearch.inputSchema, { query: "公开资料" })).toBe(true);
  });

  it("allows a read-only file lookup without a second roster request", async () => {
    await run(computerTools("local", read).localComputer, { action: "list_files" });
    expect(getCowAgentProfile).not.toHaveBeenCalled();
    expect(executeCowAgentComputer).toHaveBeenCalledWith("local", { action: "list_files" });
  });

  it("keeps file and command permissions enforced before CowAgent", async () => {
    await expect(run(computerTools("local", read).localComputer, { action: "write_file", path: "a.txt", content: "b" })).rejects.toThrow("工作间写入");
    await expect(run(computerTools("local", write).localComputer, { action: "command", command: "echo hi" })).rejects.toThrow("完全访问");
    expect(executeCowAgentComputer).not.toHaveBeenCalled();
  });

  it("rechecks CowAgent on writes and rejects permission revocation", async () => {
    vi.mocked(getCowAgentProfile).mockResolvedValue(profile(read));
    await expect(run(computerTools("local", write).localComputer, { action: "edit_file", path: "a.txt", oldText: "a", newText: "b" })).rejects.toThrow("工作间写入");
    expect(executeCowAgentComputer).not.toHaveBeenCalled();
  });

  it("allows public search with read access and requires full access for commands", async () => {
    await expect(run(browserTools("local", read).webSearch, { query: "公开资料" })).resolves.toMatchObject({ source: "Public web search" });
    await expect(run(computerTools("local", write).localComputer, { action: "command", command: "echo hi" })).rejects.toThrow("完全访问");
    expect(executeCowAgentComputer).not.toHaveBeenCalled();
  });
});
