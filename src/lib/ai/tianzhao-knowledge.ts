import "server-only";

import deployedKnowledgeBase from "../../data/tianzhao-products.json";
import imageIndex from "../../data/tianzhao-sprite-index.json";
import ocrIndex from "../../data/tianzhao-ocr-index.json";

type ProductPreview = { url: string; name: string; kind: string; top: number; height: number; width: number; totalHeight: number };
const catalogPreviewImages = imageIndex.products as Record<string, ProductPreview[]>;
const catalogOcrImages = ocrIndex.products as Record<string, Array<{ name: string; lines: string[] }>>;

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
const categoryGroups = [
  { name: "吸顶灯", terms: ["吸顶", "顶灯"] },
  { name: "吊灯", terms: ["吊灯", "餐吊", "小吊"] },
  { name: "风扇灯", terms: ["风扇", "吊扇"] },
  { name: "壁灯", terms: ["壁灯"] },
  { name: "台灯与落地灯", terms: ["台灯", "落地灯"] },
  { name: "筒灯与射灯", terms: ["筒灯", "射灯", "筒射"] },
  { name: "套餐", terms: ["套餐"] },
] as const;

function browseGroup(category: string) {
  const matches = categoryGroups.filter((group) => group.terms.some((term) => category.includes(term)));
  return matches.length === 1 ? matches[0].name : matches.length > 1 ? "混合分类" : "其他分类";
}

const catalogCategories = [...new Map(knowledgeBase.products.reduce((counts, product) => {
  const name = product.category.trim() || "未分类";
  counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}, new Map<string, number>())).entries()]
  .map(([name, count]) => ({ name, count, group: browseGroup(name) }))
  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));

const catalogGroups = [...new Map(knowledgeBase.products.reduce((counts, product) => {
  const name = browseGroup(product.category);
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
  selectedSpecification: string;
  priceScope: string;
  excerpt: string;
  priceCny: number | null;
  unit: string;
  lightSource: string;
  applicableArea: string;
  variantNotice: string;
  evidenceFiles: string[];
  citation: string;
};

export const TIANZHAO_VARIANT_NOTICE = "价格、价格范围、光源/功率、适用面积、尺寸和OCR节选仅属于当前截图选中的规格；specifications 仅表示可选尺寸或选项存在，不得把其他规格的事实移用到当前规格。空字段表示暂无可靠资料，不得推断。";

function normalize(value: string) {
  return value.toLowerCase().replace(/[\s，。？！、/\\\-_:：；;（）()]+/g, "");
}

const querySeparators = /[\s，。？！、/\\\-_:：；;（）()【】「」『』“”‘’]+/;
const queryRuns = /[\u3400-\u9fff]+|[a-z0-9]+(?:[._][a-z0-9]+)*/gi;

/**
 * The catalog is queried by natural-language model arguments. Chinese users
 * normally do not put spaces between product attributes, so the old
 * whole-sentence term made a query such as “新中式吸顶灯给我12平方米” miss
 * every record. Build a small vocabulary from the verified catalog and match
 * the longest known phrases inside each Chinese run.
 */
const searchVocabulary = new Set([
  ...categoryGroups.flatMap((group) => [group.name, ...group.terms]),
  ...knowledgeBase.products.flatMap((product) => [
    product.model,
    product.productCode,
    product.category,
    product.style,
    product.materialTag,
    product.material,
    product.color,
    product.applicableArea,
    product.scene,
    ...product.colorOptions,
    ...product.specifications,
  ]),
].flatMap((value) => value.match(queryRuns) ?? [])
  .map(normalize)
  // Long CJK runs are usually complete product names. Keep short catalog
  // attributes (for example 新中式 and 吸顶灯) so compound user queries can
  // match each attribute independently.
  .filter((value) => value.length >= 2 && (!/[\u3400-\u9fff]/.test(value) || value.length <= 4)));

const searchVocabularyByInitial = new Map<string, string[]>();
for (const value of searchVocabulary) {
  const initial = value[0];
  const values = searchVocabularyByInitial.get(initial) ?? [];
  values.push(value);
  searchVocabularyByInitial.set(initial, values);
}
for (const values of searchVocabularyByInitial.values()) values.sort((left, right) => right.length - left.length || left.localeCompare(right));

function terms(query: string) {
  const output = new Set<string>();
  const runs = query.toLowerCase().split(querySeparators).flatMap((value) => value.match(queryRuns) ?? []).map(normalize);
  for (const run of runs) {
    if (run.length < 2) continue;
    if (!/[\u3400-\u9fff]/.test(run)) {
      output.add(run);
      continue;
    }

    let cursor = 0;
    let matched = false;
    while (cursor < run.length) {
      const candidate = (searchVocabularyByInitial.get(run[cursor]) ?? []).find((value) => run.startsWith(value, cursor));
      if (candidate) {
        output.add(candidate);
        cursor += candidate.length;
        matched = true;
      } else {
        cursor += 1;
      }
    }
    // Keep arbitrary Chinese queries useful even when their wording is not in
    // the catalog vocabulary. Bigrams are only the fallback, avoiding a noisy
    // score when known product phrases were already extracted.
    if (!matched && run.length > 2) {
      for (let index = 0; index < run.length - 1; index += 1) output.add(run.slice(index, index + 2));
    } else if (!matched) {
      output.add(run);
    }
  }
  return [...output].filter((value) => value.length >= 2);
}

function searchableText(product: TianzhaoProduct) {
  return normalize(JSON.stringify(product));
}

function requestedArea(query: string) {
  const match = /(\d+(?:\.\d+)?)\s*(?:平方米|平米|平方|m2|m²|㎡)/i.exec(query.toLowerCase());
  return match ? Number(match[1]) : null;
}

function areaScore(product: TianzhaoProduct, area: number | null) {
  if (area === null) return 0;
  const source = [product.applicableArea, ...product.photoTextOcr].join(" ");
  const ranges = /(\d+(?:\.\d+)?)\s*(?:[-~至到]\s*(\d+(?:\.\d+)?))?\s*(?:平方米|平米|平方|m2|m²|㎡)/gi;
  for (const match of source.matchAll(ranges)) {
    const lower = Number(match[1]);
    const upper = match[2] ? Number(match[2]) : lower;
    if (Number.isFinite(lower) && Number.isFinite(upper) && area >= lower && area <= upper) return 24;
  }
  return 0;
}

function productScore(product: TianzhaoProduct, query: string) {
  const normalizedQuery = normalize(query);
  const model = normalize(product.model);
  const code = normalize(product.productCode);
  if (normalizedQuery && (normalizedQuery === model || normalizedQuery === code)) return 10_000;
  const text = searchableText(product);
  const queryTerms = terms(query);
  // A bare area number is handled by areaScore below. Counting it as a
  // substring would make an unrelated model or dimension containing "12"
  // outrank a product whose published area range actually contains 12 m².
  const textualTerms = queryTerms.filter((term) => !/^\d+(?:\.\d+)?$/.test(term) && !/^(?:平方米|平米|平方|m2|m²|㎡)$/.test(term));
  // Attribute queries such as “新中式吸顶灯” contain multiple known catalog
  // phrases. Require every such phrase so a product matching only “吸顶灯”
  // does not flood the result set for a style-specific request. Unknown
  // wording remains score-based for recall.
  const requiredTerms = textualTerms.filter((term) => searchVocabulary.has(term));
  if (requiredTerms.length >= 2 && requiredTerms.some((term) => !text.includes(term))) return 0;
  let score = textualTerms.reduce((total, term) => total + (text.includes(term) ? 4 : 0), 0);
  if (normalizedQuery && text.includes(normalizedQuery)) score += 20;
  if (textualTerms.some((term) => model.includes(term) || code.includes(term))) score += 12;
  score += areaScore(product, requestedArea(query));
  return score;
}

function displayValue(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text || "暂无可靠资料";
}

function toResult(product: TianzhaoProduct): TianzhaoSearchResult {
  const alternatives = product.specifications.length
    ? `可选规格（仅表示可选尺寸或选项存在，不携带其他规格的价格、光源、功率或面积事实）：${product.specifications.join("、")}`
    : "可选规格：暂无可靠资料";
  const price = product.priceCny === null
    ? "暂无可靠资料"
    : `¥${product.priceCny}${product.unit ? `/${product.unit}` : ""}`;
  const ocr = product.photoTextOcr.length ? product.photoTextOcr.join("；") : "暂无可靠资料";
  const details = [
    `规格边界：${TIANZHAO_VARIANT_NOTICE}`,
    `产品：${displayValue(product.name || product.model)}`,
    `型号：${displayValue(product.model)}`,
    `商品编码：${displayValue(product.productCode)}`,
    `分类：${displayValue(product.category)}`,
    `风格：${displayValue(product.style)}`,
    `材质：${displayValue(product.material)}`,
    `材质标签：${displayValue(product.materialTag)}`,
    `颜色：${displayValue(product.color)}`,
    `当前截图选中规格：${displayValue(product.selectedSpecification)}`,
    `价格范围说明（仅当前截图选中规格）：${displayValue(product.priceScope)}`,
    `截图展示价（仅当前截图选中规格）：${price}`,
    `尺寸（仅当前截图选中规格）：${displayValue(product.dimensions)}`,
    `光源/功率（仅当前截图选中规格）：${displayValue(product.lightSource)}`,
    `适用面积（仅当前截图选中规格）：${displayValue(product.applicableArea)}`,
    `场景：${displayValue(product.scene)}`,
    alternatives,
    `OCR节选（仅作当前截图选中规格旁证，可能有误）：${ocr}`,
    `资料状态：${displayValue(product.availabilityStatus)}`,
    `复核备注：${displayValue(product.reviewNote || product.ocrModelNote)}`,
  ].join("；");
  return {
    id: product.id,
    title: product.name || product.model,
    model: product.model,
    productCode: product.productCode,
    category: product.category,
    selectedSpecification: product.selectedSpecification,
    priceScope: product.priceScope,
    excerpt: details.slice(0, 2_400),
    priceCny: product.priceCny,
    unit: product.unit,
    lightSource: product.lightSource,
    applicableArea: product.applicableArea,
    variantNotice: TIANZHAO_VARIANT_NOTICE,
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

export function getTianzhaoProduct(identifier: string) {
  const normalizedIdentifier = identifier.trim().toLowerCase();
  const product = knowledgeBase.products.find((entry) => [entry.id, entry.model, entry.productCode]
    .some((value) => value.trim().toLowerCase() === normalizedIdentifier));
  return product ? { ...product, previewImages: catalogPreviewImages[product.id] ?? [], ocrImages: catalogOcrImages[product.id] ?? [] } : null;
}

export type TianzhaoCatalogProduct = Pick<TianzhaoProduct,
  "id" | "name" | "model" | "productCode" | "category" | "style" | "materialTag" |
  "priceCny" | "priceScope" | "unit" | "selectedSpecification" | "specifications" |
  "color" | "colorOptions" | "dimensions" | "lightSource" | "material" |
  "applicableArea" | "scene" | "availabilityStatus" | "reviewStatus" | "reviewNote" |
  "photoTextOcr" | "evidence" | "jsonFile"
> & { previewImages: ProductPreview[] };

/** Public, paginated view of the verified snapshot with compressed screenshot previews. */
export function listTianzhaoProducts(input: { query?: string; category?: string; group?: string; offset?: number; limit?: number } = {}) {
  const query = input.query?.trim() ?? "";
  const category = input.category?.trim() ?? "";
  const group = input.group?.trim() ?? "";
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 24)));
  const filtered = knowledgeBase.products.filter((product) =>
    (!category || product.category === category) &&
    (!group || browseGroup(product.category) === group) &&
    (!query || productScore(product, query) > 0));
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
    photoTextOcr: product.photoTextOcr,
    evidence: product.evidence,
    jsonFile: product.jsonFile,
    previewImages: catalogPreviewImages[product.id] ?? [],
  }));
  return {
    products,
    total: filtered.length,
    offset,
    limit,
    metadata: {
      ...knowledgeBase.metadata,
      categories: catalogCategories,
      groups: catalogGroups,
      spreadsheetUrl: `${knowledgeBase.metadata.releaseUrl.replace(/\/tag\/[^/]+$/, "")}/download/tianzhao-20260920/tianzhao-products-1887-20260920.xlsx`,
    },
  };
}
