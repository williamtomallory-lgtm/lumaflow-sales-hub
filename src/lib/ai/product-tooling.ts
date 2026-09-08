import { calculateQuote, productListPrice, quoteRequiresApproval } from "../business";
import type { Product } from "../catalog";
import type { AppDataSnapshot } from "../data-snapshot";
import { normalizeProductSearchValue, searchProducts } from "../search";

export type ProductSearchInput = {
  query?: string;
  category?: string;
  color?: string;
  cct?: number;
  powerMin?: number;
  powerMax?: number;
  priceMax?: number;
  stockMin?: number;
  status?: Product["status"];
  limit?: number;
};

export type SafeProductRecord = Omit<Product, "cost" | "supplier" | "gradient" | "accent" | "assets"> & {
  assetCount: number;
};

function numericPower(product: Product) {
  return Number(product.power.match(/[\d.]+/)?.[0] ?? Number.NaN);
}

function safeProduct(product: Product): SafeProductRecord {
  return {
    id: product.id,
    name: product.name,
    model: product.model,
    sku: product.sku,
    category: product.category,
    family: product.family,
    status: product.status,
    power: product.power,
    lumens: product.lumens,
    colorTemp: product.colorTemp,
    material: product.material,
    dimensions: product.dimensions,
    colors: product.colors,
    scenarios: product.scenarios,
    priceRange: product.priceRange,
    moq: product.moq,
    stock: product.stock,
    leadTime: product.leadTime,
    warranty: product.warranty,
    description: product.description,
    assetCount: product.assets.length,
  };
}

function contains(value: string, expected?: string) {
  return !expected || value.toLowerCase().includes(expected.trim().toLowerCase());
}

function matchesColor(value: string, expected: string) {
  // Natural-language model filters use basic colors, while catalog entries use shade names.
  // Only widen generic color names; an explicit shade remains an exact substring filter.
  const genericColor = expected.trim();
  return contains(value, expected) || (["黑色", "白色", "金色", "绿色"].includes(genericColor)
    && normalizeProductSearchValue(value).includes(genericColor));
}

export function searchProductRecords(input: ProductSearchInput, snapshot: AppDataSnapshot) {
  const unavailableFilters: string[] = [];
  const query = input.query?.trim() ?? "";
  const ranked = searchProducts(query, snapshot.products);
  const filtered = ranked.filter(({ product }) => {
    const power = numericPower(product);
    const listPrice = productListPrice(product);
    return contains(product.category, input.category)
      && (!input.color || product.colors.some((color) => matchesColor(color, input.color!)))
      && (!input.cct || product.colorTemp.includes(String(input.cct)))
      && (input.powerMin === undefined || power >= input.powerMin)
      && (input.powerMax === undefined || power <= input.powerMax)
      && (input.priceMax === undefined || listPrice <= input.priceMax)
      && (input.stockMin === undefined || product.stock >= input.stockMin)
      && (!input.status || product.status === input.status);
  });

  return {
    source: snapshot.source,
    total: filtered.length,
    unavailableFilters,
    products: filtered.slice(0, input.limit ?? 5).map(({ product, score, matches }) => ({
      ...safeProduct(product),
      matchScore: score,
      matchedFields: matches,
    })),
  };
}

export function getProductRecord(identifier: string, snapshot: AppDataSnapshot) {
  const normalized = identifier.trim().toLowerCase();
  const product = snapshot.products.find((item) => [item.id, item.sku, item.model].some((value) => value.toLowerCase() === normalized));
  return product ? { found: true as const, source: snapshot.source, product: safeProduct(product) } : { found: false as const, source: snapshot.source, product: null };
}

export function getInventoryRecord(identifier: string, snapshot: AppDataSnapshot) {
  const result = getProductRecord(identifier, snapshot);
  if (!result.found) return { found: false as const, source: snapshot.source, inventory: null };
  return {
    found: true as const,
    source: snapshot.source,
    inventory: {
      id: result.product.id,
      sku: result.product.sku,
      model: result.product.model,
      status: result.product.status,
      stock: result.product.stock,
      leadTime: result.product.leadTime,
      checkedAt: new Date().toISOString(),
    },
  };
}

export function getProductAssetRecords(identifier: string, snapshot: AppDataSnapshot) {
  const normalized = identifier.trim().toLowerCase();
  const product = snapshot.products.find((item) => [item.id, item.sku, item.model].some((value) => value.toLowerCase() === normalized));
  return product
    ? { found: true as const, source: snapshot.source, product: { id: product.id, sku: product.sku, name: product.name }, assets: product.assets }
    : { found: false as const, source: snapshot.source, product: null, assets: [] };
}

function queryTerms(query: string) {
  return [...new Set(query.toLowerCase().split(/[\s，。？！、/\\\-_:：；;（）()]+/).filter((term) => term.length >= 2))];
}

export function searchKnowledgeRecords(query: string, sku: string | undefined, snapshot: AppDataSnapshot) {
  const terms = queryTerms(`${query} ${sku ?? ""}`);
  const entries = snapshot.knowledgeEntries
    .filter((entry) => entry.status === "已发布")
    .map((entry) => {
      const haystack = `${entry.title} ${entry.summary} ${entry.content} ${entry.tags.join(" ")}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.entry.reads - a.entry.reads)
    .slice(0, 5)
    .map(({ entry, score }) => ({
      id: entry.id,
      title: entry.title,
      category: entry.category,
      excerpt: entry.content.slice(0, 1_200),
      version: entry.version,
      updatedAt: entry.updatedAt,
      score,
      citation: `${entry.title} · ${entry.version}`,
    }));
  return { source: snapshot.source, retrieval: "keyword-v1" as const, total: entries.length, entries };
}

export function createQuoteDraftRecord(input: { sku: string; quantity: number; discountPercent: number; customerId?: string }, snapshot: AppDataSnapshot) {
  const product = snapshot.products.find((item) => item.sku.toLowerCase() === input.sku.trim().toLowerCase());
  if (!product) return { created: false as const, reason: "PRODUCT_NOT_FOUND", draft: null };
  const line = { id: "agent-draft-line", productId: product.id, quantity: input.quantity, discount: input.discountPercent };
  const totals = calculateQuote([line], "CNY", snapshot.products, snapshot.currencyRates);
  return {
    created: true as const,
    reason: null,
    draft: {
      id: `draft-${crypto.randomUUID()}`,
      status: "草稿" as const,
      customerId: input.customerId ?? null,
      product: { id: product.id, sku: product.sku, name: product.name, unitListPrice: productListPrice(product) },
      quantity: input.quantity,
      discountPercent: input.discountPercent,
      totalCny: totals.totalCny,
      requiresManagerApproval: quoteRequiresApproval([line]),
      confirmationRequired: true as const,
      persisted: false as const,
      notice: "这是未持久化的报价草稿；销售确认并通过权限校验后才能生成正式报价。",
    },
  };
}
