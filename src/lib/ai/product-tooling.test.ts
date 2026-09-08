import { describe, expect, it } from "vitest";
import { testSnapshot } from "../../test/fixtures";
import {
  createQuoteDraftRecord,
  getInventoryRecord,
  getProductAssetRecords,
  getProductRecord,
  searchKnowledgeRecords,
  searchProductRecords,
} from "./product-tooling";

describe("grounded sales-agent tools", () => {
  it("searches the backend snapshot with structured filters", () => {
    const result = searchProductRecords({ query: "18W 黑色轨道灯", category: "轨道灯", color: "黑", powerMin: 17, powerMax: 19, stockMin: 50 }, testSnapshot);

    expect(result.products.map((product) => product.sku)).toEqual(["LT-ARC-T18-BK"]);
    expect(result.products[0]).not.toHaveProperty("cost");
    expect(result.products[0]).not.toHaveProperty("supplier");
  });

  it("reads details, inventory, and assets by exact SKU", () => {
    const details = getProductRecord("LT-ARC-T18-BK", testSnapshot);
    const inventory = getInventoryRecord("LT-ARC-T18-BK", testSnapshot);
    const assets = getProductAssetRecords("LT-ARC-T18-BK", testSnapshot);

    expect(details.found && details.product.model).toBe("ARC T18");
    expect(inventory.found && inventory.inventory.stock).toBe(126);
    expect(assets.found && assets.assets.length).toBeGreaterThan(0);
  });

  it("returns only published knowledge with explicit citations", () => {
    const published = searchKnowledgeRecords("轨道灯 光束角", undefined, testSnapshot);
    const pendingOnly = searchKnowledgeRecords("2026 产品册解析", undefined, testSnapshot);

    expect(published.entries.some((entry) => entry.id === "kb-003")).toBe(true);
    expect(published.entries.every((entry) => entry.citation.includes(entry.version))).toBe(true);
    expect(pendingOnly.entries.some((entry) => entry.id === "kb-007")).toBe(false);
  });

  it("creates only a deterministic, unpersisted quote draft", () => {
    const result = createQuoteDraftRecord({ sku: "LT-ARC-T18-BK", quantity: 20, discountPercent: 5 }, testSnapshot);

    expect(result.created).toBe(true);
    expect(result.created && result.draft.persisted).toBe(false);
    expect(result.created && result.draft.confirmationRequired).toBe(true);
    expect(result.created && result.draft.totalCny).toBeGreaterThan(0);
  });
});
