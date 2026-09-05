import "server-only";

import businessSeed from "../../data/business.json";
import catalogSeed from "../../data/catalog.json";
import crmSeed from "../../data/crm.json";
import type { AdminUser, AiLog, Currency, KnowledgeEntry, QualityIssue, QuoteHistoryRecord } from "../business";
import type { Product } from "../catalog";
import type { Customer, FollowupTask } from "../crm";
import type { AppDataSnapshot, DataSourceKind } from "../data-snapshot";

export function getJsonDataSnapshot(source: DataSourceKind = "json"): AppDataSnapshot {
  return {
    source,
    products: catalogSeed.products as Product[],
    knowledgeEntries: businessSeed.knowledgeEntries as KnowledgeEntry[],
    currencyRates: businessSeed.demoCurrencyRates as Record<Currency, number>,
    quoteHistory: businessSeed.quoteHistory as QuoteHistoryRecord[],
    adminUsers: businessSeed.adminUsers as AdminUser[],
    aiLogs: businessSeed.aiLogs as AiLog[],
    qualityIssues: businessSeed.qualityIssues as QualityIssue[],
    customers: crmSeed.customers as Customer[],
    followupTasks: crmSeed.followupTasks as FollowupTask[],
  };
}
