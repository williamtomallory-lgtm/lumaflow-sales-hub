import "server-only";

import deployedKnowledgeBase from "../../data/tianzhao-products.json";

type TianzhaoProduct = {
  id: string;
  name: string;
  model: string;
  productCode: string;
  category: string;
  style: string;
  materialTag: string;
  priceCny: number | null;
  priceScope: string;
  unit: string;
  selectedSpecification: string;
  specifications: string[];
  color: string;
  colorOptions: string[];
  dimensions: string;
  lightSource: string;
  material: string;
  applicableArea: string;
  scene: string;
  photoTextOcr: string[];
  availabilityStatus: string;
  reviewStatus: string;
  reviewNote: string;
  ocrModelNote: string;
  captureDate: string;
  source: string;
  jsonFile: string;
  evidence: string[];
  extra: Record<string, unknown>;
};

type TianzhaoKnowledgeBase = {
  metadata: {
    store: string;
    snapshotDate: string;
    productCount: number;
    imageCount: number;
    ocrSidecarCount: number;
    sourceAudit: string;
    exportAudit: string;
    imageNotice: string;
    dataNotice: string;
    releaseUrl: string;
    archiveUrl: string;
  };
  products: TianzhaoProduct[];
};

const knowledgeBase = deployedKnowledgeBase as TianzhaoKnowledgeBase;
const catalogCategories = [...new Map(knowledgeBase.products.reduce((counts, product) => {
  const name = product.category.trim() || "未分类";
  counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}, new Map<string, number>())).entries()]
  .map(([name, count]) => ({ name, count }))
  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));

export type TianzhaoSearchResult = {
  id: string;
  title: string;
  model: string;
  productCode: string;
  category: string;
  excerpt: string;
  priceCny: number | null;
  unit: string;
  evidenceFiles: string[];
  citation: string;
};

function normalize(value: string) {
  return value.toLowerCase().replace(/[\s，。？！、/\\\-_:：；;（）()]+/g, "");
}

function terms(query: string) {
  return [...new Set(query.split(/[\s，。？！、/\\_:：；;（）()]+/).map(normalize).filter((value) => value.length >= 2))];
}

function searchableText(product: TianzhaoProduct) {
  return normalize(JSON.stringify(product));
}

function productScore(product: TianzhaoProduct, query: string) {
  const normalizedQuery = normalize(query);
  const model = normalize(product.model);
  const code = normalize(product.productCode);
  if (normalizedQuery && (normalizedQuery === model || normalizedQuery === code)) return 10_000;
  const text = searchableText(product);
  const queryTerms = terms(query);
  let score = queryTerms.reduce((total, term) => total + (text.includes(term) ? 4 : 0), 0);
  if (normalizedQuery && text.includes(normalizedQuery)) score += 20;
  if (queryTerms.some((term) => model.includes(term) || code.includes(term))) score += 12;
  return score;
}

function compactValues(values: Array<string | number | null | undefined>) {
  return values.filter((value) => value !== null && value !== undefined && String(value).trim()).join("；");
}

function toResult(product: TianzhaoProduct): TianzhaoSearchResult {
  const details = compactValues([
    product.name,
    `型号 ${product.model}`,
    product.productCode ? `商品编码 ${product.productCode}` : "商品编码未可靠识别",
    product.category,
    product.style,
    product.material,
    product.color,
    product.selectedSpecification,
    product.specifications.join("、"),
    product.dimensions,
    product.lightSource,
    product.applicableArea,
    product.scene,
    product.priceCny === null ? "" : `截图展示价 ¥${product.priceCny}${product.unit ? `/${product.unit}` : ""}`,
    product.availabilityStatus,
    product.reviewNote,
    product.ocrModelNote,
    product.photoTextOcr.join("；"),
  ]);
  return {
    id: product.id,
    title: product.name || product.model,
    model: product.model,
    productCode: product.productCode,
    category: product.category,
    excerpt: details.slice(0, 2_400),
    priceCny: product.priceCny,
    unit: product.unit,
    evidenceFiles: product.evidence,
    citation: `${product.jsonFile} · 天昭灯网小程序截图/OCR · ${product.captureDate || knowledgeBase.metadata.snapshotDate}`,
  };
}

export function searchTianzhaoProducts(query: string, limit = 5) {
  const clean = query.trim();
  if (!clean) return { total: 0, products: [] as TianzhaoSearchResult[] };
  const ranked = knowledgeBase.products
    .map((product) => ({ product, score: productScore(product, clean) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.product.model.localeCompare(right.product.model, "zh-CN"));
  return {
    source: "tianzhao-deployed-knowledge-base" as const,
    total: ranked.length,
    snapshotDate: knowledgeBase.metadata.snapshotDate,
    archiveUrl: knowledgeBase.metadata.archiveUrl,
    notice: `${knowledgeBase.metadata.imageNotice}${knowledgeBase.metadata.dataNotice}`,
    products: ranked.slice(0, Math.max(1, Math.min(limit, 10))).map(({ product }) => toResult(product)),
  };
}

export function getTianzhaoKnowledgeMetadata() {
  return knowledgeBase.metadata;
}

export type TianzhaoCatalogProduct = Pick<TianzhaoProduct,
  "id" | "name" | "model" | "productCode" | "category" | "style" | "materialTag" |
  "priceCny" | "priceScope" | "unit" | "selectedSpecification" | "specifications" |
  "color" | "colorOptions" | "dimensions" | "lightSource" | "material" |
  "applicableArea" | "scene" | "availabilityStatus" | "reviewStatus" | "reviewNote"
>;

/** Public, paginated view of the verified snapshot. Image evidence remains in the release archive. */
export function listTianzhaoProducts(input: { query?: string; category?: string; offset?: number; limit?: number } = {}) {
  const query = input.query?.trim() ?? "";
  const category = input.category?.trim() ?? "";
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 24)));
  const filtered = knowledgeBase.products.filter((product) =>
    (!category || product.category === category) && (!query || productScore(product, query) > 0));
  const products: TianzhaoCatalogProduct[] = filtered.slice(offset, offset + limit).map((product) => ({
    id: product.id,
    name: product.name,
    model: product.model,
    productCode: product.productCode,
    category: product.category,
    style: product.style,
    materialTag: product.materialTag,
    priceCny: product.priceCny,
    priceScope: product.priceScope,
    unit: product.unit,
    selectedSpecification: product.selectedSpecification,
    specifications: product.specifications,
    color: product.color,
    colorOptions: product.colorOptions,
    dimensions: product.dimensions,
    lightSource: product.lightSource,
    material: product.material,
    applicableArea: product.applicableArea,
    scene: product.scene,
    availabilityStatus: product.availabilityStatus,
    reviewStatus: product.reviewStatus,
    reviewNote: product.reviewNote,
  }));
  return {
    products,
    total: filtered.length,
    offset,
    limit,
    metadata: {
      ...knowledgeBase.metadata,
      categories: catalogCategories,
      spreadsheetUrl: `${knowledgeBase.metadata.releaseUrl.replace(/\/tag\/[^/]+$/, "")}/download/tianzhao-20260920/tianzhao-products-1887-20260920.xlsx`,
    },
  };
}
