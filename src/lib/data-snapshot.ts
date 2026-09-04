import { adminUsers, aiLogs, demoCurrencyRates, knowledgeEntries, qualityIssues, quoteHistory, type AdminUser, type AiLog, type Currency, type KnowledgeEntry, type QualityIssue, type QuoteHistoryRecord } from "./business";
import { products, type Product } from "./catalog";
import { crmCustomers, followupTasks, type Customer, type FollowupTask } from "./crm";

export type DataSourceKind = "json" | "postgres" | "json-fallback";

export type AppDataSnapshot = {
  source: DataSourceKind;
  products: Product[];
  knowledgeEntries: KnowledgeEntry[];
  currencyRates: Record<Currency, number>;
  quoteHistory: QuoteHistoryRecord[];
  adminUsers: AdminUser[];
  aiLogs: AiLog[];
  qualityIssues: QualityIssue[];
  customers: Customer[];
  followupTasks: FollowupTask[];
};

export function getJsonDataSnapshot(source: DataSourceKind = "json"): AppDataSnapshot {
  return {
    source,
    products,
    knowledgeEntries,
    currencyRates: demoCurrencyRates,
    quoteHistory,
    adminUsers,
    aiLogs,
    qualityIssues,
    customers: crmCustomers,
    followupTasks,
  };
}

export function validateDataSnapshot(snapshot: AppDataSnapshot): AppDataSnapshot {
  const collections: Array<[string, { id: string }[]]> = [
    ["products", snapshot.products],
    ["knowledgeEntries", snapshot.knowledgeEntries],
    ["quoteHistory", snapshot.quoteHistory],
    ["adminUsers", snapshot.adminUsers],
    ["aiLogs", snapshot.aiLogs],
    ["qualityIssues", snapshot.qualityIssues],
    ["customers", snapshot.customers],
    ["followupTasks", snapshot.followupTasks],
  ];

  for (const [name, entries] of collections) {
    if (!Array.isArray(entries)) throw new Error(`${name} must be an array`);
    const ids = entries.map((entry) => entry.id);
    if (ids.some((id) => typeof id !== "string" || !id.trim())) throw new Error(`${name} contains an invalid id`);
    if (new Set(ids).size !== ids.length) throw new Error(`${name} contains duplicate ids`);
  }

  if (!snapshot.products.length) throw new Error("products cannot be empty");
  const productIds = new Set(snapshot.products.map((product) => product.id));
  const customerIds = new Set(snapshot.customers.map((customer) => customer.id));

  for (const task of snapshot.followupTasks) {
    if (!customerIds.has(task.customerId)) throw new Error(`followup task ${task.id} references missing customer ${task.customerId}`);
  }
  for (const customer of snapshot.customers) {
    for (const quote of customer.quotes) {
      for (const productId of quote.productIds) {
        if (!productIds.has(productId)) throw new Error(`customer quote ${quote.id} references missing product ${productId}`);
      }
    }
  }
  for (const currency of ["CNY", "USD", "CAD"] as Currency[]) {
    if (!Number.isFinite(snapshot.currencyRates[currency]) || snapshot.currencyRates[currency] <= 0) {
      throw new Error(`currency rate ${currency} must be positive`);
    }
  }

  return snapshot;
}
