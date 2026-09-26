// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { agentRoleIdSchema, listAgentRoles, loadAgentRole, loadCowAgentRole } from "./agent-roles";

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

  it("uses backend identity and duties without letting a profile grant tools", () => {
    const personal = loadCowAgentRole({ id: "north-wechat", name: "北区客服", description: "负责北区客户私聊", enabled: true, type: "wechat", workspace: "agents/north-wechat", knowledgeMode: "own", agentType: "weixin_personal" });
    expect(personal.id).toBe("north-wechat");
    expect(personal.name).toBe("北区客服");
    expect(personal.instructions).toContain("负责北区客户私聊");
    expect(personal.instructions).toContain("当前 Weixin 通道不支持群聊");
    expect(personal.toolNames).not.toContain("createQuoteDraft");

    const group = loadCowAgentRole({ id: "group-sales", name: "群销售", description: "只回答库存", enabled: true, type: "wechat", workspace: "agents/group-sales", knowledgeMode: "shared", agentType: "wecom_group" });
    expect(group.instructions).toContain("企业微信群聊 Agent");
    expect(group.instructions).toContain("不要绕过 @、关键词或定时任务开关");
  });

  it("uses a local Agent's custom task without adding the internal sales role instructions", () => {
    const local = loadCowAgentRole({ id: "file-helper", name: "文件助手", description: "整理工作间中的合同文件", systemPrompt: "每条结论标明依据", enabled: true, type: "local", workspace: "agents/file-helper", knowledgeMode: "shared", roleIds: ["sales-consultant"] });
    expect(local.instructions).toContain("主要任务：整理工作间中的合同文件");
    expect(local.instructions).toContain("每条结论标明依据");
    expect(local.instructions).not.toContain("产品销售顾问");
    expect(local.instructions).not.toContain("已启用角色");
    expect(local.instructions).toContain("已授权的工作间");
    expect(local.toolNames).not.toContain("createQuoteDraft");
  });
});
