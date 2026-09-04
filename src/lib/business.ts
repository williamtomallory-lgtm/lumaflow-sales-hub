import businessSeed from "../data/business.json";
import { products, type Product } from "./catalog";

export type KnowledgeCategory = "FAQ" | "销售话术" | "产品知识" | "公司知识" | "政策" | "案例" | "文档解析";

export type KnowledgeEntry = {
  id: string;
  category: KnowledgeCategory;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  owner: string;
  version: string;
  updatedAt: string;
  status: "已发布" | "待审核";
  reads: number;
};

export type Currency = "CNY" | "USD" | "CAD";

export type QuoteLine = {
  id: string;
  productId: string;
  quantity: number;
  discount: number;
};

export type QuoteTotals = {
  subtotal: number;
  tierSavings: number;
  discountSavings: number;
  totalCny: number;
  total: number;
  currency: Currency;
};

export type QuoteHistoryRecord = {
  id: string;
  customer: string;
  total: string;
  status: string;
  version: string;
  updatedAt: string;
};

export type AdminUser = {
  id: string;
  name: string;
  initials: string;
  role: string;
  department: string;
  status: "活跃" | "已停用";
  lastActive: string;
};

export type AiLog = {
  id: string;
  user: string;
  action: string;
  input: string;
  result: string;
  status: string;
  time: string;
};

export type QualityIssue = {
  id: string;
  severity: "高" | "中" | "低";
  field: string;
  subject: string;
  detail: string;
  owner: string;
};

export const knowledgeEntries = businessSeed.knowledgeEntries as KnowledgeEntry[];
export const demoCurrencyRates = businessSeed.demoCurrencyRates as Record<Currency, number>;
export const quoteHistory = businessSeed.quoteHistory as QuoteHistoryRecord[];
export const adminUsers = businessSeed.adminUsers as AdminUser[];
export const aiLogs = businessSeed.aiLogs as AiLog[];
export const qualityIssues = businessSeed.qualityIssues as QualityIssue[];

export function filterKnowledge(query: string, category: "全部" | KnowledgeCategory, source = knowledgeEntries) {
  const normalized = query.trim().toLowerCase();
  return source.filter((entry) => {
    const categoryMatch = category === "全部" || entry.category === category;
    if (!normalized) return categoryMatch;
    return categoryMatch && `${entry.title}${entry.summary}${entry.content}${entry.tags.join("")}`.toLowerCase().includes(normalized);
  });
}

export function productListPrice(product: Product) {
  const numbers = product.priceRange.match(/\d+/g)?.map(Number) ?? [];
  return numbers.length ? Math.max(...numbers) : product.cost * 1.8;
}

export function quantityFactor(quantity: number) {
  if (quantity >= 100) return 0.82;
  if (quantity >= 50) return 0.88;
  if (quantity >= 20) return 0.93;
  if (quantity >= 10) return 0.97;
  return 1;
}

export function calculateQuote(lines: QuoteLine[], currency: Currency, catalog = products, currencyRates = demoCurrencyRates): QuoteTotals {
  let subtotal = 0;
  let afterTier = 0;
  let afterDiscount = 0;

  for (const line of lines) {
    const product = catalog.find((item) => item.id === line.productId);
    if (!product) continue;
    const lineSubtotal = productListPrice(product) * Math.max(0, line.quantity);
    const tiered = lineSubtotal * quantityFactor(line.quantity);
    const discounted = tiered * (1 - Math.min(100, Math.max(0, line.discount)) / 100);
    subtotal += lineSubtotal;
    afterTier += tiered;
    afterDiscount += discounted;
  }

  return {
    subtotal,
    tierSavings: subtotal - afterTier,
    discountSavings: afterTier - afterDiscount,
    totalCny: afterDiscount,
    total: afterDiscount * currencyRates[currency],
    currency,
  };
}

export function quoteRequiresApproval(lines: QuoteLine[]) {
  return lines.some((line) => line.discount > 15);
}
