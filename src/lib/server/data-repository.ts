import "server-only";

import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { customerSchema, followupTaskSchema, productSchema } from "../contracts/api";
import { validateDataSnapshot, type AppDataSnapshot } from "../data-snapshot";
import { getEmptyDataSnapshot } from "./runtime-data";
import { mutateLocalBusinessData, readLocalBusinessData } from "./local-business-store";
import type { Product } from "../catalog";
import type { Customer, FollowupTask, FollowupTaskStatus } from "../crm";

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
  if (!pool) {
    const snapshot = getEmptyDataSnapshot("local");
    const local = await readLocalBusinessData();
    snapshot.products = local.products;
    snapshot.customers = local.customers;
    snapshot.followupTasks = local.followups;
    return validateDataSnapshot(snapshot);
  }

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
    const snapshot: AppDataSnapshot = {
      source: "postgres",
      products: productRows as AppDataSnapshot["products"],
      knowledgeEntries: knowledgeRows as AppDataSnapshot["knowledgeEntries"],
      currencyRates: (settingResult.rows[0]?.data ?? {}) as AppDataSnapshot["currencyRates"],
      quoteHistory: quoteRows as AppDataSnapshot["quoteHistory"],
      adminUsers: userRows as AppDataSnapshot["adminUsers"],
      aiLogs: logRows as AppDataSnapshot["aiLogs"],
      qualityIssues: issueRows as AppDataSnapshot["qualityIssues"],
      customers: customerRows as AppDataSnapshot["customers"],
      followupTasks: taskRows as AppDataSnapshot["followupTasks"],
    };
    return validateDataSnapshot(snapshot);
  } catch (error) {
    if (process.env.POSTGRES_REQUIRED === "true") throw error;
    console.warn("PostgreSQL data load failed; using the server-side local store without sample rows:", error instanceof Error ? error.message : "unknown error");
    const local = await readLocalBusinessData();
    return validateDataSnapshot({ ...getEmptyDataSnapshot("local-fallback"), products: local.products, customers: local.customers, followupTasks: local.followups });
  }
}

export class PersistenceUnavailableError extends Error {
  constructor() {
    super("PostgreSQL is required for persistent writes. Configure DATABASE_URL and run npm run db:setup.");
    this.name = "PersistenceUnavailableError";
  }
}

function requirePool() {
  const pool = getPool();
  if (!pool) throw new PersistenceUnavailableError();
  return pool;
}

export async function getDatabaseHealth() {
  const pool = getPool();
  if (!pool) return { configured: false, reachable: false as const, latencyMs: null };
  const startedAt = performance.now();
  try {
    await pool.query("SELECT 1");
    return { configured: true, reachable: true as const, latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    return { configured: true, reachable: false as const, latencyMs: null };
  }
}

async function insertAuditEvent(client: PoolClient, event: { action: string; entityType: string; entityId: string; requestId: string }) {
  await client.query(
    "INSERT INTO audit_events (id, action, entity_type, entity_id, request_id, created_at) VALUES ($1, $2, $3, $4, $5, NOW())",
    [randomUUID(), event.action, event.entityType, event.entityId, event.requestId],
  );
}

async function inTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createProduct(product: Product, requestId: string) {
  const parsed = productSchema.parse(product);
  if (!getPool()) return mutateLocalBusinessData((data) => { data.products.push(parsed); return parsed; });
  const pool = requirePool();
  return inTransaction(pool, async (client) => {
    await client.query("INSERT INTO products (id, data, updated_at) VALUES ($1, $2::jsonb, NOW())", [parsed.id, JSON.stringify(parsed)]);
    await insertAuditEvent(client, { action: "product.create", entityType: "product", entityId: parsed.id, requestId });
    return parsed;
  });
}

export async function updateProduct(productId: string, patch: Partial<Omit<Product, "id">>, requestId: string) {
  if (!getPool()) return mutateLocalBusinessData((data) => {
    const current = data.products.find((product) => product.id === productId);
    if (!current) return null;
    const parsed = productSchema.parse({ ...current, ...patch, id: productId });
    data.products = [...data.products.filter((product) => product.id !== productId), parsed];
    return parsed;
  });
  const pool = requirePool();
  return inTransaction(pool, async (client) => {
    const current = await client.query<DataRow>("SELECT data FROM products WHERE id = $1 FOR UPDATE", [productId]);
    if (!current.rows[0]) return null;
    const parsed = productSchema.parse({ ...(current.rows[0].data as Product), ...patch, id: productId });
    await client.query("UPDATE products SET data = $2::jsonb, updated_at = NOW() WHERE id = $1", [productId, JSON.stringify(parsed)]);
    await insertAuditEvent(client, { action: "product.update", entityType: "product", entityId: parsed.id, requestId });
    return parsed;
  });
}

export async function updateFollowupStatus(taskId: string, status: FollowupTaskStatus, requestId: string) {
  if (!getPool()) return mutateLocalBusinessData((data) => {
    const current = data.followups.find((task) => task.id === taskId);
    if (!current) return null;
    const updated = followupTaskSchema.parse({ ...current, status });
    data.followups = [...data.followups.filter((task) => task.id !== taskId), updated];
    return updated;
  });
  const pool = requirePool();
  return inTransaction(pool, async (client) => {
    const current = await client.query<DataRow>("SELECT data FROM followup_tasks WHERE id = $1 FOR UPDATE", [taskId]);
    if (!current.rows[0]) return null;
    const task = current.rows[0].data as FollowupTask;
    const parsed = followupTaskSchema.parse({
      ...task,
      status,
      dueLabel: status === "completed" ? `已完成 · ${task.dueLabel.replace(/^已逾期\s*/, "")}` : task.dueLabel.replace(/^已完成\s*·\s*/, ""),
    });
    await client.query("UPDATE followup_tasks SET data = $2::jsonb, updated_at = NOW() WHERE id = $1", [taskId, JSON.stringify(parsed)]);
    await insertAuditEvent(client, { action: "followup.status.update", entityType: "followup", entityId: parsed.id, requestId });
    return parsed;
  });
}

export async function createFollowup(task: FollowupTask, requestId: string) {
  const parsed = followupTaskSchema.parse(task);
  if (!getPool()) return mutateLocalBusinessData((data) => { data.followups.push(parsed); return parsed; });
  return inTransaction(requirePool(), async (client) => {
    await client.query("INSERT INTO followup_tasks (id, data, updated_at) VALUES ($1, $2::jsonb, NOW())", [parsed.id, JSON.stringify(parsed)]);
    await insertAuditEvent(client, { action: "followup.create", entityType: "followup", entityId: parsed.id, requestId });
    return parsed;
  });
}

export async function createCustomer(customer: Customer, requestId: string) {
  const parsed = customerSchema.parse(customer);
  if (!getPool()) return mutateLocalBusinessData((data) => { data.customers.push(parsed); return parsed; });
  return inTransaction(requirePool(), async (client) => {
    await client.query("INSERT INTO customers (id, data, updated_at) VALUES ($1, $2::jsonb, NOW())", [parsed.id, JSON.stringify(parsed)]);
    await insertAuditEvent(client, { action: "customer.create", entityType: "customer", entityId: parsed.id, requestId });
    return parsed;
  });
}
