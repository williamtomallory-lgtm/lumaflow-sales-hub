import { allAssets, products, type Asset, type Product } from "./catalog";
import { searchProducts, type SearchResult } from "./search";

export type CustomerIntent =
  | "产品咨询"
  | "资料索取"
  | "报价咨询"
  | "库存交期"
  | "方案咨询"
  | "售后支持"
  | "其他";

export type Urgency = "高" | "中" | "低";
export type CustomerStage = "新客" | "跟进中" | "报价中" | "已成交" | "沉睡";
export type ConversationDirection = "inbound" | "outbound" | "internal";
export type ConversationChannel = "微信" | "邮件" | "电话" | "系统记录";
export type FollowupPriority = "高" | "中" | "低";
export type FollowupTaskStatus = "open" | "completed";
export type FollowupFilter = "all" | "overdue" | "today" | "upcoming" | "completed";

export type CrmAsset = Asset & {
  productId: string;
  productName: string;
};

export type CustomerContact = {
  id: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  preferredChannel: ConversationChannel;
  isPrimary?: boolean;
};

export type ConversationMessage = {
  id: string;
  direction: ConversationDirection;
  author: string;
  content: string;
  timestamp: string;
  channel: ConversationChannel;
  read?: boolean;
};

export type CustomerNeed = {
  id: string;
  title: string;
  detail: string;
  status: "待确认" | "已确认" | "已解决";
  priority: FollowupPriority;
  updatedAt: string;
};

export type QuoteHistory = {
  id: string;
  quoteNo: string;
  productIds: string[];
  productNames: string[];
  amount: number;
  currency: "CNY";
  status: "草稿" | "审批中" | "已发送" | "已接受" | "已过期";
  createdAt: string;
  validUntil: string;
};

export type Customer = {
  id: string;
  company: string;
  name: string;
  role: string;
  avatar: string;
  industry: string;
  location: string;
  stage: CustomerStage;
  source: string;
  tags: string[];
  email: string;
  phone: string;
  owner: string;
  estimatedValue: number;
  lastContactAt: string;
  lastContactLabel: string;
  unreadCount: number;
  contacts: CustomerContact[];
  conversations: ConversationMessage[];
  needs: CustomerNeed[];
  quotes: QuoteHistory[];
  contextMemory: string[];
};

export type ProductRecommendation = {
  product: Product;
  score: number;
  reasons: string[];
};

export type CustomerMessageAnalysis = {
  message: string;
  summary: string;
  intent: CustomerIntent;
  intentLabel: string;
  urgency: Urgency;
  urgencyReason: string;
  confidence: number;
  signals: string[];
  recommendedProducts: ProductRecommendation[];
  recommendedAssets: CrmAsset[];
  replyDraft: string;
};

export type FollowupTask = {
  id: string;
  customerId: string;
  customerName: string;
  company: string;
  title: string;
  description: string;
  type: "回复客户" | "发送资料" | "电话沟通" | "确认需求" | "报价跟进" | "内部任务";
  priority: FollowupPriority;
  status: FollowupTaskStatus;
  dueAt: string;
  dueLabel: string;
  createdAt: string;
  suggestedProductId?: string;
  suggestedAssetIds?: string[];
};

export type FollowupMessageContext = Pick<Customer, "name" | "company" | "stage" | "contextMemory">;

const intentRules: ReadonlyArray<{
  intent: CustomerIntent;
  keywords: string[];
  label: string;
}> = [
  { intent: "资料索取", keywords: ["资料", "参数", "规格", "证书", "pdf", "图片", "案例", "说明书"], label: "资料 / 附件" },
  { intent: "库存交期", keywords: ["库存", "现货", "发货", "交期", "到货", "什么时候能", "今天能", "几天"], label: "库存 / 交期" },
  { intent: "报价咨询", keywords: ["报价", "价格", "多少钱", "费用", "预算", "折扣", "单价", "成本"], label: "报价 / 预算" },
  { intent: "售后支持", keywords: ["售后", "质保", "退换", "坏了", "维修", "安装问题", "故障"], label: "售后支持" },
  { intent: "方案咨询", keywords: ["方案", "怎么选", "推荐", "适合", "搭配", "设计", "项目"], label: "方案 / 选型" },
  { intent: "产品咨询", keywords: ["产品", "型号", "功率", "灯", "色温", "材质", "尺寸", "显色"], label: "产品参数" },
];

const highUrgencyKeywords = ["紧急", "急", "马上", "尽快", "今天", "明天", "来不及", "立刻", "截止"];
const mediumUrgencyKeywords = ["本周", "这周", "最近", "几天内", "尽快确认", "计划"];

export const crmCustomers: Customer[] = [
  {
    id: "cust-nova",
    company: "NOVA 空间设计",
    name: "陈经理",
    role: "采购负责人",
    avatar: "陈",
    industry: "商业空间",
    location: "上海 · 静安",
    stage: "报价中",
    source: "展会线索",
    tags: ["重点客户", "服装店", "设计公司"],
    email: "chen.manager@example.com",
    phone: "+86 138 0000 2188",
    owner: "Junjun Hu",
    estimatedValue: 48600,
    lastContactAt: "2026-09-04T13:48:00+08:00",
    lastContactLabel: "今天 13:48",
    unreadCount: 2,
    contacts: [
      { id: "nova-chen", name: "陈经理", role: "采购负责人", email: "chen.manager@example.com", phone: "+86 138 0000 2188", preferredChannel: "微信", isPrimary: true },
      { id: "nova-li", name: "李工", role: "项目设计师", email: "li.design@example.com", phone: "+86 139 0000 1024", preferredChannel: "邮件" },
    ],
    conversations: [
      { id: "nova-m4", direction: "inbound", author: "陈经理", content: "我们静安店下周要进场，想确认 18W 黑色轨道灯有没有现货，能不能今天发？另外把参数表和黑色场景图一起发我。", timestamp: "2026-09-04T13:48:00+08:00", channel: "微信", read: false },
      { id: "nova-m3", direction: "outbound", author: "Junjun Hu", content: "收到，我先帮您确认库存和最快交期，参数表、场景图也一并整理。", timestamp: "2026-09-04T13:36:00+08:00", channel: "微信", read: true },
      { id: "nova-m2", direction: "inbound", author: "陈经理", content: "上次提到的预算区间可以先按 40 套估算。", timestamp: "2026-09-03T16:21:00+08:00", channel: "微信", read: true },
      { id: "nova-m1", direction: "internal", author: "系统记录", content: "客户偏好：黑色、窄光束、显色指数高；项目节点紧，需先给可执行交期。", timestamp: "2026-09-03T16:30:00+08:00", channel: "系统记录", read: true },
    ],
    needs: [
      { id: "nova-need-1", title: "确认 ARC T18 现货", detail: "约 40 套，黑色，静安门店下周进场", status: "已确认", priority: "高", updatedAt: "2026-09-04T13:48:00+08:00" },
      { id: "nova-need-2", title: "发送参数与场景资料", detail: "需要参数表和黑色服装店案例图", status: "待确认", priority: "中", updatedAt: "2026-09-04T13:48:00+08:00" },
    ],
    quotes: [
      { id: "quote-nova-2", quoteNo: "QT-20260903-018", productIds: ["arc-t18", "beam-s30"], productNames: ["Arc 轨道射灯", "Beam 深防眩筒灯"], amount: 48600, currency: "CNY", status: "审批中", createdAt: "2026-09-03", validUntil: "2026-09-10" },
      { id: "quote-nova-1", quoteNo: "QT-20260828-011", productIds: ["arc-t18"], productNames: ["Arc 轨道射灯"], amount: 11560, currency: "CNY", status: "已过期", createdAt: "2026-08-28", validUntil: "2026-09-02" },
    ],
    contextMemory: ["项目是 80㎡ 服装店，预计下周进场", "陈经理更习惯微信沟通，上午 10:00–12:00 回复较快", "预算按 40 套先估算，价格需走审批", "优先关注黑色、显色和交期"],
  },
  {
    id: "cust-atelier",
    company: "Atelier 27 酒店",
    name: "王总监",
    role: "餐饮运营总监",
    avatar: "王",
    industry: "酒店餐饮",
    location: "杭州 · 西湖",
    stage: "跟进中",
    source: "官网咨询",
    tags: ["酒店", "餐厅", "高客单"],
    email: "wang.ops@example.com",
    phone: "+86 137 0000 6681",
    owner: "Junjun Hu",
    estimatedValue: 32800,
    lastContactAt: "2026-09-03T10:15:00+08:00",
    lastContactLabel: "昨天 10:15",
    unreadCount: 0,
    contacts: [{ id: "atelier-wang", name: "王总监", role: "餐饮运营总监", email: "wang.ops@example.com", phone: "+86 137 0000 6681", preferredChannel: "邮件", isPrimary: true }],
    conversations: [
      { id: "atelier-m3", direction: "inbound", author: "王总监", content: "餐厅希望做暖一点的氛围，金色环形吊灯有现场效果图和规格书吗？", timestamp: "2026-09-03T10:15:00+08:00", channel: "邮件", read: true },
      { id: "atelier-m2", direction: "outbound", author: "Junjun Hu", content: "有的，我会把 HALO P36 的空间应用图和规格书整理给您，也可以按餐桌尺寸建议数量。", timestamp: "2026-09-03T10:32:00+08:00", channel: "邮件", read: true },
      { id: "atelier-m1", direction: "internal", author: "系统记录", content: "偏好暖色、香槟金，关注餐桌上方的眩光控制。", timestamp: "2026-09-03T10:40:00+08:00", channel: "系统记录", read: true },
    ],
    needs: [{ id: "atelier-need-1", title: "确认吊灯尺寸与数量", detail: "需收集餐桌长度、层高和安装点位", status: "待确认", priority: "中", updatedAt: "2026-09-03T10:15:00+08:00" }],
    quotes: [{ id: "quote-atelier-1", quoteNo: "QT-20260901-006", productIds: ["halo-p36"], productNames: ["Halo 环形吊灯"], amount: 16182, currency: "CNY", status: "已发送", createdAt: "2026-09-01", validUntil: "2026-09-08" }],
    contextMemory: ["餐厅翻新计划 10 月开业", "偏好暖色和香槟金，不希望灯具压低层高", "下一步先确认餐桌尺寸，再给数量建议"],
  },
  {
    id: "cust-northstar",
    company: "Northstar 联合办公",
    name: "赵工",
    role: "工程采购",
    avatar: "赵",
    industry: "办公空间",
    location: "深圳 · 南山",
    stage: "新客",
    source: "老客转介绍",
    tags: ["办公室", "批量采购"],
    email: "zhao.engineering@example.com",
    phone: "+86 136 0000 9042",
    owner: "Junjun Hu",
    estimatedValue: 19200,
    lastContactAt: "2026-09-02T15:20:00+08:00",
    lastContactLabel: "9 月 2 日",
    unreadCount: 1,
    contacts: [{ id: "northstar-zhao", name: "赵工", role: "工程采购", email: "zhao.engineering@example.com", phone: "+86 136 0000 9042", preferredChannel: "电话", isPrimary: true }],
    conversations: [
      { id: "northstar-m2", direction: "inbound", author: "赵工", content: "办公室层高 2.8 米，想找低眩光筒灯，先给我两款参数和大概价格。", timestamp: "2026-09-02T15:20:00+08:00", channel: "电话", read: false },
      { id: "northstar-m1", direction: "internal", author: "系统记录", content: "待确认吊顶开孔尺寸、数量和色温。", timestamp: "2026-09-02T15:30:00+08:00", channel: "系统记录", read: true },
    ],
    needs: [{ id: "northstar-need-1", title: "收集项目参数", detail: "吊顶开孔、数量、色温和预计进场日期", status: "待确认", priority: "高", updatedAt: "2026-09-02T15:20:00+08:00" }],
    quotes: [],
    contextMemory: ["首次联系，来自老客户推荐", "办公室层高 2.8 米，明确关注低眩光", "需要先给两款可比较的选项"],
  },
  {
    id: "cust-moss",
    company: "Moss 民宿集团",
    name: "林女士",
    role: "品牌负责人",
    avatar: "林",
    industry: "文旅住宿",
    location: "大理 · 苍山",
    stage: "已成交",
    source: "案例内容",
    tags: ["民宿", "户外", "复购机会"],
    email: "lin.brand@example.com",
    phone: "+86 135 0000 7719",
    owner: "Junjun Hu",
    estimatedValue: 8600,
    lastContactAt: "2026-08-30T11:02:00+08:00",
    lastContactLabel: "8 月 30 日",
    unreadCount: 0,
    contacts: [{ id: "moss-lin", name: "林女士", role: "品牌负责人", email: "lin.brand@example.com", phone: "+86 135 0000 7719", preferredChannel: "微信", isPrimary: true }],
    conversations: [
      { id: "moss-m2", direction: "inbound", author: "林女士", content: "上一批壁灯安装效果不错，秋季新店还需要 18 套，预计月底前到。", timestamp: "2026-08-30T11:02:00+08:00", channel: "微信", read: true },
      { id: "moss-m1", direction: "outbound", author: "Junjun Hu", content: "已为您记录复购需求，MOSS O8 目前是预售批次，我会在到仓后第一时间提醒。", timestamp: "2026-08-30T11:18:00+08:00", channel: "微信", read: true },
    ],
    needs: [{ id: "moss-need-1", title: "跟踪 MOSS O8 到仓", detail: "18 套，预计 9 月 18 日到仓", status: "已确认", priority: "中", updatedAt: "2026-08-30T11:18:00+08:00" }],
    quotes: [{ id: "quote-moss-1", quoteNo: "QT-20260830-003", productIds: ["moss-o8"], productNames: ["Moss 户外壁灯"], amount: 5922, currency: "CNY", status: "已接受", createdAt: "2026-08-30", validUntil: "2026-09-06" }],
    contextMemory: ["已有一批 MOSS O8 成交，客户认可安装效果", "秋季新店预计月底前到货", "目前批次为预售，预计 9 月 18 日到仓"],
  },
];

export const followupTasks: FollowupTask[] = [
  { id: "task-nova-reply", customerId: "cust-nova", customerName: "陈经理", company: "NOVA 空间设计", title: "回复库存与交期，并发送资料", description: "客户询问 ARC T18 黑色现货，需同时附参数表和黑色场景图。", type: "回复客户", priority: "高", status: "open", dueAt: "2026-09-04T14:15:00+08:00", dueLabel: "今天 14:15", createdAt: "2026-09-04T13:48:00+08:00", suggestedProductId: "arc-t18", suggestedAssetIds: ["arc-image", "arc-spec"] },
  { id: "task-northstar-need", customerId: "cust-northstar", customerName: "赵工", company: "Northstar 联合办公", title: "确认办公室项目参数", description: "补充吊顶开孔、数量、色温和预计进场日期。", type: "确认需求", priority: "高", status: "open", dueAt: "2026-09-04T17:00:00+08:00", dueLabel: "今天 17:00", createdAt: "2026-09-02T15:30:00+08:00" },
  { id: "task-atelier-assets", customerId: "cust-atelier", customerName: "王总监", company: "Atelier 27 酒店", title: "发送 HALO P36 应用资料", description: "发送空间应用图与规格书，并询问餐桌尺寸。", type: "发送资料", priority: "中", status: "open", dueAt: "2026-09-05T10:00:00+08:00", dueLabel: "明天 10:00", createdAt: "2026-09-03T10:40:00+08:00", suggestedProductId: "halo-p36", suggestedAssetIds: ["halo-image", "halo-spec"] },
  { id: "task-moss-stock", customerId: "cust-moss", customerName: "林女士", company: "Moss 民宿集团", title: "提醒 MOSS O8 到仓", description: "预售批次预计 9 月 18 日到仓，到仓后跟进 18 套复购。", type: "报价跟进", priority: "中", status: "open", dueAt: "2026-09-18T09:00:00+08:00", dueLabel: "9 月 18 日", createdAt: "2026-08-30T11:18:00+08:00", suggestedProductId: "moss-o8" },
  { id: "task-nova-quote", customerId: "cust-nova", customerName: "陈经理", company: "NOVA 空间设计", title: "跟进 QT-20260903-018 审批", description: "确认折扣审批结果，再给客户发送正式报价。", type: "内部任务", priority: "高", status: "open", dueAt: "2026-09-03T18:00:00+08:00", dueLabel: "已逾期 1 天", createdAt: "2026-09-03T16:30:00+08:00" },
  { id: "task-atelier-call", customerId: "cust-atelier", customerName: "王总监", company: "Atelier 27 酒店", title: "电话确认餐桌点位", description: "确认吊灯数量、层高与安装点位，便于出方案。", type: "电话沟通", priority: "低", status: "completed", dueAt: "2026-09-02T16:00:00+08:00", dueLabel: "已完成 · 9 月 2 日", createdAt: "2026-09-01T09:20:00+08:00", suggestedProductId: "halo-p36" },
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s，。？！、/\\\-_:：；;（）()]+/g, "");
}

function includesAny(value: string, keywords: readonly string[]): string[] {
  return keywords.filter((keyword) => value.includes(normalize(keyword)));
}

function formatCurrency(amount: number): string {
  return `¥${amount.toLocaleString("zh-CN")}`;
}

function pickIntent(message: string): { intent: CustomerIntent; label: string; matched: string[] } {
  const normalized = normalize(message);
  const candidates = intentRules.map((rule) => ({ ...rule, matched: includesAny(normalized, rule.keywords) }));
  candidates.sort((a, b) => b.matched.length - a.matched.length);
  const winner = candidates[0];
  if (!winner || winner.matched.length === 0) return { intent: "其他", label: "待人工判断", matched: [] };
  return { intent: winner.intent, label: winner.label, matched: winner.matched };
}

function pickUrgency(message: string): { urgency: Urgency; reason: string; matched: string[] } {
  const normalized = normalize(message);
  const high = includesAny(normalized, highUrgencyKeywords);
  if (high.length > 0) return { urgency: "高", reason: `出现“${high.slice(0, 2).join("、")}”等时限信号`, matched: high };
  const medium = includesAny(normalized, mediumUrgencyKeywords);
  if (medium.length > 0) return { urgency: "中", reason: `有“${medium.slice(0, 2).join("、")}”的计划性要求`, matched: medium };
  return { urgency: "低", reason: "暂未识别到明确截止时间，可按常规节奏跟进", matched: [] };
}

function recommendationReasons(result: SearchResult): string[] {
  const reasons = result.matches.slice(0, 4);
  return reasons.length > 0 ? reasons : ["与客户描述的产品方向匹配"];
}

export function recommendProductsForMessage(message: string, sourceProducts: Product[] = products): ProductRecommendation[] {
  if (!message.trim()) return [];
  return searchProducts(message, sourceProducts)
    .slice(0, 3)
    .map((result) => ({ product: result.product, score: result.score, reasons: recommendationReasons(result) }));
}

export function recommendAssetsForProducts(productRecommendations: ProductRecommendation[], limit = 6, sourceAssets: CrmAsset[] = allAssets): CrmAsset[] {
  if (limit <= 0 || productRecommendations.length === 0) return [];
  const productRank = new Map(productRecommendations.map((recommendation, index) => [recommendation.product.id, index]));
  const preferredTypes: CrmAsset["type"][] = ["图片", "尺寸图", "参数表", "证书", "案例", "视频", "说明书", "PDF"];
  return sourceAssets
    .filter((asset) => productRank.has(asset.productId))
    .sort((a, b) => {
      const productOrder = (productRank.get(a.productId) ?? 99) - (productRank.get(b.productId) ?? 99);
      const typeOrder = preferredTypes.indexOf(a.type) - preferredTypes.indexOf(b.type);
      return productOrder || typeOrder || a.name.localeCompare(b.name, "zh-CN");
    })
    .slice(0, limit);
}

function composeReplyDraft(message: string, intent: CustomerIntent, recommendations: ProductRecommendation[], customerName?: string): string {
  const greeting = customerName ? `您好，${customerName}！` : "您好！";
  const lead = recommendations[0];
  if (!lead) {
    return `${greeting}\n\n收到您的消息了。我先帮您确认合适的产品和资料。为了给出准确建议，麻烦补充一下使用场景、数量、尺寸或希望的到货时间。\n\n确认后我会尽快回复您。`;
  }
  const { product } = lead;
  const stock = product.stock > 0 ? `当前库存 ${product.stock} 件，${product.leadTime}` : `目前为预售，${product.leadTime}`;
  const price = intent === "报价咨询" ? `参考报价 ${product.priceRange}，正式价格需按数量和折扣权限审批。` : `参考报价 ${product.priceRange}，起订量 ${product.moq} 件。`;
  const request = intent === "资料索取" ? "我会同时附上产品图片、参数表和相关证明资料。" : "如需按现场尺寸细化数量，我可以继续帮您核对。";
  return `${greeting}\n\n根据您提到的需求，建议先看 ${product.name}（${product.model}）：${product.power}，${product.material}，${product.colorTemp}，适合${product.scenarios.slice(0, 3).join("、")}。${stock}。${price}\n\n${request}\n如果您确认数量和收货时间，我可以继续为您整理下一步方案。`;
}

export function analyzeCustomerMessage(message: string, customerName?: string, sourceProducts: Product[] = products, sourceAssets: CrmAsset[] = allAssets): CustomerMessageAnalysis {
  const cleanMessage = message.trim();
  const { intent, label, matched: intentSignals } = pickIntent(cleanMessage);
  const { urgency, reason: urgencyReason, matched: urgencySignals } = pickUrgency(cleanMessage);
  const recommendedProducts = recommendProductsForMessage(cleanMessage, sourceProducts);
  const recommendedAssets = recommendAssetsForProducts(recommendedProducts, 6, sourceAssets);
  const signals = [...new Set([...intentSignals.map((signal) => `意图：${signal}`), ...urgencySignals.map((signal) => `时限：${signal}`)])];
  const confidence = cleanMessage.length === 0 ? 0 : Math.min(98, 54 + (recommendedProducts.length > 0 ? 22 : 0) + Math.min(16, signals.length * 4) + (intent === "其他" ? 0 : 6));
  const summary = cleanMessage.length > 64 ? `${cleanMessage.slice(0, 64)}…` : cleanMessage || "等待输入客户消息";
  return {
    message: cleanMessage,
    summary,
    intent,
    intentLabel: label,
    urgency,
    urgencyReason,
    confidence,
    signals,
    recommendedProducts,
    recommendedAssets,
    replyDraft: composeReplyDraft(cleanMessage, intent, recommendedProducts, customerName),
  };
}

export function searchCustomers(query: string, sourceCustomers: Customer[] = crmCustomers): Customer[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [...sourceCustomers];
  return sourceCustomers
    .map((customer) => {
      const haystack = normalize([
        customer.company,
        customer.name,
        customer.role,
        customer.industry,
        customer.location,
        customer.stage,
        customer.source,
        ...customer.tags,
        ...(customer.unreadCount > 0 ? ["未读"] : []),
        ...customer.needs.map((need) => `${need.title}${need.detail}`),
        ...customer.contextMemory,
      ].join(" "));
      const exactName = normalize(customer.name) === normalizedQuery;
      const score = exactName ? 100 : haystack.includes(normalizedQuery) ? 50 : 0;
      return { customer, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.customer.estimatedValue - a.customer.estimatedValue)
    .map(({ customer }) => customer);
}

export function getCustomerById(customerId: string, sourceCustomers: Customer[] = crmCustomers): Customer | undefined {
  return sourceCustomers.find((customer) => customer.id === customerId);
}

export function getLatestInboundMessage(customer: Customer): ConversationMessage | undefined {
  return customer.conversations
    .filter((message) => message.direction === "inbound")
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
}

export function isTaskOverdue(task: FollowupTask, referenceDate: Date | string = new Date()): boolean {
  if (task.status === "completed") return false;
  return new Date(task.dueAt).getTime() < new Date(referenceDate).getTime();
}

function dateKey(value: Date | string): string {
  if (typeof value === "string") {
    const isoDate = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (isoDate) return isoDate;
  }
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function filterFollowupTasks(tasks: FollowupTask[], filter: FollowupFilter = "all", query = "", referenceDate: Date | string = new Date()): FollowupTask[] {
  const normalizedQuery = normalize(query);
  const reference = new Date(referenceDate);
  const today = dateKey(reference);
  return tasks
    .filter((task) => {
      const queryMatch = !normalizedQuery || normalize(`${task.customerName}${task.company}${task.title}${task.description}${task.type}`).includes(normalizedQuery);
      if (!queryMatch) return false;
      if (filter === "completed") return task.status === "completed";
      if (filter === "overdue") return isTaskOverdue(task, reference);
      if (filter === "today") return task.status === "open" && dateKey(task.dueAt) === today;
      if (filter === "upcoming") return task.status === "open" && !isTaskOverdue(task, reference) && dateKey(task.dueAt) !== today;
      return true;
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
      const overdueOrder = Number(isTaskOverdue(a, reference)) - Number(isTaskOverdue(b, reference));
      if (overdueOrder !== 0) return -overdueOrder;
      return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    });
}

export function toggleFollowupTask(tasks: FollowupTask[], taskId: string, completed?: boolean): FollowupTask[] {
  return tasks.map((task) => {
    if (task.id !== taskId) return task;
    const nextCompleted = completed ?? task.status !== "completed";
    return {
      ...task,
      status: nextCompleted ? "completed" : "open",
      dueLabel: nextCompleted
        ? `已完成 · ${task.dueLabel.replace(/^已逾期\s*/, "")}`
        : task.dueLabel.replace(/^已完成\s*·\s*/, ""),
    };
  });
}

export function buildFollowupMessage(task: FollowupTask, customer?: FollowupMessageContext): string {
  const name = customer?.name ?? task.customerName;
  const greeting = `您好，${name}！`;
  switch (task.type) {
    case "发送资料":
      return `${greeting}\n\n补充发您 ${task.title.replace(/^发送\s*/, "")}，里面包含产品图片和规格信息，您可以先确认尺寸与应用效果。若方便，也请告诉我现场的层高和安装点位，我再帮您核对数量。`;
    case "确认需求":
      return `${greeting}\n\n为了给您推荐更准确的方案，想再确认一下项目的数量、色温、吊顶开孔尺寸和预计进场日期。信息齐了之后，我可以把两款方案和参考报价一起整理给您。`;
    case "电话沟通":
      return `${greeting}\n\n想和您电话确认一下项目细节，主要是安装点位、数量和交期。您今天哪个时间段方便？我可以按您的时间拨打。`;
    case "报价跟进":
      return `${greeting}\n\n跟进一下前面提到的方案，想确认目前数量和到货时间是否有变化。如果需求不变，我可以继续帮您锁定库存并更新参考报价。`;
    case "内部任务":
      return `${greeting}\n\n您的方案还在内部确认中，我会在审批结果出来后第一时间同步正式报价。期间如果数量或交期有变化，也可以直接告诉我。`;
    case "回复客户":
    default:
      return `${greeting}\n\n看到您的消息了，我正在帮您确认库存、交期和匹配资料。确认后我会把可直接查看的产品信息一起发给您。`;
  }
}

export function formatQuoteAmount(amount: number): string {
  return formatCurrency(amount);
}
