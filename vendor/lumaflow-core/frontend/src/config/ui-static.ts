/**
 * Frontend-only presentation configuration.
 *
 * Nothing in this file is business state. Product, customer, inventory,
 * quotation, activity, and analytics values must come from the backend API.
 */
export type View = "knowledge" | "agents" | "assistant" | "salesAssistant" | "customers" | "followup";

export type StaticNavItem = {
  id: View;
  label: string;
  badge?: string;
};

export const PRIMARY_NAV: readonly StaticNavItem[] = [
  { id: "knowledge", label: "知识库" },
  { id: "agents", label: "智能体" },
  { id: "assistant", label: "Chat-AI", badge: "AI" },
] as const;

export const SECONDARY_NAV: readonly StaticNavItem[] = [
  { id: "customers", label: "客户与会话" },
  { id: "followup", label: "跟进提醒" },
] as const;

export const VIEW_META: Record<View, { eyebrow: string; title: string; subtitle: string }> = {
  knowledge: { eyebrow: "统一知识库 · 产品 · 资料 · 文档", title: "所有销售知识，一个入口管理", subtitle: "产品档案、图片、参数、证书、聊天记录和上传文件统一分类、检索与可视化。" },
  agents: { eyebrow: "CowAgent · Agent Team", title: "智能体", subtitle: "创建角色、分配知识库，并把指定智能体部署到微信。" },
  assistant: { eyebrow: "Chat-AI", title: "Chat-AI", subtitle: "问答、资料检索和销售 Agent，共用本地模型。" },
  salesAssistant: { eyebrow: "Chat-AI · Work", title: "Chat-AI", subtitle: "选择 Agent，开始工作。" },
  customers: { eyebrow: "客户与会话 · 复盘 Agent", title: "让复盘 Agent 读懂每次沟通", subtitle: "客户档案、完整聊天记录与知识库文件一起交给复盘 Agent 分析。" },
  followup: { eyebrow: "销售 Todo", title: "今天要跟进什么，一眼看清", subtitle: "用待办清单管理逾期、今日、稍后和已完成的销售动作。" },
};

export const QUICK_QUESTIONS = [
  "18W 黑色轨道灯，服装店用，今天能发吗？",
  "酒店餐厅适合哪款金色吊灯？",
  "推荐一款低眩光的办公室筒灯",
] as const;

export const DASHBOARD_LABELS = {
  activeProducts: "在售产品",
  assets: "可用资料",
  aiEvents: "AI 操作记录",
  quotations: "历史报价",
} as const;
