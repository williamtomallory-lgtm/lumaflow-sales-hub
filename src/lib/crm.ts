import crmSeed from "../data/crm.json";
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

export const crmCustomers = crmSeed.customers as Customer[];
export const followupTasks = crmSeed.followupTasks as FollowupTask[];

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
