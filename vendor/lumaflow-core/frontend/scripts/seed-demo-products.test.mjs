import assert from "node:assert/strict";
import {
  DemoProductConflictError,
  loadDemoProducts,
  parseCliArgs,
  productsEqual,
  seedDemoProducts,
} from "./seed-demo-products.mjs";

class FakeClient {
  constructor(pool) {
    this.pool = pool;
  }

  async query(text, params = []) {
    const normalized = text.trim();
    this.pool.queries.push({ text: normalized, params });
    if (normalized === "BEGIN") {
      this.pool.workingRows = structuredClone(this.pool.rows);
      return { rows: [] };
    }
    if (normalized === "COMMIT") {
      this.pool.rows = this.pool.workingRows;
      this.pool.workingRows = null;
      this.pool.committed = true;
      return { rows: [] };
    }
    if (normalized === "ROLLBACK") {
      this.pool.workingRows = null;
      this.pool.rolledBack = true;
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT id, data FROM products")) {
      assert.equal(params.length, 3, "product identity lookup must be parameterized");
      const [id, model, sku] = params;
      return {
        rows: (this.pool.workingRows ?? []).filter((row) => {
          const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
          return row.id === id || data?.model === model || data?.sku === sku;
        }).map((row) => structuredClone(row)),
      };
    }
    if (normalized.startsWith("INSERT INTO products")) {
      assert.equal(params.length, 2, "product insert must be parameterized");
      const [id, data] = params;
      assert.equal(typeof id, "string");
      assert.equal(typeof data, "string");
      (this.pool.workingRows ??= []).push({ id, data: JSON.parse(data) });
      return { rows: [] };
    }
    throw new Error(`Unexpected fake query: ${normalized}`);
  }

  release() {
    this.pool.released += 1;
  }
}

class FakePool {
  constructor(rows = []) {
    this.rows = structuredClone(rows);
    this.workingRows = null;
    this.queries = [];
    this.committed = false;
    this.rolledBack = false;
    this.released = 0;
  }

  async connect() {
    return new FakeClient(this);
  }
}

const products = await loadDemoProducts();
assert.equal(products.length, 8);
assert.ok(products.every((product) => product.id.startsWith("DEMO-")));
assert.ok(products.every((product) => product.model.startsWith("DEMO-")));
assert.ok(products.every((product) => product.sku.startsWith("DEMO-")));
assert.ok(products.every((product) => product.name.includes("演示产品")));
assert.ok(products.every((product) => product.description.includes("模拟数据")));
assert.equal(new Set(products.map((product) => product.id)).size, products.length);
assert.equal(new Set(products.map((product) => product.model)).size, products.length);
assert.equal(new Set(products.map((product) => product.sku)).size, products.length);
assert.ok(products.every((product) => product.assets.length > 0));

assert.equal(productsEqual({ b: { z: 2, a: 1 }, a: [3, 4] }, { a: [3, 4], b: { a: 1, z: 2 } }), true);
assert.deepEqual(parseCliArgs(["--file", "database/demo-products.json"]).filePath, parseCliArgs(["database/demo-products.json"]).filePath);

const untouched = { id: "REAL-PRODUCT-UNCHANGED", data: { id: "REAL-PRODUCT-UNCHANGED", model: "REAL-MODEL", sku: "REAL-SKU" } };
const pool = new FakePool([untouched]);
const first = await seedDemoProducts({ products, pool });
assert.deepEqual(first, {
  total: 8,
  inserted: 8,
  skipped: 0,
  insertedIds: products.map((product) => product.id),
  skippedIds: [],
});
assert.equal(pool.rows.length, 9);
assert.deepEqual(pool.rows[0], untouched);
assert.equal(pool.committed, true);
assert.equal(pool.rolledBack, false);
assert.equal(pool.released, 1);
assert.equal(pool.queries.some(({ text }) => /\b(DELETE|TRUNCATE|DROP)\b/i.test(text)), false);
assert.ok(pool.queries.filter(({ text }) => text.startsWith("SELECT") || text.startsWith("INSERT")).every(({ params }) => Array.isArray(params) && params.length > 0));

const second = await seedDemoProducts({ products, pool });
assert.equal(second.inserted, 0);
assert.equal(second.skipped, 8);
assert.deepEqual(second.skippedIds, products.map((product) => product.id));
assert.equal(pool.rows.length, 9, "idempotent reseeding must not duplicate or remove rows");

const changedProduct = structuredClone(products[0]);
changedProduct.description = `${changedProduct.description} changed`;
const conflictPool = new FakePool([{ id: products[0].id, data: products[0] }]);
await assert.rejects(
  seedDemoProducts({ products: [changedProduct], pool: conflictPool }),
  (error) => error instanceof DemoProductConflictError && error.code === "DEMO_PRODUCT_CONFLICT",
);
assert.equal(conflictPool.committed, false);
assert.equal(conflictPool.rolledBack, true);
assert.deepEqual(conflictPool.rows, [{ id: products[0].id, data: products[0] }]);

const existingLaterProduct = structuredClone(products[1]);
existingLaterProduct.description = `${existingLaterProduct.description} changed`;
const partialConflictPool = new FakePool([{ id: existingLaterProduct.id, data: existingLaterProduct }]);
await assert.rejects(seedDemoProducts({ products, pool: partialConflictPool }), DemoProductConflictError);
assert.equal(partialConflictPool.rows.length, 1, "a later conflict must roll back earlier inserts");
assert.equal(partialConflictPool.rolledBack, true);

const modelCollision = { ...structuredClone(products[0]), id: "DEMO-PRODUCT-COLLISION", sku: "DEMO-SKU-COLLISION" };
const modelCollisionPool = new FakePool([{ id: "REAL-PRODUCT-01", data: { ...products[0], id: "REAL-PRODUCT-01" } }]);
await assert.rejects(seedDemoProducts({ products: [modelCollision], pool: modelCollisionPool }), DemoProductConflictError);
assert.equal(modelCollisionPool.rows.length, 1);
assert.equal(modelCollisionPool.rolledBack, true);

console.log(JSON.stringify({
  ok: true,
  products: products.length,
  insertedOnFirstRun: first.inserted,
  skippedOnSecondRun: second.skipped,
  externalRowsPreserved: true,
  conflictingIdRejected: true,
  conflictingModelRejected: true,
  transactionRollbackVerified: true,
  parameterizedQueriesVerified: true,
}, null, 2));
