import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const PRODUCT_FIELDS = [
  "id",
  "name",
  "model",
  "sku",
  "category",
  "family",
  "status",
  "power",
  "lumens",
  "colorTemp",
  "material",
  "dimensions",
  "colors",
  "scenarios",
  "supplier",
  "cost",
  "priceRange",
  "moq",
  "stock",
  "leadTime",
  "warranty",
  "description",
  "gradient",
  "accent",
  "assets",
];

const ASSET_FIELDS = ["id", "name", "type", "size", "version", "updatedAt"];
const ASSET_TYPES = new Set(["图片", "尺寸图", "参数表", "PDF", "证书", "案例", "视频", "说明书"]);
const PRODUCT_STATUSES = new Set(["在售", "低库存", "预售"]);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DATA_FILE = path.resolve(scriptDirectory, "../database/demo-products.json");

export class DemoProductSeedError extends Error {
  constructor(message, code = "DEMO_PRODUCT_SEED_ERROR") {
    super(message);
    this.name = "DemoProductSeedError";
    this.code = code;
  }
}

export class DemoProductConflictError extends DemoProductSeedError {
  constructor(message) {
    super(message, "DEMO_PRODUCT_CONFLICT");
    this.name = "DemoProductConflictError";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new DemoProductSeedError(message);
}

function validateString(value, field, { max, nonEmpty = true } = {}) {
  if (typeof value !== "string") fail(`${field} must be a string`);
  if (nonEmpty && value.trim().length === 0) fail(`${field} must not be empty`);
  if (max !== undefined && value.length > max) fail(`${field} exceeds ${max} characters`);
}

function validateArray(value, field, max) {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length > max) fail(`${field} exceeds ${max} items`);
}

function validateProduct(product, index, seen) {
  const label = `products[${index}]`;
  if (!isRecord(product)) fail(`${label} must be an object`);

  const unknownFields = Object.keys(product).filter((field) => !PRODUCT_FIELDS.includes(field));
  if (unknownFields.length > 0) fail(`${label} has unsupported fields: ${unknownFields.join(", ")}`);

  const stringFields = [
    ["id", 120],
    ["name", 160],
    ["model", 120],
    ["sku", 120],
    ["category", 80],
    ["family", 120],
    ["power", 80],
    ["lumens", 80],
    ["colorTemp", 120],
    ["material", 160],
    ["dimensions", 160],
    ["supplier", 160],
    ["priceRange", 120],
    ["leadTime", 180],
    ["warranty", 180],
    ["gradient", 300],
    ["accent", 40],
  ];
  for (const [field, max] of stringFields) {
    if (!Object.hasOwn(product, field)) fail(`${label}.${field} is required`);
    validateString(product[field], `${label}.${field}`, { max });
  }

  if (!PRODUCT_STATUSES.has(product.status)) fail(`${label}.status is invalid`);
  if (!Object.hasOwn(product, "description")) fail(`${label}.description is required`);
  validateString(product.description, `${label}.description`, { max: 2_000, nonEmpty: false });

  if (!product.id.startsWith("DEMO-")) fail(`${label}.id must use the DEMO- prefix`);
  if (!product.model.startsWith("DEMO-")) fail(`${label}.model must use the DEMO- prefix`);
  if (!product.sku.startsWith("DEMO-")) fail(`${label}.sku must use the DEMO- prefix`);

  for (const [field, value] of [["cost", product.cost]]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${label}.${field} must be a non-negative number`);
  }
  for (const [field, value] of [["moq", product.moq], ["stock", product.stock]]) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) fail(`${label}.${field} must be a non-negative integer`);
  }

  for (const [field, max, itemMax] of [["colors", 30, 80], ["scenarios", 50, 120]]) {
    if (!Object.hasOwn(product, field)) fail(`${label}.${field} is required`);
    validateArray(product[field], `${label}.${field}`, max);
    product[field].forEach((value, itemIndex) => validateString(value, `${label}.${field}[${itemIndex}]`, { max: itemMax }));
  }

  if (!Object.hasOwn(product, "assets")) fail(`${label}.assets is required`);
  validateArray(product.assets, `${label}.assets`, 200);
  product.assets.forEach((asset, assetIndex) => {
    const assetLabel = `${label}.assets[${assetIndex}]`;
    if (!isRecord(asset)) fail(`${assetLabel} must be an object`);
    const unknownAssetFields = Object.keys(asset).filter((field) => !ASSET_FIELDS.includes(field));
    if (unknownAssetFields.length > 0) fail(`${assetLabel} has unsupported fields: ${unknownAssetFields.join(", ")}`);
    for (const [field, max] of [["id", 120], ["name", 240], ["size", 80]]) {
      if (!Object.hasOwn(asset, field)) fail(`${assetLabel}.${field} is required`);
      validateString(asset[field], `${assetLabel}.${field}`, { max });
    }
    if (!ASSET_TYPES.has(asset.type)) fail(`${assetLabel}.type is invalid`);
    for (const [field, max] of [["version", 40], ["updatedAt", 80]]) {
      if (Object.hasOwn(asset, field)) validateString(asset[field], `${assetLabel}.${field}`, { max, nonEmpty: false });
    }
    if (seen.assetIds.has(asset.id)) fail(`duplicate asset id: ${asset.id}`);
    seen.assetIds.add(asset.id);
  });

  for (const [field, set] of [["id", seen.ids], ["model", seen.models], ["sku", seen.skus]]) {
    if (set.has(product[field])) fail(`duplicate product ${field}: ${product[field]}`);
    set.add(product[field]);
  }
}

/** Validate the JSON document against the Product and Asset contracts. */
export function validateDemoProducts(products) {
  if (!Array.isArray(products)) fail("demo-products.json must contain a products array or be an array itself");
  const seen = { ids: new Set(), models: new Set(), skus: new Set(), assetIds: new Set() };
  products.forEach((product, index) => validateProduct(product, index, seen));
  return products;
}

function productsFromDocument(document) {
  if (Array.isArray(document)) return document;
  if (isRecord(document) && Array.isArray(document.products)) return document.products;
  fail("demo-products.json must be an array or an object with a products array");
}

export async function loadDemoProducts(filePath = DEFAULT_DATA_FILE) {
  let document;
  const absolutePath = path.resolve(filePath);
  try {
    document = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DemoProductSeedError(`Invalid JSON in ${absolutePath}: ${error.message}`, "DEMO_PRODUCT_JSON_INVALID");
    }
    throw new DemoProductSeedError(`Unable to read ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`, "DEMO_PRODUCT_FILE_ERROR");
  }
  return validateDemoProducts(productsFromDocument(document));
}

// Keep the shorter name convenient for callers that use this as a small library.
export const readDemoProducts = loadDemoProducts;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function productsEqual(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function decodeJson(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (Buffer.isBuffer(value)) {
    try {
      return JSON.parse(value.toString("utf8"));
    } catch {
      return value.toString("utf8");
    }
  }
  return value;
}

function conflict(product, reason) {
  throw new DemoProductConflictError(`Existing product conflicts with ${product.id} (${reason}); refusing to overwrite it.`);
}

/**
 * Insert validated products in one transaction. Existing identical rows are
 * skipped; an ID/model/SKU collision with different data aborts the whole
 * transaction. No rows outside the supplied demo set are modified or deleted.
 */
export async function seedDemoProducts({ products, pool, logger = null } = {}) {
  validateDemoProducts(products);
  if (!pool || typeof pool.connect !== "function") throw new DemoProductSeedError("A PostgreSQL pool is required");

  const client = await pool.connect();
  const insertedIds = [];
  const skippedIds = [];
  try {
    await client.query("BEGIN");

    for (const product of products) {
      const existingResult = await client.query(
        "SELECT id, data FROM products WHERE id = $1 OR data ->> 'model' = $2 OR data ->> 'sku' = $3 FOR UPDATE",
        [product.id, product.model, product.sku],
      );
      let identicalIdFound = false;
      for (const row of existingResult?.rows ?? []) {
        const existingData = decodeJson(row.data);
        const rowId = String(row.id ?? (isRecord(existingData) ? existingData.id : ""));
        if (rowId === product.id) {
          if (!productsEqual(existingData, product)) conflict(product, `id ${product.id} has different data`);
          identicalIdFound = true;
          continue;
        }
        if (isRecord(existingData) && existingData.model === product.model) conflict(product, `model ${product.model} is already used by ${rowId}`);
        if (isRecord(existingData) && existingData.sku === product.sku) conflict(product, `sku ${product.sku} is already used by ${rowId}`);
      }

      if (identicalIdFound) {
        skippedIds.push(product.id);
        continue;
      }

      await client.query(
        "INSERT INTO products (id, data, updated_at) VALUES ($1, $2::jsonb, NOW())",
        [product.id, JSON.stringify(product)],
      );
      insertedIds.push(product.id);
    }

    await client.query("COMMIT");
    const result = {
      total: products.length,
      inserted: insertedIds.length,
      skipped: skippedIds.length,
      insertedIds,
      skippedIds,
    };
    if (logger?.log) logger.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error; the transaction is already being closed.
    }
    throw error;
  } finally {
    client.release();
  }
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  let filePath = DEFAULT_DATA_FILE;
  let filePathWasProvided = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--file") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) throw new DemoProductSeedError("--file requires a path", "DEMO_PRODUCT_CLI_INVALID");
      filePath = next;
      filePathWasProvided = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--file=")) {
      const value = argument.slice("--file=".length);
      if (!value) throw new DemoProductSeedError("--file requires a path", "DEMO_PRODUCT_CLI_INVALID");
      filePath = value;
      filePathWasProvided = true;
      continue;
    }
    if (!argument.startsWith("-") && !filePathWasProvided) {
      filePath = argument;
      filePathWasProvided = true;
      continue;
    }
    throw new DemoProductSeedError(`Unknown CLI argument: ${argument}`, "DEMO_PRODUCT_CLI_INVALID");
  }

  return { filePath: path.resolve(filePath), help };
}

const HELP_TEXT = `Usage: node --env-file-if-exists=.env.local scripts/seed-demo-products.mjs [--file PATH]

Reads the demo product JSON and inserts it into PostgreSQL.
Identical existing rows are skipped; different ID/model/SKU collisions abort the transaction.
`;

export async function runCli(argv = process.argv.slice(2), environment = process.env) {
  const options = parseCliArgs(argv);
  if (options.help) {
    console.log(HELP_TEXT);
    return { help: true };
  }
  if (!environment.DATABASE_URL?.trim()) {
    throw new DemoProductSeedError("DATABASE_URL is required; configure PostgreSQL before seeding demo products.", "DATABASE_URL_REQUIRED");
  }

  const products = await loadDemoProducts(options.filePath);
  const pool = new Pool({ connectionString: environment.DATABASE_URL, max: 2, connectionTimeoutMillis: 8_000 });
  try {
    return await seedDemoProducts({ products, pool });
  } finally {
    await pool.end();
  }
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedScript === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await runCli();
    if (!result.help) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`[seed-demo-products] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
