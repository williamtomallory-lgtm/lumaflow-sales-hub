import { describe, expect, it } from "vitest";
import { calculateQuote, filterKnowledge, quantityFactor, quoteRequiresApproval } from "./business";

describe("knowledge base", () => {
  it("filters by category and semantic content", () => {
    const result = filterKnowledge("光束角", "产品知识");
    expect(result).toHaveLength(1);
    expect(result[0].title).toContain("24°");
  });

  it("keeps category filtering with an empty query", () => {
    expect(filterKnowledge("", "政策").every((entry) => entry.category === "政策")).toBe(true);
  });
});

describe("quotation calculations", () => {
  it("applies the configured quantity tier", () => {
    expect(quantityFactor(9)).toBe(1);
    expect(quantityFactor(20)).toBe(0.93);
    expect(quantityFactor(100)).toBe(0.82);
  });

  it("calculates tier and manual discounts deterministically", () => {
    const totals = calculateQuote([{ id: "l1", productId: "arc-t18", quantity: 20, discount: 10 }], "CNY");
    expect(totals.subtotal).toBe(5780);
    expect(totals.tierSavings).toBeCloseTo(404.6);
    expect(totals.total).toBeCloseTo(4837.86);
  });

  it("converts totals with explicit demo rates", () => {
    const cny = calculateQuote([{ id: "l1", productId: "arc-t18", quantity: 10, discount: 0 }], "CNY");
    const cad = calculateQuote([{ id: "l1", productId: "arc-t18", quantity: 10, discount: 0 }], "CAD");
    expect(cad.total).toBeCloseTo(cny.total * 0.19);
  });

  it("requires approval above the discount threshold", () => {
    expect(quoteRequiresApproval([{ id: "l1", productId: "arc-t18", quantity: 10, discount: 16 }])).toBe(true);
    expect(quoteRequiresApproval([{ id: "l1", productId: "arc-t18", quantity: 10, discount: 15 }])).toBe(false);
  });
});
