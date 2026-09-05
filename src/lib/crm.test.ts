import { describe, expect, it } from "vitest";
import {
  analyzeCustomerMessage,
  buildFollowupMessage,
  filterFollowupTasks,
  getLatestInboundMessage,
  isTaskOverdue,
  recommendAssetsForProducts,
  recommendProductsForMessage,
  searchCustomers,
  toggleFollowupTask,
} from "./crm";
import { testAssets, testCustomers, testFollowups, testProducts } from "../test/fixtures";

const referenceDate = "2026-09-04T14:00:00+08:00";
const crmCustomers = testCustomers;
const followupTasks = testFollowups;

describe("CRM customer message analysis", () => {
  it("identifies intent, urgency, product and supporting assets", () => {
    const result = analyzeCustomerMessage("18W 黑色轨道灯，服装店下周进场，今天能发吗？把参数表和黑色场景图一起发我。", "陈经理", testProducts, testAssets);

    expect(result.intent).toBe("资料索取");
    expect(result.intentLabel).toBe("资料 / 附件");
    expect(result.urgency).toBe("高");
    expect(result.recommendedProducts[0]?.product.id).toBe("arc-t18");
    expect(result.recommendedAssets.map((asset) => asset.id)).toEqual(expect.arrayContaining(["arc-image", "arc-spec"]));
    expect(result.replyDraft).toContain("陈经理");
    expect(result.replyDraft).toContain("ARC T18");
  });

  it("keeps an unsupported message grounded", () => {
    const result = analyzeCustomerMessage("紫色水晶风扇灯什么时候可以安装？", undefined, testProducts, testAssets);

    expect(result.recommendedProducts).toHaveLength(0);
    expect(result.recommendedAssets).toHaveLength(0);
    expect(result.intent).toBe("产品咨询");
    expect(result.replyDraft).toContain("补充一下使用场景");
  });

  it("ranks multiple products without mutating the catalog", () => {
    const recommendations = recommendProductsForMessage("办公室低眩光筒灯，30W，今天要参数表", testProducts);
    const ids = recommendations.map(({ product }) => product.id);

    expect(ids[0]).toBe("beam-s30");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("orders recommended assets by product then useful asset type", () => {
    const recommendations = recommendProductsForMessage("黑色轨道灯 18W", testProducts);
    const assets = recommendAssetsForProducts(recommendations, 4, testAssets);

    expect(assets.length).toBeGreaterThan(0);
    expect(assets[0]?.productId).toBe("arc-t18");
    expect(assets.map((asset) => asset.id)).toEqual(expect.arrayContaining(["arc-image", "arc-spec"]));
  });
});

describe("CRM customer records", () => {
  it("searches company, contact, tags and context", () => {
    expect(searchCustomers("陈经理", crmCustomers)[0]?.id).toBe("cust-nova");
    expect(searchCustomers("预算", crmCustomers)[0]?.id).toBe("cust-nova");
    expect(searchCustomers("报价中", crmCustomers)[0]?.id).toBe("cust-nova");
    expect(searchCustomers("未读", crmCustomers).map((customer) => customer.id)).toEqual(["cust-nova", "cust-northstar"]);
    expect(searchCustomers("不存在的客户", crmCustomers)).toHaveLength(0);
  });

  it("returns the latest inbound message without changing conversation order", () => {
    const customer = crmCustomers[0];
    const before = customer.conversations.map((message) => message.id);
    expect(getLatestInboundMessage(customer)?.id).toBe("nova-m4");
    expect(customer.conversations.map((message) => message.id)).toEqual(before);
  });
});

describe("CRM follow-up queue", () => {
  it("filters overdue, today, upcoming and completed tasks deterministically", () => {
    expect(filterFollowupTasks(followupTasks, "overdue", "", referenceDate).map((task) => task.id)).toEqual(["task-nova-quote"]);
    expect(filterFollowupTasks(followupTasks, "today", "", referenceDate).map((task) => task.id)).toEqual(["task-nova-reply", "task-northstar-need"]);
    expect(filterFollowupTasks(followupTasks, "upcoming", "", referenceDate).map((task) => task.id)).toEqual(["task-atelier-assets", "task-moss-stock"]);
    expect(filterFollowupTasks(followupTasks, "completed", "", referenceDate).map((task) => task.id)).toEqual(["task-atelier-call"]);
  });

  it("toggles a task immutably and preserves unrelated tasks", () => {
    const original = followupTasks.find((task) => task.id === "task-nova-reply");
    const next = toggleFollowupTask(followupTasks, "task-nova-reply", true);
    const updated = next.find((task) => task.id === "task-nova-reply");

    expect(updated?.status).toBe("completed");
    expect(updated?.dueLabel).toContain("已完成");
    expect(original?.status).toBe("open");
    expect(next.find((task) => task.id === "task-atelier-assets")).toEqual(followupTasks.find((task) => task.id === "task-atelier-assets"));
  });

  it("generates an editable, grounded follow-up script", () => {
    const task = followupTasks.find((item) => item.id === "task-nova-reply");
    if (!task) throw new Error("demo follow-up task missing");
    expect(isTaskOverdue(task, referenceDate)).toBe(false);
    const script = buildFollowupMessage(task, crmCustomers[0]);
    expect(script).toContain("陈经理");
    expect(script).toContain("确认库存、交期和匹配资料");
  });
});
