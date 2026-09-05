import businessSeed from "../data/business.json";
import catalogSeed from "../data/catalog.json";
import crmSeed from "../data/crm.json";
import type { AdminUser, AiLog, Currency, KnowledgeEntry, QualityIssue, QuoteHistoryRecord } from "../lib/business";
import type { Product } from "../lib/catalog";
import type { CrmAsset, Customer, FollowupTask } from "../lib/crm";
import type { AppDataSnapshot } from "../lib/data-snapshot";

export const testProducts = catalogSeed.products as Product[];
export const testAssets: CrmAsset[] = testProducts.flatMap((product) => product.assets.map((asset) => ({ ...asset, productId: product.id, productName: product.name })));
export const testKnowledge = businessSeed.knowledgeEntries as KnowledgeEntry[];
export const testCurrencyRates = businessSeed.demoCurrencyRates as Record<Currency, number>;
export const testCustomers = crmSeed.customers as Customer[];
export const testFollowups = crmSeed.followupTasks as FollowupTask[];

export const testSnapshot: AppDataSnapshot = {
  source: "json",
  products: testProducts,
  knowledgeEntries: testKnowledge,
  currencyRates: testCurrencyRates,
  quoteHistory: businessSeed.quoteHistory as QuoteHistoryRecord[],
  adminUsers: businessSeed.adminUsers as AdminUser[],
  aiLogs: businessSeed.aiLogs as AiLog[],
  qualityIssues: businessSeed.qualityIssues as QualityIssue[],
  customers: testCustomers,
  followupTasks: testFollowups,
};
