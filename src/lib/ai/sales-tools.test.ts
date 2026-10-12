// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const getDataSnapshot = vi.hoisted(() => vi.fn());
const getTianzhaoProduct = vi.hoisted(() => vi.fn());
vi.mock("../server/data-repository", () => ({ getDataSnapshot }));
vi.mock("./knowledge-retrieval", () => ({ searchConfirmedKnowledge: vi.fn(async () => []) }));
vi.mock("./basic-tools", () => ({ basicTools: { webSearch: undefined } }));
vi.mock("./tianzhao-knowledge", async () => {
  const actual = await vi.importActual<typeof import("./tianzhao-knowledge")>("./tianzhao-knowledge");
  return { ...actual, getTianzhaoProduct };
});

import { testSnapshot } from "../../test/fixtures";
import { salesTools } from "./sales-tools";

type SearchToolResult = {
  source: string;
  products: Array<{ sku: string }>;
  tianzhaoProducts?: Array<{
    model: string;
    selectedSpecification: string;
    priceScope: string;
    variantNotice: string;
  }>;
  tianzhaoTotal?: number;
  tianzhaoSnapshotDate?: string;
  tianzhaoNotice?: string;
  tianzhaoFilterNotice?: string;
};

type DetailsToolResult = {
  found: boolean;
  product: null | { model: string };
  tianzhaoFound?: boolean;
  tianzhaoProduct?: {
    model: string;
    productCode: string;
    priceCny: number | null;
    dimensions: string;
    applicableArea: string;
    lightSource: string;
    material: string;
    selectedSpecification: string;
    priceScope: string;
    variantNotice: string;
    photoTextOcr: string[];
    photoTextOcrTruncated: boolean;
    photoTextOcrNotice: string;
    evidence: string[];
  };
  tianzhaoSnapshotDate?: string;
  tianzhaoNotice?: string;
};

function rawTianzhaoProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "tianzhao:TZ-OY-507",
    name: "宋氏美学新中式智能吸顶灯系列TZ-OY-507",
    model: "TZ-OY-507",
    productCode: "tzdp35018",
    category: "宋氏美学吸顶灯",
    style: "",
    materialTag: "全光谱",
    priceCny: 1130,
    priceScope: "当前选中规格圆-D500*H95",
    unit: "支",
    selectedSpecification: "圆-D500*H95",
    specifications: ["长方-1050*650*H95", "正方-500*500*H95", "圆-D500*H95"],
    color: "胡桃木色",
    colorOptions: ["胡桃木色", "功能", "三色变光"],
    dimensions: "直径50cm",
    lightSource: "",
    material: "铁+布艺",
    applicableArea: "10-15m²",
    scene: "卧室",
    photoTextOcr: ["TZ-OY-507", "空间：10-15m²", "材质：铁+布艺"],
    availabilityStatus: "详情可用",
    reviewStatus: "已逐件打开并保留截图；OCR文字待人工复核",
    reviewNote: "",
    ocrModelNote: "",
    captureDate: "2026-09-19",
    source: "现有网易UU远程会话中的天昭灯网微信小程序",
    jsonFile: "product-TZ-OY-507.json",
    evidence: ["auto_TZ-OY-507-photo02.png", "auto_TZ-OY-507-fields-02.png"],
    extra: { internal: "must not reach model context" },
    previewImages: [{ url: "sprite" }],
    ocrImages: [{ name: "ocr", lines: ["large sidecar"] }],
    ...overrides,
  };
}

async function executeTool<T>(execute: unknown, input: unknown) {
  if (typeof execute !== "function") throw new Error("tool execute function is missing");
  return (execute as (value: unknown, options: unknown) => Promise<T>)(input, {});
}

describe("sales tool Tianzhao fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns independent Tianzhao results when the formal catalog is empty", async () => {
    getDataSnapshot.mockResolvedValue({ ...testSnapshot, source: "local", products: [] });

    const result = await executeTool<SearchToolResult>(salesTools.searchProducts.execute, {
      query: "推荐一个新中式吸顶灯给我12平方米的房间用",
      powerMin: 30,
      priceMax: 500,
      limit: 5,
    });

    expect(result?.products).toEqual([]);
    expect(result?.tianzhaoProducts?.some((product) => product.model === "TZ-OY-507")).toBe(true);
    expect(result?.tianzhaoProducts?.find((product) => product.model === "TZ-OY-507")).toMatchObject({
      selectedSpecification: "圆-D500*H95",
      priceScope: "当前选中规格圆-D500*H95",
      variantNotice: expect.stringContaining("仅属于当前截图选中的规格"),
    });
    expect(result?.tianzhaoTotal).toBeGreaterThan(0);
    expect(result?.tianzhaoSnapshotDate).toBe("2026-09-20");
    expect(result?.tianzhaoNotice).toContain("不是正式库存或实时报价");
    expect(result?.tianzhaoFilterNotice).toContain("功率下限");
    expect(result?.tianzhaoFilterNotice).toContain("最高价");
  });

  it("adds exact Tianzhao details without changing the formal found flag", async () => {
    getDataSnapshot.mockResolvedValue({ ...testSnapshot, source: "local", products: [] });
    getTianzhaoProduct.mockReturnValue(rawTianzhaoProduct());

    const result = await executeTool<DetailsToolResult>(salesTools.getProductDetails.execute, { identifier: "TZDP35018" });

    expect(result).toMatchObject({
      found: false,
      product: null,
      tianzhaoFound: true,
      tianzhaoProduct: { model: "TZ-OY-507", productCode: "tzdp35018", priceCny: 1130 },
      tianzhaoSnapshotDate: "2026-09-20",
    });
    expect(result?.tianzhaoNotice).toContain("不是正式库存或实时报价");
    expect(result?.tianzhaoProduct?.variantNotice).toContain("仅属于当前截图选中的规格");
    expect(result?.tianzhaoProduct?.priceScope).toBe("当前选中规格圆-D500*H95");
  });

  it("bounds Tianzhao details and keeps empty source fields empty", async () => {
    getDataSnapshot.mockResolvedValue({ ...testSnapshot, source: "local", products: [] });
    getTianzhaoProduct.mockReturnValue(rawTianzhaoProduct({
      priceCny: null,
      dimensions: "",
      lightSource: "",
      material: "",
      applicableArea: "",
      photoTextOcr: ["长OCR内容".repeat(1_000), "第二段不应进入工具结果"],
      extra: { secret: "large internal payload".repeat(500) },
      previewImages: Array.from({ length: 100 }, () => ({ url: "sprite" })),
      ocrImages: Array.from({ length: 100 }, () => ({ name: "ocr", lines: ["sidecar"] })),
    }));

    const result = await executeTool<DetailsToolResult>(salesTools.getProductDetails.execute, { identifier: "TZ-OY-507" });
    const product = result.tianzhaoProduct;

    expect(product).toBeDefined();
    expect(product?.priceCny).toBeNull();
    expect(product?.dimensions).toBe("");
    expect(product?.lightSource).toBe("");
    expect(product?.material).toBe("");
    expect(product?.applicableArea).toBe("");
    expect(product?.photoTextOcr.join("").length).toBeLessThanOrEqual(1_800);
    expect(product?.photoTextOcrTruncated).toBe(true);
    expect(product?.photoTextOcrNotice).toContain("1800");
    expect(product?.variantNotice).toContain("空字段表示暂无可靠资料，不得推断");
    expect(product).not.toHaveProperty("extra");
    expect(product).not.toHaveProperty("previewImages");
    expect(product).not.toHaveProperty("ocrImages");
  });

  it("preserves the formal result when the server catalog has a match", async () => {
    getDataSnapshot.mockResolvedValue(testSnapshot);

    const result = await executeTool<SearchToolResult>(salesTools.searchProducts.execute, { query: "18W 黑色轨道灯", limit: 3 });

    expect(result?.source).toBe(testSnapshot.source);
    expect(result?.products?.[0]?.sku).toBe("LT-ARC-T18-BK");
    expect(result).not.toHaveProperty("tianzhaoProducts");
  });
});
