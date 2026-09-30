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

const schema = await readFile(path.join(projectRoot, "database", "schema.sql"), "utf8");

const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 8_000 });
const client = await pool.connect();

try {
  await client.query(schema);
  console.log("PostgreSQL schema ready. No sample business records were inserted.");
} catch (error) {
  throw error;
} finally {
  client.release();
  await pool.end();
}
