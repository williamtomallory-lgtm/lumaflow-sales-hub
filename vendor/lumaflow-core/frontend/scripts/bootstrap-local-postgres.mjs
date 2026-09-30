import { copyFile, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDirectory, "..");
const projectRoot = path.resolve(frontendRoot, "..");
const dataRoot = path.join(projectRoot, ".local-data");
const secretsPath = path.join(dataRoot, "postgres-secrets.json");
const envPath = path.join(frontendRoot, ".env.local");
const envExamplePath = path.join(frontendRoot, ".env.example");
const schemaPath = path.join(frontendRoot, "database", "schema.sql");
const backupDirectory = path.join(dataRoot, "postgres-env-backups");

const expected = Object.freeze({
  host: "127.0.0.1",
  port: 5432,
  database: "lumaflow",
  ownerRole: "lumaflow_owner",
  appRole: "lumaflow_app",
});

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function makeConnectionString(role, password, database) {
  const url = new URL(`postgresql://${expected.host}:${expected.port}/${database}`);
  url.username = role;
  url.password = password;
  return url.toString();
}

function safeErrorMessage(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "<redacted>");
  }
  return message.replace(/postgres(?:ql)?:\/\/[^\s)]+/gi, "<connection-redacted>");
}

async function readSecrets() {
  let value;
  try {
    value = JSON.parse(await readFile(secretsPath, "utf8"));
  } catch {
    throw new Error(".local-data/postgres-secrets.json is missing or invalid; run Setup-Postgres.ps1 first.");
  }
  for (const key of ["host", "port", "database", "ownerRole", "ownerPassword", "appRole", "appPassword"]) {
    if (typeof value[key] !== "string" && key !== "port") {
      throw new Error(`postgres-secrets.json is missing ${key}; refusing to create a replacement credential.`);
    }
    if (key === "port" && !Number.isInteger(value[key])) {
      throw new Error("postgres-secrets.json contains an invalid port; refusing to continue.");
    }
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) {
      throw new Error(`postgres-secrets.json does not match the fixed local ${key} setting; refusing to use another endpoint.`);
    }
  }
  if (!value.ownerPassword || !value.appPassword) {
    throw new Error("postgres-secrets.json contains an empty credential; refusing to continue.");
  }
  return value;
}

async function withClient(connectionString, operation) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 8_000 });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function ensureRolesAndDatabase(secrets) {
  const adminConnection = makeConnectionString(secrets.ownerRole, secrets.ownerPassword, "postgres");
  await withClient(adminConnection, async (client) => {
    const roleResult = await client.query("SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = $1", [secrets.appRole]);
    if (roleResult.rowCount === 0) {
      await client.query(
        `CREATE ROLE ${quoteIdentifier(secrets.appRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(secrets.appPassword)}`,
      );
    } else {
      // Reusing the stored password makes reruns deterministic while these
      // flags keep the application role from becoming an accidental owner or
      // superuser.  The role never receives CREATEDB/CREATEROLE privileges.
      await client.query(
        `ALTER ROLE ${quoteIdentifier(secrets.appRole)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(secrets.appPassword)}`,
      );
    }

    const databaseResult = await client.query("SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1", [secrets.database]);
    if (databaseResult.rowCount === 0) {
      await client.query(
        `CREATE DATABASE ${quoteIdentifier(secrets.database)} OWNER ${quoteIdentifier(secrets.ownerRole)} ENCODING 'UTF8' TEMPLATE template0`,
      );
    }
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(secrets.database)} TO ${quoteIdentifier(secrets.appRole)}`);
  });
}

async function applySchemaAndPrivileges(secrets, schema) {
  const ownerConnection = makeConnectionString(secrets.ownerRole, secrets.ownerPassword, secrets.database);
  await withClient(ownerConnection, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(schema);
      await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      await client.query("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC");
      await client.query("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC");
      await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(secrets.appRole)}`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(secrets.appRole)}`);
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(secrets.appRole)}`);
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(secrets.ownerRole)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdentifier(secrets.appRole)}`,
      );
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(secrets.ownerRole)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${quoteIdentifier(secrets.appRole)}`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function verifySchemaAndPrivileges(secrets) {
  const ownerConnection = makeConnectionString(secrets.ownerRole, secrets.ownerPassword, secrets.database);
  const tableNames = await withClient(ownerConnection, async (client) => {
    const result = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    return result.rows.map((row) => row.table_name);
  });
  const requiredTables = [
    "products",
    "knowledge_entries",
    "customers",
    "followup_tasks",
    "quote_history",
    "admin_users",
    "ai_logs",
    "quality_issues",
    "app_settings",
    "audit_events",
  ];
  const missing = requiredTables.filter((table) => !tableNames.includes(table));
  if (missing.length > 0) throw new Error(`schema verification failed; missing ${missing.length} required table(s).`);

  const appConnection = makeConnectionString(secrets.appRole, secrets.appPassword, secrets.database);
  await withClient(appConnection, async (client) => {
    const privilegeResult = await client.query(
      "SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage, has_table_privilege(current_user, 'products', 'SELECT') AS can_select, has_table_privilege(current_user, 'products', 'INSERT') AS can_insert, has_table_privilege(current_user, 'products', 'UPDATE') AS can_update, has_table_privilege(current_user, 'products', 'DELETE') AS can_delete, has_table_privilege(current_user, 'products', 'TRUNCATE') AS can_truncate, has_table_privilege(current_user, 'products', 'REFERENCES') AS can_references, has_table_privilege(current_user, 'products', 'TRIGGER') AS can_trigger",
    );
    const privileges = privilegeResult.rows[0];
    if (!privileges.schema_usage || !privileges.can_select || !privileges.can_insert || !privileges.can_update || !privileges.can_delete) {
      throw new Error("schema verification failed; app role does not have the required DML privileges.");
    }
    if (privileges.can_truncate || privileges.can_references || privileges.can_trigger) {
      throw new Error("schema verification failed; app role has privileges beyond the intended DML set.");
    }
    await client.query("SELECT 1 FROM products LIMIT 1");
  });
  return tableNames;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergeEnv(source, values) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = /\r?\n$/.test(source);
  const lines = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (hadFinalNewline) lines.pop();
  for (const [key, value] of Object.entries(values)) {
    const assignment = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
    let found = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (assignment.test(lines[index])) {
        if (!found) {
          lines[index] = `${key}=${value}`;
          found = true;
        } else {
          lines.splice(index, 1);
          index -= 1;
        }
      }
    }
    if (!found) lines.push(`${key}=${value}`);
  }
  return `${lines.join(newline)}${newline}`;
}

async function writeEnvSafely(secrets) {
  let original = "";
  let existed = false;
  try {
    original = await readFile(envPath, "utf8");
    existed = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      original = await readFile(envExamplePath, "utf8");
    } catch (exampleError) {
      if (exampleError?.code !== "ENOENT") throw exampleError;
    }
  }

  const appUrl = makeConnectionString(secrets.appRole, secrets.appPassword, secrets.database);
  const updated = mergeEnv(original, {
    DATABASE_URL: appUrl,
    POSTGRES_REQUIRED: "true",
    LUMAFLOW_WRITES_ENABLED: "true",
  });
  if (updated === original && existed) return false;

  await mkdir(backupDirectory, { recursive: true });
  if (existed) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const backupPath = path.join(backupDirectory, `.env.local.${stamp}-${randomBytes(4).toString("hex")}.bak`);
    await copyFile(envPath, backupPath);
    await chmod(backupPath, 0o600).catch(() => {});
  }
  const temporary = `${envPath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, updated, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, envPath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  await chmod(envPath, 0o600).catch(() => {});
  return true;
}

async function main() {
  const secrets = await readSecrets();
  const schema = await readFile(schemaPath, "utf8");
  await ensureRolesAndDatabase(secrets);
  await applySchemaAndPrivileges(secrets, schema);
  const tableNames = await verifySchemaAndPrivileges(secrets);
  const envChanged = await writeEnvSafely(secrets);
  console.log(`PostgreSQL bootstrap complete: ${tableNames.length} tables verified; app DML role verified; .env.local ${envChanged ? "updated" : "already current"}.`);
  console.log("No sample business records were inserted.");
}

try {
  await main();
} catch (error) {
  const secrets = [];
  try {
    const value = JSON.parse(await readFile(secretsPath, "utf8"));
    secrets.push(value.ownerPassword, value.appPassword);
  } catch {
    // Keep the failure message generic if the secret file itself is unreadable.
  }
  console.error(`PostgreSQL bootstrap failed: ${safeErrorMessage(error, secrets)}`);
  process.exitCode = 1;
}
