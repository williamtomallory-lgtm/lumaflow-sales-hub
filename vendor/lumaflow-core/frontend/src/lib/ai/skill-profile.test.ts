// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { loadSalesProfile } from "./skill-profile";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(skillOverrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "lumaflow-skill-test-"));
  directories.push(directory);
  await mkdir(join(directory, "skills"));
  await writeFile(join(directory, "profile.json"), JSON.stringify({ id: "test-agent", version: "1.0.0", name: "test", skills: ["test-skill"] }));
  await writeFile(join(directory, "skills", "test-skill.json"), JSON.stringify({
    id: "test-skill", version: "1.0.0", name: "测试", description: "测试", tools: ["searchProducts"], instructions: ["首次定义"], ...skillOverrides,
  }));
  return directory;
}

describe("application-owned skill profiles", () => {
  it("loads the shipped skills and installed tool allowlist", async () => {
    const profile = await loadSalesProfile();
    expect(profile.skills.map((skill) => skill.id)).toEqual(["product-advisor", "reply-drafter", "quote-drafter", "custom-handoff"]);
    expect(profile.toolNames).toHaveLength(6);
    expect(profile.instructions).toContain("Skill custom-handoff@1.0.0");
    expect(profile.instructions).toContain("没有记忆写入工具");
  });

  it("reads a reviewed file change on the next run without a rebuild", async () => {
    const directory = await fixture();
    expect((await loadSalesProfile(directory)).instructions).toContain("首次定义");
    const path = join(directory, "skills", "test-skill.json");
    const skill = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...skill, version: "1.0.1", instructions: ["新的公司流程"] }));
    const updated = await loadSalesProfile(directory);
    expect(updated.instructions).toContain("新的公司流程");
    expect(updated.instructions).toContain("test-skill@1.0.1");
    expect(updated.instructions).not.toContain("首次定义");
  });

  it("rejects an arbitrary SQL tool even if a skill file asks for it", async () => {
    const directory = await fixture({ tools: ["executeSql"] });
    await expect(loadSalesProfile(directory)).rejects.toThrow();
  });

  it("rejects skill paths that escape the application profile", async () => {
    const directory = await fixture();
    await writeFile(join(directory, "profile.json"), JSON.stringify({ id: "test-agent", version: "1.0.0", name: "test", skills: ["../../secret"] }));
    await expect(loadSalesProfile(directory)).rejects.toThrow();
  });
});
