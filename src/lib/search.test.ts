import { describe, expect, it } from "vitest";
import { answerQuestion, buildSalesMessage, searchProducts } from "./search";
import { testProducts } from "../test/fixtures";

describe("catalog search", () => {
  it("matches a multi-constraint Chinese customer question", () => {
    const [result] = searchProducts("有没有 18W 黑色轨道灯，适合服装店，今天能发吗？", testProducts);
    expect(result.product.sku).toBe("LT-ARC-T18-BK");
    expect(result.matches).toEqual(expect.arrayContaining(["功率", "颜色", "适用场景", "品类", "发货时效"]));
  });

  it("finds an exact SKU", () => {
    const results = searchProducts("LT-ARC-T18-BK", testProducts);
    expect(results).toHaveLength(1);
    expect(results[0].product.id).toBe("arc-t18");
  });

  it("returns the full catalog for an empty query", () => {
    expect(searchProducts("", testProducts)).toHaveLength(testProducts.length);
  });
});

describe("sales answers", () => {
  it("grounds the response in product data", () => {
    const result = answerQuestion("18W 黑色轨道灯 服装店", testProducts);
    expect(result.answer).toContain("ARC T18");
    expect(result.answer).toContain("126 件");
    expect(result.confidence).toBeGreaterThan(80);
  });

  it("does not hallucinate when there is no match", () => {
    const result = answerQuestion("紫色水晶风扇灯", testProducts);
    expect(result.product).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("composes a send-ready message", () => {
    const message = buildSalesMessage(testProducts[0]);
    expect(message).toContain("参考报价");
    expect(message).toContain("产品图、参数表");
  });
});
