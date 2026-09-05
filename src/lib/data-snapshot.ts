import type { AdminUser, AiLog, Currency, KnowledgeEntry, QualityIssue, QuoteHistoryRecord } from "./business";
import type { Product } from "./catalog";
import type { Customer, FollowupTask } from "./crm";
import { dataSnapshotSchema, type DashboardSummary } from "./contracts/api";

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

export function validateDataSnapshot(snapshot: AppDataSnapshot): AppDataSnapshot {
  const parsed = dataSnapshotSchema.parse(snapshot);
  const collections: Array<[string, { id: string }[]]> = [
    ["products", parsed.products],
    ["knowledgeEntries", parsed.knowledgeEntries],
    ["quoteHistory", parsed.quoteHistory],
    ["adminUsers", parsed.adminUsers],
    ["aiLogs", parsed.aiLogs],
    ["qualityIssues", parsed.qualityIssues],
    ["customers", parsed.customers],
    ["followupTasks", parsed.followupTasks],
  ];

  for (const [name, entries] of collections) {
    if (!Array.isArray(entries)) throw new Error(`${name} must be an array`);
    const ids = entries.map((entry) => entry.id);
    if (ids.some((id) => typeof id !== "string" || !id.trim())) throw new Error(`${name} contains an invalid id`);
    if (new Set(ids).size !== ids.length) throw new Error(`${name} contains duplicate ids`);
  }

  if (!parsed.products.length) throw new Error("products cannot be empty");
  const productIds = new Set(parsed.products.map((product) => product.id));
  const customerIds = new Set(parsed.customers.map((customer) => customer.id));

  for (const task of parsed.followupTasks) {
    if (!customerIds.has(task.customerId)) throw new Error(`followup task ${task.id} references missing customer ${task.customerId}`);
  }
  for (const customer of parsed.customers) {
    for (const quote of customer.quotes) {
      for (const productId of quote.productIds) {
        if (!productIds.has(productId)) throw new Error(`customer quote ${quote.id} references missing product ${productId}`);
      }
    }
  }
  for (const currency of ["CNY", "USD", "CAD"] as Currency[]) {
    if (!Number.isFinite(parsed.currencyRates[currency]) || parsed.currencyRates[currency] <= 0) {
      throw new Error(`currency rate ${currency} must be positive`);
    }
  }

  return parsed;
}

export function buildDashboardSummary(snapshot: AppDataSnapshot): DashboardSummary {
  const assets = snapshot.products.flatMap((product) => product.assets);
  const presaleCount = snapshot.products.filter((product) => product.status === "预售").length;
  const certificateCount = assets.filter((asset) => asset.type === "证书").length;
  const openFollowups = snapshot.followupTasks.filter((task) => task.status === "open").length;
  const expectedAssetsPerProduct = 4;
  const dataCompleteness = Math.min(100, Math.round((assets.length / Math.max(1, snapshot.products.length * expectedAssetsPerProduct)) * 100));
  const logCountsByHour = new Map<string, number>();
  for (const log of snapshot.aiLogs) {
    const hour = /^\d{1,2}:/.exec(log.time)?.[0]?.replace(":", "时") ?? log.time;
    logCountsByHour.set(hour, (logCountsByHour.get(hour) ?? 0) + 1);
  }
  const activitySeries = [...logCountsByHour.entries()]
    .map(([label, value]) => ({ label, value }))
    .slice(-7);
  const recentActivities: DashboardSummary["recentActivities"] = snapshot.aiLogs.slice(0, 3).map((log) => ({
    id: `activity-${log.id}`,
    kind: "ai" as const,
    title: log.action,
    detail: `${log.user} · ${log.result}`,
    occurredAt: log.time,
  }));

  if (recentActivities.length < 3) {
    recentActivities.push(...snapshot.qualityIssues.slice(0, 3 - recentActivities.length).map((issue) => ({
      id: `activity-${issue.id}`,
      kind: "quality" as const,
      title: issue.subject,
      detail: `${issue.field} · ${issue.detail}`,
      occurredAt: "待处理",
    })));
  }

  return {
    dataCompleteness,
    qualityIssueCount: snapshot.qualityIssues.length,
    activeProducts: { value: snapshot.products.length - presaleCount, note: `${presaleCount} 款预售` },
    assets: { value: assets.length, note: `${certificateCount} 份证书` },
    aiEvents: { value: snapshot.aiLogs.length, note: "来自后端日志" },
    quotations: { value: snapshot.quoteHistory.length, note: `${openFollowups} 项待跟进` },
    activitySeries,
    recentActivities,
  };
}
