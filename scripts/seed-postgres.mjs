import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required. Copy .env.example to .env.local and fill in your PostgreSQL connection string.");
}

const [schema, catalog, business, crm] = await Promise.all([
  readFile(path.join(projectRoot, "database", "schema.sql"), "utf8"),
  readFile(path.join(projectRoot, "src", "data", "catalog.json"), "utf8").then(JSON.parse),
  readFile(path.join(projectRoot, "src", "data", "business.json"), "utf8").then(JSON.parse),
  readFile(path.join(projectRoot, "src", "data", "crm.json"), "utf8").then(JSON.parse),
]);

const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 8_000 });
const client = await pool.connect();

async function upsertRows(table, entries) {
  for (const entry of entries) {
    await client.query(
      `INSERT INTO ${table} (id, data, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [entry.id, JSON.stringify(entry)],
    );
  }
}

try {
  await client.query(schema);
  await client.query("BEGIN");
  await upsertRows("products", catalog.products);
  await upsertRows("knowledge_entries", business.knowledgeEntries);
  await upsertRows("customers", crm.customers);
  await upsertRows("followup_tasks", crm.followupTasks);
  await upsertRows("quote_history", business.quoteHistory);
  await upsertRows("admin_users", business.adminUsers);
  await upsertRows("ai_logs", business.aiLogs);
  await upsertRows("quality_issues", business.qualityIssues);
  await client.query(
    "INSERT INTO app_settings (key, data, updated_at) VALUES ('currency_rates', $1::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()",
    [JSON.stringify(business.demoCurrencyRates)],
  );
  await client.query("COMMIT");
  console.log(`PostgreSQL seed complete: ${catalog.products.length} products, ${crm.customers.length} customers, ${business.knowledgeEntries.length} knowledge entries.`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
