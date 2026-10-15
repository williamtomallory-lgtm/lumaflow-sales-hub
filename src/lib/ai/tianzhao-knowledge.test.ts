// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getTianzhaoKnowledgeMetadata, getTianzhaoProduct, searchTianzhaoProducts } from "./tianzhao-knowledge";

describe("deployed Tianzhao product knowledge", () => {
  it("does not replace an absent rail-light category with corridor-light bigrams", () => {
    const result = searchTianzhaoProducts("轨道灯", 5);
    expect(result.total).toBe(4);
    expect(result.products.every((item) => getTianzhaoProduct(item.id)?.photoTextOcr.join(" ").includes("轨道灯"))).toBe(true);
    expect(result.products.some((item) => item.model === "TZ-OY-507")).toBe(false);
  });
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

  it("resolves exact Tianzhao ids, models, and product codes", () => {
    expect(getTianzhaoProduct("tianzhao:TZ-OY-507")?.productCode).toBe("tzdp35018");
    expect(getTianzhaoProduct("tz-oy-507")?.model).toBe("TZ-OY-507");
    expect(getTianzhaoProduct("TZDP35018")?.model).toBe("TZ-OY-507");
  });

  it("supports Chinese material and category searches without inventing missing fields", () => {
    const result = searchTianzhaoProducts("新中式 铜材", 5);
    expect(result.products.length).toBeGreaterThan(0);
    expect(result.products.every((product) => product.citation.includes("天昭灯网小程序截图/OCR"))).toBe(true);
  });

  it("understands continuous Chinese recommendation queries and ranks an area match", () => {
    const result = searchTianzhaoProducts("推荐一个新中式吸顶灯给我12平方米的房间用", 5);
    const matchingProduct = result.products.find((product) => product.model === "TZ-OY-507");
    expect(matchingProduct).toMatchObject({
      model: "TZ-OY-507",
      productCode: "tzdp35018",
      priceCny: 1130,
    });
    expect(matchingProduct?.excerpt).toContain("10-15m²");
    expect(matchingProduct?.evidenceFiles).toContain("auto_TZ-OY-507-photo02.png");
  });

  it("keeps selected-variant facts separate from alternative specifications", () => {
    const result = searchTianzhaoProducts("TZ-AL-8803A", 3);
    const product = result.products[0];
    expect(product).toMatchObject({
      model: "TZ-AL-8803A",
      selectedSpecification: "方形-L600*W600*H120mm",
      priceScope: "当前选中规格方形-L600*W600*H120mm",
      priceCny: 995,
      lightSource: "40W*2",
      applicableArea: "20-25m2",
    });
    expect(product.variantNotice).toContain("仅属于当前截图选中的规格");
    expect(product.excerpt).toContain("当前截图选中规格：方形-L600*W600*H120mm");
    expect(product.excerpt).toContain("可选规格（仅表示可选尺寸或选项存在");
    expect(product.excerpt).toContain("价格范围说明（仅当前截图选中规格）");
    expect(product.excerpt).toContain("光源/功率（仅当前截图选中规格）");
    expect(product.excerpt).toContain("适用面积（仅当前截图选中规格）");
    expect(product.excerpt).toContain("不得把其他规格的事实移用到当前规格");
    expect(product.excerpt).not.toContain("方形-L450*W450*H120mm的价格");
    expect(product.excerpt).not.toContain("方形-L450*W450*H120mm：40W*2");
  });

  it("requires known style and category phrases together", () => {
    const result = searchTianzhaoProducts("新中式吸顶灯", 10);
    expect(result.products.length).toBeGreaterThan(0);
    expect(result.products.every((product) => `${product.title}${product.category}`.includes("新中式"))).toBe(true);
    expect(result.products.every((product) => `${product.title}${product.category}`.includes("吸顶"))).toBe(true);
  });
});
