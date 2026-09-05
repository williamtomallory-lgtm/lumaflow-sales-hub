import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const catalogUrl = new URL("../src/data/catalog.json", import.meta.url);
const catalogSeed = JSON.parse(await readFile(fileURLToPath(catalogUrl), "utf8"));

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  assert.ok(response.headers.get("x-request-id"), `${path} must return X-Request-Id`);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/, `${path} must disable caching`);
  return { response, body };
}

const bootstrap = await request("/api/v1/bootstrap");
assert.equal(bootstrap.response.status, 200);
assert.equal(bootstrap.body.data.products.length, catalogSeed.products.length);
assert.equal(bootstrap.body.data.products[0].id, catalogSeed.products[0].id);
assert.equal(bootstrap.body.data.products[0].sku, catalogSeed.products[0].sku);
assert.equal(bootstrap.body.meta.source, bootstrap.body.data.source);
assert.equal(bootstrap.body.dashboard.aiEvents.value, bootstrap.body.data.aiLogs.length);

const health = await request("/api/v1/health");
assert.equal(health.response.status, 200);
assert.equal(health.body.data.source, bootstrap.body.meta.source);

const products = await request("/api/v1/products?q=ARC&limit=10");
assert.equal(products.response.status, 200);
assert.ok(products.body.data.length > 0);
assert.ok(products.body.data.every((product) => `${product.name}${product.model}${product.sku}`.toLowerCase().includes("arc")));

const customers = await request("/api/v1/customers?q=NOVA");
assert.equal(customers.response.status, 200);
assert.ok(customers.body.data.some((customer) => customer.company.includes("NOVA")));

const followups = await request("/api/v1/followups?status=open");
assert.equal(followups.response.status, 200);
assert.ok(followups.body.data.every((task) => task.status === "open"));

const invalidQuery = await request("/api/v1/products?limit=999");
assert.equal(invalidQuery.response.status, 422);
assert.equal(invalidQuery.body.error.code, "VALIDATION_FAILED");

const blockedWrite = await request("/api/v1/products", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
assert.equal(blockedWrite.response.status, 503);
assert.equal(blockedWrite.body.error.code, "WRITES_DISABLED");

const page = await fetch(baseUrl);
assert.equal(page.status, 200);
assert.equal(page.headers.get("x-frame-options"), "DENY");
assert.equal(page.headers.get("x-content-type-options"), "nosniff");

console.log(JSON.stringify({
  ok: true,
  source: bootstrap.body.meta.source,
  productCount: bootstrap.body.data.products.length,
  firstProduct: { id: bootstrap.body.data.products[0].id, sku: bootstrap.body.data.products[0].sku },
  customerSearchMatches: customers.body.meta.total,
  openFollowups: followups.body.meta.total,
  database: health.body.data.database,
  checks: 22,
}, null, 2));
