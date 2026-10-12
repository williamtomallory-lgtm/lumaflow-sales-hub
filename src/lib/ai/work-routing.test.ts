// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { chooseWorkDomain } = await import("./work-routing");

const fileAgent = { id: "lumaflow-work", type: "local", description: "整理工作文件" };
const salesAgent = { id: "sales", type: "local", roleIds: ["sales-consultant"] };
const inventoryAgent = { id: "inventory", type: "local", roleIds: ["sales-review"] };
const productAgent = { id: "catalog", type: "local", roleIds: ["moments-operator"] };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("chooseWorkDomain", () => {
  it.each([
    ["请修复这个 TypeScript 文件中的 bug", salesAgent, "general"],
    ["把工作区里的文件按月份整理并重命名", salesAgent, "general"],
    ["帮我实现一个库存管理网页并保存到工作区", salesAgent, "general"],
    ["请分析代码里‘报价’一词出现的位置", salesAgent, "general"],
    ["帮我整理产品资料表格", salesAgent, "general"],
  ] as const)("keeps programming and file tasks in general: %s", async (text, agent, expected) => {
    await expect(chooseWorkDomain({ text, agent })).resolves.toBe(expected);
  });

  it.each([
    ["查询 18W 黑色轨道灯是否有现货", salesAgent, "sales"],
    ["帮我查这个 SKU 的库存和交期", inventoryAgent, "sales"],
    ["给 SKU A 报价", salesAgent, "sales"],
    ["请介绍一下这个产品的安装方式", productAgent, "sales"],
    ["查一下产品的参数", salesAgent, "sales"],
  ] as const)("routes explicit supported business tasks to sales: %s", async (text, agent, expected) => {
    await expect(chooseWorkDomain({ text, agent })).resolves.toBe(expected);
  });

  it.each([
    ["给 SKU A 报价", inventoryAgent],
    ["查询真实库存", fileAgent],
    ["查询 18W 黑色轨道灯", { ...salesAgent, type: "wechat" }],
    ["这个产品怎么用", undefined],
    ["帮我看看这个东西", salesAgent],
  ] as const)("keeps unsupported or uncertain work in general: %s", async (text, agent) => {
    await expect(chooseWorkDomain({ text, agent })).resolves.toBe("general");
  });

  it("does not call TypeSafe by default", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(chooseWorkDomain({ text: "帮我看看这款", agent: salesAgent })).resolves.toBe("general");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses an optional narrow Choice only with both switches and returns sales for a strong choice", async () => {
    vi.stubEnv("TYPESAFE_WORK_ROUTING", "true");
    vi.stubEnv("TYPESAFE_API_KEY", "routing-test-key");
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.state).toEqual({ task_summary: "帮我看看这款", available_work_capabilities: ["inventory", "lighting", "product", "quote"] });
      expect(JSON.stringify(body)).not.toContain("receipt");
      expect(JSON.stringify(body)).not.toContain("附件");
      return Response.json({ answers: { domain: { type: "choice", choice: "sales", probabilities: { sales: 0.94, general: 0.06 } } } });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(chooseWorkDomain({ text: "帮我看看这款", agent: salesAgent })).resolves.toBe("sales");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not upload multiline正文 or attachment-like input even when Jev is enabled", async () => {
    vi.stubEnv("TYPESAFE_WORK_ROUTING", "true");
    vi.stubEnv("TYPESAFE_API_KEY", "routing-test-key");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(chooseWorkDomain({ text: "帮我看看这款\n以下是附件正文：产品报价和客户地址", agent: salesAgent })).resolves.toBe("general");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when the optional Choice is uncertain or unavailable", async () => {
    vi.stubEnv("TYPESAFE_WORK_ROUTING", "true");
    vi.stubEnv("TYPESAFE_API_KEY", "routing-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ answers: { domain: { type: "choice", choice: "sales", probabilities: { sales: 0.4, general: 0.6 } } } })));
    await expect(chooseWorkDomain({ text: "帮我看看这款", agent: salesAgent })).resolves.toBe("general");
  });
});

