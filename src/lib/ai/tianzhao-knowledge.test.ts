// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getTianzhaoKnowledgeMetadata, searchTianzhaoProducts } from "./tianzhao-knowledge";

describe("deployed Tianzhao product knowledge", () => {
  it("ships the complete verified product snapshot", () => {
    expect(getTianzhaoKnowledgeMetadata()).toMatchObject({
      productCount: 1887,
      imageCount: 7674,
      ocrSidecarCount: 7645,
      sourceAudit: "PASS",
      exportAudit: "PASS",
    });
  });

  it("finds an exact model and returns its evidence trail", () => {
    const result = searchTianzhaoProducts("TZ-YML-K6602", 3);
    expect(result.products[0]).toMatchObject({
      model: "TZ-YML-K6602",
      productCode: "tzdp36731",
      priceCny: 2390,
    });
    expect(result.products[0].evidenceFiles).toContain("05-TZ-YML-K6602-details-01.png");
    expect(result.archiveUrl).toContain("tianzhao-products-20260920.zip");
  });

  it("supports Chinese material and category searches without inventing missing fields", () => {
    const result = searchTianzhaoProducts("新中式 铜材", 5);
    expect(result.products.length).toBeGreaterThan(0);
    expect(result.products.every((product) => product.citation.includes("天昭灯网小程序截图/OCR"))).toBe(true);
  });
});
