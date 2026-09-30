// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testCustomers, testFollowups, testProducts } from "@/test/fixtures";
vi.mock("server-only", () => ({}));
import { mutateLocalBusinessData, readLocalBusinessData } from "./local-business-store";
let root: string;
beforeAll(async () => { root = await mkdtemp(path.join(os.tmpdir(), "lumaflow-business-test-")); vi.stubEnv("LUMAFLOW_BUSINESS_DIR", root); vi.stubEnv("DATABASE_URL", ""); });
afterAll(async () => { vi.unstubAllEnvs(); if (root && path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("lumaflow-business-test-")) await rm(root, { recursive: true }); });
describe("persistent local business records", () => {
  it("serializes parallel writes and reloads actual disk bytes", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, index) => mutateLocalBusinessData((data) => { data.products.push({ ...testProducts[0], id: `product-test-${index}` }); })));
    expect((await readLocalBusinessData()).products).toHaveLength(8);
    expect(JSON.parse(await readFile(path.join(root, "records.json"), "utf8")).products).toHaveLength(8);
  });
  it("creates, completes and reopens a task without changing seeds", async () => {
    const { createCustomer, createFollowup, getDataSnapshot, updateFollowupStatus } = await import("./data-repository");
    await createCustomer({ ...testCustomers[0], quotes: [] }, "test-request");
    const task = { ...testFollowups[0], id: "task-local-test" };
    await createFollowup(task, "test-request");
    await updateFollowupStatus(task.id, "completed", "test-request");
    expect((await getDataSnapshot()).followupTasks.find((item) => item.id === task.id)?.status).toBe("completed");
    await updateFollowupStatus(task.id, "open", "test-request");
    expect((await readLocalBusinessData()).followups.find((item) => item.id === task.id)?.status).toBe("open");
    expect(testFollowups[0].id).not.toBe(task.id);
  });
  it("persists user-created customers and product updates without PostgreSQL", async () => {
    const { createCustomer, updateProduct } = await import("./data-repository");
    const customer = { ...testCustomers[1], id: "customer-local-test", company: "用户录入公司", quotes: [] };
    await createCustomer(customer, "test-request");
    const product = (await readLocalBusinessData()).products[0];
    const updated = await updateProduct(product.id, { stock: 7 }, "test-request");
    expect(updated?.stock).toBe(7);
    const saved = await readLocalBusinessData();
    expect(saved.customers.find((item) => item.id === customer.id)?.company).toBe("用户录入公司");
    expect(saved.products.find((item) => item.id === product.id)?.stock).toBe(7);
  });
  it("rejects invalid records without corrupting saved data", async () => {
    const before = await readLocalBusinessData();
    await expect(mutateLocalBusinessData((data) => { data.products.push({ ...testProducts[0], id: "" }); })).rejects.toThrow();
    expect(await readLocalBusinessData()).toEqual(before);
  });
});
