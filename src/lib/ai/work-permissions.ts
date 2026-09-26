import type { CowAgentProfile } from "../contracts/cowagent-agent";

export type WorkPermissions = NonNullable<CowAgentProfile["permissions"]>;
export type WorkAccess = "none" | "read" | "write" | "full";

/** Older CowAgent profiles without flags get the smallest useful Work access. */
export function workAccess(permissions?: WorkPermissions): WorkAccess {
  if (!permissions) return "read";
  if (!permissions.read) return "none";
  if (permissions.create && permissions.modify && permissions.delete && permissions.tools) return "full";
  if (permissions.create && permissions.modify) return "write";
  return "read";
}

export function assertLocalWorkAccess(profile: CowAgentProfile, needed: Exclude<WorkAccess, "none">, action: string): void {
  if (profile.type !== "local") throw new Error("微信 Agent 不能使用本机电脑工具；请选择本地 Agent。");
  assertGrantedWorkAccess(profile.permissions, needed, action);
}

/** `permissions` must come from a server-validated local profile. */
export function assertGrantedWorkAccess(permissions: WorkPermissions | undefined, needed: Exclude<WorkAccess, "none">, action: string): void {
  const actual = workAccess(permissions);
  const rank: Record<WorkAccess, number> = { none: 0, read: 1, write: 2, full: 3 };
  if (rank[actual] < rank[needed]) {
    const requirement = needed === "full" ? "完全访问" : needed === "write" ? "工作间写入或完全访问" : "只读或更高";
    throw new Error(`${action} 需要“${requirement}”权限；当前 Agent 的权限不足。请在智能体设置中调整权限后重试。`);
  }
}
