import "server-only";

import { Pool } from "pg";
import { getJsonDataSnapshot, validateDataSnapshot, type AppDataSnapshot } from "../data-snapshot";

type DataRow = { data: unknown };
type SettingRow = { key: string; data: unknown };
type DataTable = "products" | "knowledge_entries" | "quote_history" | "admin_users" | "ai_logs" | "quality_issues" | "customers" | "followup_tasks";

const globalForPostgres = globalThis as typeof globalThis & { lumaflowPool?: Pool };

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!globalForPostgres.lumaflowPool) {
    globalForPostgres.lumaflowPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return globalForPostgres.lumaflowPool;
}

async function rows(pool: Pool, table: DataTable) {
  const result = await pool.query<DataRow>(`SELECT data FROM ${table} ORDER BY id`);
  return result.rows.map((row) => row.data);
}

export async function getDataSnapshot(): Promise<AppDataSnapshot> {
  const pool = getPool();
  if (!pool) return validateDataSnapshot(getJsonDataSnapshot());

  try {
    const [
      productRows,
      knowledgeRows,
      quoteRows,
      userRows,
      logRows,
      issueRows,
      customerRows,
      taskRows,
      settingResult,
    ] = await Promise.all([
      rows(pool, "products"),
      rows(pool, "knowledge_entries"),
      rows(pool, "quote_history"),
      rows(pool, "admin_users"),
      rows(pool, "ai_logs"),
      rows(pool, "quality_issues"),
      rows(pool, "customers"),
      rows(pool, "followup_tasks"),
      pool.query<SettingRow>("SELECT key, data FROM app_settings WHERE key = 'currency_rates'"),
    ]);
    const fallback = getJsonDataSnapshot();
    const hasCompletePostgresData = [productRows, knowledgeRows, quoteRows, userRows, logRows, issueRows, customerRows, taskRows].every((collection) => collection.length > 0) && settingResult.rows.length > 0;
    const snapshot: AppDataSnapshot = {
      source: hasCompletePostgresData ? "postgres" : "json-fallback",
      products: (productRows.length ? productRows : fallback.products) as AppDataSnapshot["products"],
      knowledgeEntries: (knowledgeRows.length ? knowledgeRows : fallback.knowledgeEntries) as AppDataSnapshot["knowledgeEntries"],
      currencyRates: (settingResult.rows[0]?.data ?? fallback.currencyRates) as AppDataSnapshot["currencyRates"],
      quoteHistory: (quoteRows.length ? quoteRows : fallback.quoteHistory) as AppDataSnapshot["quoteHistory"],
      adminUsers: (userRows.length ? userRows : fallback.adminUsers) as AppDataSnapshot["adminUsers"],
      aiLogs: (logRows.length ? logRows : fallback.aiLogs) as AppDataSnapshot["aiLogs"],
      qualityIssues: (issueRows.length ? issueRows : fallback.qualityIssues) as AppDataSnapshot["qualityIssues"],
      customers: (customerRows.length ? customerRows : fallback.customers) as AppDataSnapshot["customers"],
      followupTasks: (taskRows.length ? taskRows : fallback.followupTasks) as AppDataSnapshot["followupTasks"],
    };
    return validateDataSnapshot(snapshot);
  } catch (error) {
    if (process.env.POSTGRES_REQUIRED === "true") throw error;
    console.warn("PostgreSQL data load failed; using JSON fallback:", error instanceof Error ? error.message : "unknown error");
    return validateDataSnapshot(getJsonDataSnapshot("json-fallback"));
  }
}
