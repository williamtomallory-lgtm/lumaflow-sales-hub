// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getLocalModelProfiles } from "./local-model-registry";
import { getDefaultModelProfileId, getModelConfig, getModelHealth, getModelOptions } from "./model-config";

vi.mock("server-only", () => ({}));
let folder: string;
const profile = { id: "local:strata-coder", label: "Qwen3.8 Flash Next Coder", model: "qwen3.8-flash-next-coder-iq1_m",
  baseURL: "http://127.0.0.1:8080/v1", backend: "strata", runtime: "strata", installationStatus: "ready" };
function save(entries: unknown[]) { writeFileSync(path.join(folder, "models.json"), JSON.stringify(entries)); }
beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), "lumaflow-model-registry-"));
  vi.stubEnv("LUMAFLOW_LOCAL_MODELS_FILE", path.join(folder, "models.json"));
  vi.stubEnv("VERCEL", undefined);
  vi.stubEnv("LLM_VISIBLE_PROFILES", "configured,local:strata-coder");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(folder, { recursive: true, force: true }); });

it("fails closed for remote URLs, unknown options and duplicate IDs", () => {
  for (const bad of [{ ...profile, baseURL: "http://example.com/v1" }, { ...profile, baseURL: "http://user:secret@127.0.0.1:8080/v1" },
    { ...profile, command: "powershell" }, { ...profile, model: "wrong-model" }]) {
    save([bad]); expect(() => getLocalModelProfiles()).toThrow();
  }
  save([profile, profile]); expect(() => getLocalModelProfiles()).toThrow(/unique/);
});

it("requires a registered ID and never sends registry credentials in the menu", async () => {
  save([{ ...profile, apiKeyEnv: "TEST_LOCAL_MODEL_KEY" }]);
  vi.stubEnv("TEST_LOCAL_MODEL_KEY", "private-model-token");
  vi.stubEnv("LLM_VISIBLE_PROFILES", profile.id);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.endsWith("/health")
    ? { service: "strata", loaded: true, model: profile.model } : { data: [{ id: profile.model }] })));
  expect(getModelConfig(profile.id).apiKey).toBe("private-model-token");
  expect(() => getModelConfig("local:unknown")).toThrow(/not registered/);
  const options = await getModelOptions();
  expect(options).toMatchObject([{ id: profile.id, reachable: true }]);
  expect(JSON.stringify(options)).not.toContain("private-model-token");
});

it("does not call an unloaded Strata server ready just because it lists a model", async () => {
  save([profile]);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.endsWith("/health")
    ? { service: "strata", loaded: false, model: profile.model } : { data: [{ id: profile.model }] })));
  expect(await getModelHealth(profile.id)).toMatchObject({ reachable: false });
});

it("ignores an unknown default and hides the local file on hosted deployments", () => {
  save([profile]);
  vi.stubEnv("LLM_DEFAULT_PROFILE", "local:missing");
  expect(getDefaultModelProfileId()).toBe("configured");
  vi.stubEnv("VERCEL", "1");
  expect(getLocalModelProfiles()).toEqual([]);
});
