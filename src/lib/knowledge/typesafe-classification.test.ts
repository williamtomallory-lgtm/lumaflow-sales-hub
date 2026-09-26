// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { classifyKnowledgeWithTypeSafe } = await import("./typesafe-classification");
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("TypeSafe category suggestion", () => {
  it("does not send a document when no server credential is configured", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await classifyKnowledgeWithTypeSafe({ text: "型号和规格", originalName: "产品.md" })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts a strong typed category as a suggestion that still needs review", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unit-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ answers: { category: { type: "choice", choice: "产品知识", probabilities: { "产品知识": 0.92, "无法判断": 0.08 }, confidence: 0.84 } } })));
    const result = await classifyKnowledgeWithTypeSafe({ text: "灯具选型说明", originalName: "选型.md" });
    expect(result).toMatchObject({ category: "产品知识", title: "选型.md", confidence: 0.92, tags: ["产品知识", "待人工确认"], summary: "原文节选（待核对）：灯具选型说明" });
  });

  it("leaves an uncertain answer pending", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unit-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ answers: { category: { type: "choice", choice: "FAQ", probabilities: { FAQ: 0.51, "无法判断": 0.49 }, confidence: 0.02 } } })));
    expect(await classifyKnowledgeWithTypeSafe({ text: "模糊资料", originalName: "资料.md" })).toBeNull();
  });
});
