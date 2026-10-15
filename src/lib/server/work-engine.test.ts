// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
vi.mock("server-only", () => ({}));
vi.mock("../ai/model-config", () => ({ getModelOptions: vi.fn(async () => []), getModelConfig: vi.fn() }));
import { authorizeWorkEngineBrowser, authorizeWorkEngineGateway, createWorkEngineToken, readWorkEngineConfig, getWorkEngineStatus } from "./work-engine";
let directory: string;
const config = { version: "1.0.2b7", baseUrl: "http://127.0.0.1:8088", ownerId: 7, ownerUsername: "owner", jwtSecret: "j".repeat(64), jwtSecretEncoding: "utf8" as const, gatewayKey: "g".repeat(64), agentIds: { work: "w", researcher: "r", verifier: "v", team: "t" } };
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "lumaflow-engine-test-"));
  vi.stubEnv("LUMAFLOW_WORK_ENGINE_TEST_FILE", path.join(directory, "config.json"));
  vi.stubEnv("VERCEL", "");
  await writeFile(path.join(directory, "config.json"), JSON.stringify(config));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
describe("local Work engine boundary", () => {
  it("never hands off a local owner session from a public deployment or cross-origin page", () => {
    expect(() => authorizeWorkEngineBrowser(new Request("https://example.com/api/v1/work-engine", { headers: { origin: "https://example.com" } }))).toThrow();
    expect(() => authorizeWorkEngineBrowser(new Request("http://127.0.0.1:3000/api/v1/work-engine", { headers: { origin: "https://example.com" } }))).toThrow();
    expect(() => authorizeWorkEngineBrowser(new Request("http://127.0.0.1:3000/api/v1/work-engine/session", { method: "POST", headers: { origin: "http://127.0.0.1:3000" } }), true)).not.toThrow();
  });
  it("requires the private gateway credential even on localhost", async () => {
    await expect(authorizeWorkEngineGateway(new Request("http://localhost:3000/api/v1/work-engine/models"))).rejects.toMatchObject({ status: 401 });
    await expect(authorizeWorkEngineGateway(new Request("http://localhost:3000/api/v1/work-engine/models", { headers: { authorization: `Bearer ${config.gatewayKey}` } }))).resolves.toMatchObject({ ownerId: 7 });
  });
  it("rejects configuration that points the engine to a remote host", async () => {
    await writeFile(path.join(directory, "config.json"), JSON.stringify({ ...config, baseUrl: "https://evil.example" }));
    await expect(readWorkEngineConfig()).rejects.toMatchObject({ code: "WORK_ENGINE_CONFIG_INVALID" });
  });
  it("issues a bounded signed session and reports offline honestly without exposing saved secrets", async () => {
    const { token } = createWorkEngineToken(config, 600);
    const [header, payload, signature] = token.split(".");
    expect(signature).toBe(createHmac("sha256", config.jwtSecret).update(`${header}.${payload}`).digest("base64url"));
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.sub).toBe("7"); expect(claims.exp - claims.iat).toBe(600);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const status = await getWorkEngineStatus();
    expect(status.connected).toBe(false); expect(status.sections.every((section) => section.availability === "offline")).toBe(true);
    expect(JSON.stringify(status)).not.toContain(config.gatewayKey); expect(JSON.stringify(status)).not.toContain(config.jwtSecret);
  });
  it("signs the original Octop binary secret rather than its base64 representation", () => {
    const original = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const { token } = createWorkEngineToken({ ...config, jwtSecret: original.toString("base64url"), jwtSecretEncoding: "base64" });
    const [header, payload, signature] = token.split(".");
    expect(signature).toBe(createHmac("sha256", original).update(`${header}.${payload}`).digest("base64url"));
    expect(JSON.parse(Buffer.from(payload, "base64url").toString()).uname).toBe("owner");
  });
});
