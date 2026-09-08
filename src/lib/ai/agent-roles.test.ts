// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { agentRoleIdSchema, listAgentRoles, loadAgentRole } from "./agent-roles";

describe("Agent role policies", () => {
  it("keeps the four user roles and server-owned tool allowlists", () => {
    expect(listAgentRoles().map((role) => role.id)).toEqual([
      "sales-consultant",
      "wechat-service",
      "sales-review",
      "moments-operator",
    ]);
    expect(loadAgentRole("wechat-service").toolNames).not.toContain("createQuoteDraft");
    expect(loadAgentRole("moments-operator").toolNames).not.toContain("checkInventory");
    expect(loadAgentRole("sales-consultant").instructions).toContain("不自动发送");
  });

  it("rejects unknown role IDs instead of falling back to broader permissions", () => {
    expect(agentRoleIdSchema.safeParse("administrator").success).toBe(false);
    expect(() => loadAgentRole("administrator")).toThrow();
    expect(loadAgentRole().id).toBe("sales-consultant");
  });
});
