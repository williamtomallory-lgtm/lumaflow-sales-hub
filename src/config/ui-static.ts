/**
 * Frontend-only presentation configuration.
 *
 * Nothing in this file is business state. Product, customer, inventory,
 * quotation, activity, and analytics values must come from the backend API.
 */
export type View = "overview" | "products" | "assets" | "knowledge" | "assistant" | "kit" | "salesAssistant" | "customers" | "quotation" | "followup" | "admin";

export type StaticNavItem = {
  id: View;
  label: string;
  badge?: string;
};

export const PRIMARY_NAV: readonly StaticNavItem[] = [
  { id: "overview", label: "工作台" },
  { id: "products", label: "产品中心" },
  { id: "assets", label: "资料中心" },
  { id: "knowledge", label: "知识库" },
  { id: "assistant", label: "智能搜索", badge: "AI" },
  { id: "kit", label: "销售资料包" },
  { id: "salesAssistant", label: "销售助手", badge: "AI" },
] as const;

export const SECONDARY_NAV: readonly StaticNavItem[] = [
  { id: "customers", label: "客户与会话" },
  { id: "quotation", label: "报价系统" },
  { id: "followup", label: "跟进提醒" },
  { id: "admin", label: "管理后台" },
] as const;

export const VIEW_META: Record<View, { eyebrow: string; title: string; subtitle: string }> = {
  overview: { eyebrow: "销售工作台", title: "下午好，Junjun", subtitle: "这里是今天最值得你关注的产品与销售资料。" },
  products: { eyebrow: "产品中心", title: "把每个型号讲清楚", subtitle: "型号、参数、场景、库存和资料都在同一个视图里。" },
  assets: { eyebrow: "资料中心", title: "找到，选中，直接发", subtitle: "按产品归档的最新图片、参数表、证书与案例。" },
  knowledge: { eyebrow: "知识库", title: "把团队经验变成共同资产", subtitle: "统一管理 FAQ、销售话术、产品知识、政策、案例和解析文档。" },
  assistant: { eyebrow: "智能搜索 · 本地 Agent", title: "选择模型，查询产品与资料", subtitle: "文字问题发送到所选模型；产品、库存和资料引用来自本轮后端工具调用。" },
  kit: { eyebrow: "销售资料包", title: "十秒拼好一套客户资料", subtitle: "选择产品与附件，生成推荐话术并下载交付清单。" },
  salesAssistant: { eyebrow: "销售助手", title: "读懂客户，再给出可审核的回复", subtitle: "识别客户意图，推荐产品与附件，生成可编辑、确认后待发送的回复。" },
  customers: { eyebrow: "客户与会话", title: "每次沟通都带着完整上下文", subtitle: "客户档案、联系人、需求、聊天、历史报价和记忆统一管理。" },
  quotation: { eyebrow: "报价系统 · CPQ", title: "准确报价，也能快速推进", subtitle: "价格阶梯、折扣、币种、审批、PDF 与版本历史完整联动。" },
  followup: { eyebrow: "跟进系统", title: "不错过该推进的客户", subtitle: "未回复提醒、下一步行动、自动话术和销售任务集中处理。" },
  admin: { eyebrow: "管理后台", title: "让知识、权限和 AI 持续可信", subtitle: "用户权限、数据质量、AI 日志、使用统计与效果评估。" },
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

/**
 * Authentication is not connected in the demo, so this identity is an
 * intentional UI fixture rather than customer, catalog, or operational data.
 */
export const DEMO_PROFILE = {
  initials: "JH",
  name: "Junjun Hu",
  role: "销售顾问",
} as const;
