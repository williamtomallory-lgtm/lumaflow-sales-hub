// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { git, profile } = vi.hoisted(() => ({ git: vi.fn(), profile: vi.fn() }));
vi.mock("node:util", () => ({ promisify: () => git }));
vi.mock("@/lib/server/cowagent-client", () => ({ getCowAgentProfile: profile }));
import { GET } from "./route";

beforeEach(() => {
  profile.mockReset().mockResolvedValue({ id: "agent", name: "Agent", enabled: true, type: "local", workspace: "C:/my-work", permissions: { read: true, create: false, modify: false, delete: false, tools: false } });
  git.mockReset().mockImplementation(async (_binary, args) => ({ stdout: args.includes("--show-toplevel") ? "C:/my-work" : args.includes("--abbrev-ref") ? "main" : args.includes("--numstat") ? "12\t3\tsrc/main.ts\n-\t-\timage.png" : " M src/main.ts\n?? new.txt\n" }));
});
const request = (host = "localhost") => new Request(`http://${host}:3000/api/v1/work/summary?agentId=agent`, { headers: { origin: `http://${host}:3000` } });

describe("read-only Work summary", () => {
  it("uses the authorized Agent workspace and reports tracked diff separately from untracked files", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).data.git).toEqual({ branch: "main", additions: 12, deletions: 3, changedFiles: 1, untrackedFiles: 1 });
    expect(git.mock.calls.every(([binary, args, options]) => binary === "git" && args[0] === "-C" && args[1] === "C:/my-work" && options.windowsHide === true)).toBe(true);
  });
  it("does not invent Git statistics for an ordinary folder", async () => {
    git.mockRejectedValue(new Error("not a git repository"));
    const response = await GET(request());
    expect((await response.json()).data.git).toBeNull();
  });
  it("blocks remote requests and profiles without read access", async () => {
    expect((await GET(request("example.com"))).status).toBe(403);
    expect(git).not.toHaveBeenCalled();
    profile.mockResolvedValue({ type: "local", workspace: "C:/private", permissions: { read: false } });
    expect((await GET(request())).status).not.toBe(200);
    expect(git).not.toHaveBeenCalled();
  });
});
