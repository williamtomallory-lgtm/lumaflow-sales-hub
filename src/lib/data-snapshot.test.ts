import { describe, expect, it } from "vitest";
import { buildDashboardSummary, validateDataSnapshot } from "./data-snapshot";
import { bootstrapResponseSchema, createProductSchema } from "./contracts/api";
import { testSnapshot } from "../test/fixtures";

describe("JSON data snapshot", () => {
  it("loads every separated seed collection", () => {
    const snapshot = structuredClone(testSnapshot);

    expect(snapshot.source).toBe("json");
    expect(snapshot.products).toHaveLength(6);
    expect(snapshot.knowledgeEntries).toHaveLength(7);
    expect(snapshot.customers).toHaveLength(4);
    expect(snapshot.followupTasks).toHaveLength(6);
    expect(snapshot.quoteHistory).toHaveLength(3);
    expect(snapshot.adminUsers).toHaveLength(4);
  });

  it("has unique identifiers, valid relations, and positive currency rates", () => {
    const snapshot = structuredClone(testSnapshot);
    expect(validateDataSnapshot(snapshot)).toEqual(snapshot);
  });

  it("rejects a follow-up task that points to a missing customer", () => {
    const snapshot = structuredClone(testSnapshot);
    const invalid = {
      ...snapshot,
      followupTasks: snapshot.followupTasks.map((task, index) => index === 0 ? { ...task, customerId: "missing-customer" } : task),
    };

    expect(() => validateDataSnapshot(invalid)).toThrow(/references missing customer/);
  });

  it("derives dashboard metrics and chart values from backend collections", () => {
    const summary = buildDashboardSummary(structuredClone(testSnapshot));

    expect(summary.activeProducts.value).toBe(testSnapshot.products.filter((product) => product.status !== "预售").length);
    expect(summary.assets.value).toBe(testSnapshot.products.flatMap((product) => product.assets).length);
    expect(summary.aiEvents.value).toBe(testSnapshot.aiLogs.length);
    expect(summary.activitySeries.reduce((total, entry) => total + entry.value, 0)).toBe(testSnapshot.aiLogs.length);
  });

  it("validates the complete API bootstrap envelope", () => {
    const data = structuredClone(testSnapshot);
    const parsed = bootstrapResponseSchema.parse({
      data,
      dashboard: buildDashboardSummary(data),
      meta: { apiVersion: "v1", requestId: "request-1234", generatedAt: new Date().toISOString(), source: data.source },
    });

    expect(parsed.data.products[0].sku).toBe(testSnapshot.products[0].sku);
  });

  it("rejects invalid product input before it reaches persistence", () => {
    const input = Object.fromEntries(Object.entries(testSnapshot.products[0]).filter(([key]) => key !== "id"));
    expect(createProductSchema.safeParse({ ...input, stock: -1 }).success).toBe(false);
  });
});
