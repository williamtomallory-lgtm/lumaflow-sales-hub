// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { routeWorkCapability } from "./work-capability-routing";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("typed capability recommendation", () => {
  it("handles an explicit schedule without a cloud call and leaves a mixed request uncertain", async () => {
    vi.stubGlobal("fetch", vi.fn()); vi.stubEnv("TYPESAFE_WORK_ROUTING", "false");
    expect(await routeWorkCapability("每天帮我整理报告")).toMatchObject({ sectionId: "schedules", confidence: 1 });
    expect(await routeWorkCapability("每天用浏览器登录网站")).toMatchObject({ confidence: 0.5 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("consumes a bounded TypeSafe choice, with no authority to configure or execute", async () => {
    vi.stubEnv("TYPESAFE_WORK_ROUTING", "true"); vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ answers: { section: { choice: "schedules", probabilities: { schedules: 0.88 } } } })));
    expect(await routeWorkCapability("每天用浏览器登录网站")).toEqual({ sectionId: "schedules", confidence: 0.88, source: "typesafe-choice" });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.state).toEqual({ request: "每天用浏览器登录网站" }); expect(body.questions.section.criteria.no_match).toBeDefined();
  });
  it("keeps secrets, paths and pasted documents out of optional cloud routing", async () => {
    vi.stubEnv("TYPESAFE_WORK_ROUTING", "true"); vi.stubEnv("TYPESAFE_API_KEY", "test-key"); vi.stubGlobal("fetch", vi.fn());
    await routeWorkCapability("每天在浏览器使用密码 secret");
    await routeWorkCapability("每天用浏览器处理 C:/private/file");
    await routeWorkCapability("每天用浏览器\n这里是私有文档");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("never consumes an invented destination or a low probability choice", async () => {
    vi.stubEnv("TYPESAFE_WORK_ROUTING", "true"); vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ answers: { section: { choice: "delete_all", probabilities: { delete_all: 1 } } } })));
    expect((await routeWorkCapability("每天用浏览器登录网站")).source).toBe("local-rules");
  });
});
