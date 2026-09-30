import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const fixtureUrls = [
  new URL("../src/test/fixtures-data/catalog.fixture.json", import.meta.url),
  new URL("../src/test/fixtures-data/business.fixture.json", import.meta.url),
  new URL("../src/test/fixtures-data/crm.fixture.json", import.meta.url),
];
const [catalogFixture, businessFixture, crmFixture] = await Promise.all(fixtureUrls.map((url) => readFile(fileURLToPath(url), "utf8").then(JSON.parse)));
const fixtureIds = new Set([
  ...catalogFixture.products,
  ...businessFixture.knowledgeEntries,
  ...businessFixture.quoteHistory,
  ...businessFixture.adminUsers,
  ...businessFixture.aiLogs,
  ...businessFixture.qualityIssues,
  ...crmFixture.customers,
  ...crmFixture.followupTasks,
].map((entry) => entry.id));

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  assert.ok(response.headers.get("x-request-id"), `${path} must return X-Request-Id`);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/, `${path} must disable caching`);
  return { response, body };
}

const bootstrap = await request("/api/v1/bootstrap");
assert.equal(bootstrap.response.status, 200);
assert.ok(["local", "postgres", "local-fallback"].includes(bootstrap.body.data.source));
assert.equal(bootstrap.body.meta.source, bootstrap.body.data.source);
assert.equal(bootstrap.body.dashboard.aiEvents.value, bootstrap.body.data.aiLogs.length);
for (const key of ["products", "knowledgeEntries", "quoteHistory", "adminUsers", "aiLogs", "qualityIssues", "customers", "followupTasks"]) {
  assert.ok(Array.isArray(bootstrap.body.data[key]), `${key} must be returned by the backend as an array`);
  assert.equal(bootstrap.body.data[key].some((entry) => fixtureIds.has(entry.id)), false, `${key} must not contain test fixtures`);
}

const health = await request("/api/v1/health");
assert.equal(health.response.status, 200);
assert.equal(health.body.data.source, bootstrap.body.meta.source);

const products = await request("/api/v1/products?q=__lumaflow_fixture_absence_probe__&limit=10");
assert.equal(products.response.status, 200);
assert.equal(products.body.data.length, 0);

const customers = await request("/api/v1/customers?q=__lumaflow_fixture_absence_probe__");
assert.equal(customers.response.status, 200);
assert.equal(customers.body.data.length, 0);

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
assert.ok([403, 503].includes(blockedWrite.response.status));
assert.ok(["ORIGIN_REQUIRED", "WRITES_DISABLED"].includes(blockedWrite.body.error.code));

const page = await fetch(baseUrl);
assert.equal(page.status, 200);
assert.equal(page.headers.get("x-frame-options"), "DENY");
assert.equal(page.headers.get("x-content-type-options"), "nosniff");

console.log(JSON.stringify({
  ok: true,
  source: bootstrap.body.meta.source,
  productCount: bootstrap.body.data.products.length,
  customerCount: bootstrap.body.data.customers.length,
  fixtureRecordsVisible: false,
  customerSearchMatches: customers.body.meta.total,
  openFollowups: followups.body.meta.total,
  database: health.body.data.database,
  checks: 31,
}, null, 2));
