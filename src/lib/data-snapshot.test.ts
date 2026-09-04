import { describe, expect, it } from "vitest";
import { getJsonDataSnapshot, validateDataSnapshot } from "./data-snapshot";

describe("JSON data snapshot", () => {
  it("loads every separated seed collection", () => {
    const snapshot = getJsonDataSnapshot();

    expect(snapshot.source).toBe("json");
    expect(snapshot.products).toHaveLength(6);
    expect(snapshot.knowledgeEntries).toHaveLength(7);
    expect(snapshot.customers).toHaveLength(4);
    expect(snapshot.followupTasks).toHaveLength(6);
    expect(snapshot.quoteHistory).toHaveLength(3);
    expect(snapshot.adminUsers).toHaveLength(4);
  });

  it("has unique identifiers, valid relations, and positive currency rates", () => {
    const snapshot = getJsonDataSnapshot();
    expect(validateDataSnapshot(snapshot)).toBe(snapshot);
  });

  it("rejects a follow-up task that points to a missing customer", () => {
    const snapshot = getJsonDataSnapshot();
    const invalid = {
      ...snapshot,
      followupTasks: snapshot.followupTasks.map((task, index) => index === 0 ? { ...task, customerId: "missing-customer" } : task),
    };

    expect(() => validateDataSnapshot(invalid)).toThrow(/references missing customer/);
  });
});
