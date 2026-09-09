/**
 * The small, user-facing set of Agent roles.
 *
 * This module intentionally contains presentation metadata only. Runtime
 * instructions and tool permissions live in `src/lib/ai/agent-roles.ts` so a
 * client cannot change an Agent's policy by editing the browser state.
 */

export const AGENT_ROLE_IDS = [
  "sales-consultant",
  "wechat-service",
  "sales-review",
  "moments-operator",
] as const;

export type AgentRoleId = (typeof AGENT_ROLE_IDS)[number];

export type AgentRoleOption = {
  id: AgentRoleId;
  name: string;
  eyebrow: string;
  description: string;
  useCases: readonly string[];
  inputLabel: string;
  inputPlaceholder: string;
  outputLabel: string;
  outputHint: string;
};

export const AGENT_ROLES: readonly AgentRoleOption[] = [
  {
    id: "sales-consultant",
    name: "产品销售顾问",
    eyebrow: "销售咨询",
    description: "查产品、规格、库存和资料，整理成可核对的客户回复草稿。",
    useCases: ["产品问答", "资料推荐", "库存交期"],
    inputLabel: "客户问题或销售任务",
    inputPlaceholder: "粘贴客户消息，或描述要查的产品、参数和交期…",
    outputLabel: "销售回复草稿",
    outputHint: "产品、库存和资料必须以本轮工具返回为准。",
  },
  {
    id: "wechat-service",
    name: "微信客服 Agent",
    eyebrow: "微信客服",
    description: "总结导出的聊天记录和文件，提炼需求并生成待人工确认的回复。",
    useCases: ["聊天总结", "文件梳理", "回复草稿"],
    inputLabel: "粘贴微信聊天记录",
    inputPlaceholder: "粘贴导出的聊天记录；文件请先归档到知识库后在下方选择…",
    outputLabel: "客服总结与回复草稿",
    outputHint: "桌面连接仅读取你确认的会话；不自动发送微信，回复需要人工核对。",
  },
  {
    id: "sales-review",
    name: "销售复盘 Agent",
    eyebrow: "销售复盘",
    description: "从聊天记录、需求和结果中整理过程复盘、问题与下一步行动。",
    useCases: ["过程复盘", "问题定位", "行动清单"],
    inputLabel: "粘贴本次销售记录",
    inputPlaceholder: "粘贴聊天记录、跟进纪要或订单结果，说明希望复盘的范围…",
    outputLabel: "复盘结果",
    outputHint: "复盘是辅助判断，不会自动创建任务、修改客户或发送消息。",
  },
  {
    id: "moments-operator",
    name: "朋友圈运营 Agent",
    eyebrow: "内容运营",
    description: "围绕产品和客户场景生成朋友圈运营计划与文案，不代替你发布。",
    useCases: ["选题计划", "文案草稿", "发布节奏"],
    inputLabel: "运营目标或产品素材",
    inputPlaceholder: "输入本周运营目标、产品卖点、客户场景或已有素材…",
    outputLabel: "运营计划与文案",
    outputHint: "只生成计划和文案；人工审核后由你自行发布。",
  },
] as const;

export const DEFAULT_AGENT_ROLE_ID: AgentRoleId = "sales-consultant";

export function getAgentRoleOption(id: AgentRoleId): AgentRoleOption {
  return AGENT_ROLES.find((role) => role.id === id) ?? AGENT_ROLES[0];
}

export function isAgentRoleId(value: string): value is AgentRoleId {
  return (AGENT_ROLE_IDS as readonly string[]).includes(value);
}
