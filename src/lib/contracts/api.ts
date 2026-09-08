import { z } from "zod";
import type { AppDataSnapshot } from "../data-snapshot";
import type { Product } from "../catalog";
import type { FollowupTask } from "../crm";

const nonEmptyString = z.string().trim().min(1);
const idSchema = nonEmptyString.max(120);
export const resourceIdSchema = idSchema;

export const assetSchema = z.object({
  id: idSchema,
  name: nonEmptyString.max(240),
  type: z.enum(["图片", "尺寸图", "参数表", "PDF", "证书", "案例", "视频", "说明书"]),
  size: nonEmptyString.max(80),
  version: z.string().max(40).optional(),
  updatedAt: z.string().max(80).optional(),
});

export const productSchema = z.object({
  id: idSchema,
  name: nonEmptyString.max(160),
  model: nonEmptyString.max(120),
  sku: nonEmptyString.max(120),
  category: nonEmptyString.max(80),
  family: nonEmptyString.max(120),
  status: z.enum(["在售", "低库存", "预售"]),
  power: nonEmptyString.max(80),
  lumens: nonEmptyString.max(80),
  colorTemp: nonEmptyString.max(120),
  material: nonEmptyString.max(160),
  dimensions: nonEmptyString.max(160),
  colors: z.array(nonEmptyString.max(80)).max(30),
  scenarios: z.array(nonEmptyString.max(120)).max(50),
  supplier: nonEmptyString.max(160),
  cost: z.number().finite().nonnegative(),
  priceRange: nonEmptyString.max(120),
  moq: z.number().int().nonnegative(),
  stock: z.number().int().nonnegative(),
  leadTime: nonEmptyString.max(180),
  warranty: nonEmptyString.max(180),
  description: z.string().max(2_000),
  gradient: nonEmptyString.max(300),
  accent: nonEmptyString.max(40),
  assets: z.array(assetSchema).max(200),
}) satisfies z.ZodType<Product>;

const knowledgeSchema = z.object({
  id: idSchema,
  category: z.enum(["FAQ", "销售话术", "产品知识", "公司知识", "政策", "案例", "文档解析"]),
  title: nonEmptyString.max(240),
  summary: z.string().max(2_000),
  content: z.string().max(100_000),
  tags: z.array(z.string().max(80)).max(50),
  owner: nonEmptyString.max(120),
  version: nonEmptyString.max(40),
  updatedAt: nonEmptyString.max(80),
  status: z.enum(["已发布", "待审核"]),
  reads: z.number().int().nonnegative(),
});

const customerContactSchema = z.object({
  id: idSchema,
  name: nonEmptyString.max(120),
  role: nonEmptyString.max(120),
  email: z.string().max(254),
  phone: z.string().max(60),
  preferredChannel: z.enum(["微信", "邮件", "电话", "系统记录"]),
  isPrimary: z.boolean().optional(),
});

const conversationSchema = z.object({
  id: idSchema,
  direction: z.enum(["inbound", "outbound", "internal"]),
  author: nonEmptyString.max(120),
  content: z.string().max(20_000),
  timestamp: nonEmptyString.max(80),
  channel: z.enum(["微信", "邮件", "电话", "系统记录"]),
  read: z.boolean().optional(),
});

const customerNeedSchema = z.object({
  id: idSchema,
  title: nonEmptyString.max(200),
  detail: z.string().max(5_000),
  status: z.enum(["待确认", "已确认", "已解决"]),
  priority: z.enum(["高", "中", "低"]),
  updatedAt: nonEmptyString.max(80),
});

const customerQuoteSchema = z.object({
  id: idSchema,
  quoteNo: nonEmptyString.max(120),
  productIds: z.array(idSchema).max(200),
  productNames: z.array(nonEmptyString.max(160)).max(200),
  amount: z.number().finite().nonnegative(),
  currency: z.literal("CNY"),
  status: z.enum(["草稿", "审批中", "已发送", "已接受", "已过期"]),
  createdAt: nonEmptyString.max(80),
  validUntil: nonEmptyString.max(80),
});

const customerSchema = z.object({
  id: idSchema,
  company: nonEmptyString.max(200),
  name: nonEmptyString.max(120),
  role: nonEmptyString.max(120),
  avatar: nonEmptyString.max(20),
  industry: nonEmptyString.max(120),
  location: nonEmptyString.max(200),
  stage: z.enum(["新客", "跟进中", "报价中", "已成交", "沉睡"]),
  source: nonEmptyString.max(120),
  tags: z.array(z.string().max(80)).max(50),
  email: z.string().max(254),
  phone: z.string().max(60),
  owner: nonEmptyString.max(120),
  estimatedValue: z.number().finite().nonnegative(),
  lastContactAt: nonEmptyString.max(80),
  lastContactLabel: nonEmptyString.max(120),
  unreadCount: z.number().int().nonnegative(),
  contacts: z.array(customerContactSchema).max(100),
  conversations: z.array(conversationSchema).max(5_000),
  needs: z.array(customerNeedSchema).max(500),
  quotes: z.array(customerQuoteSchema).max(1_000),
  contextMemory: z.array(z.string().max(2_000)).max(500),
});

export const followupTaskSchema = z.object({
  id: idSchema,
  customerId: idSchema,
  customerName: nonEmptyString.max(120),
  company: nonEmptyString.max(200),
  title: nonEmptyString.max(240),
  description: z.string().max(5_000),
  type: z.enum(["回复客户", "发送资料", "电话沟通", "确认需求", "报价跟进", "内部任务"]),
  priority: z.enum(["高", "中", "低"]),
  status: z.enum(["open", "completed"]),
  dueAt: nonEmptyString.max(80),
  dueLabel: nonEmptyString.max(120),
  createdAt: nonEmptyString.max(80),
  suggestedProductId: idSchema.optional(),
  suggestedAssetIds: z.array(idSchema).max(200).optional(),
}) satisfies z.ZodType<FollowupTask>;

const quoteHistorySchema = z.object({
  id: idSchema,
  customer: nonEmptyString.max(240),
  total: nonEmptyString.max(80),
  status: nonEmptyString.max(80),
  version: nonEmptyString.max(40),
  updatedAt: nonEmptyString.max(80),
});

const adminUserSchema = z.object({
  id: idSchema,
  name: nonEmptyString.max(120),
  initials: nonEmptyString.max(20),
  role: nonEmptyString.max(120),
  department: nonEmptyString.max(120),
  status: z.enum(["活跃", "已停用"]),
  lastActive: nonEmptyString.max(120),
});

const aiLogSchema = z.object({
  id: idSchema,
  user: nonEmptyString.max(120),
  action: nonEmptyString.max(160),
  input: z.string().max(10_000),
  result: z.string().max(10_000),
  status: nonEmptyString.max(80),
  time: nonEmptyString.max(80),
});

const qualityIssueSchema = z.object({
  id: idSchema,
  severity: z.enum(["高", "中", "低"]),
  field: nonEmptyString.max(160),
  subject: nonEmptyString.max(240),
  detail: z.string().max(5_000),
  owner: nonEmptyString.max(120),
});

export const dataSnapshotSchema: z.ZodType<AppDataSnapshot> = z.object({
  source: z.enum(["json", "postgres", "json-fallback"]),
  products: z.array(productSchema).min(1).max(20_000),
  knowledgeEntries: z.array(knowledgeSchema).min(1).max(100_000),
  currencyRates: z.object({ CNY: z.number().positive(), USD: z.number().positive(), CAD: z.number().positive() }),
  quoteHistory: z.array(quoteHistorySchema).max(100_000),
  adminUsers: z.array(adminUserSchema).max(100_000),
  aiLogs: z.array(aiLogSchema).max(100_000),
  qualityIssues: z.array(qualityIssueSchema).max(100_000),
  customers: z.array(customerSchema).min(1).max(100_000),
  followupTasks: z.array(followupTaskSchema).max(100_000),
});

export const dashboardSummarySchema = z.object({
  dataCompleteness: z.number().int().min(0).max(100),
  qualityIssueCount: z.number().int().nonnegative(),
  activeProducts: z.object({ value: z.number().int().nonnegative(), note: z.string() }),
  assets: z.object({ value: z.number().int().nonnegative(), note: z.string() }),
  aiEvents: z.object({ value: z.number().int().nonnegative(), note: z.string() }),
  quotations: z.object({ value: z.number().int().nonnegative(), note: z.string() }),
  activitySeries: z.array(z.object({
    label: nonEmptyString.max(40),
    value: z.number().int().nonnegative(),
  })).max(24),
  recentActivities: z.array(z.object({
    id: idSchema,
    kind: z.enum(["ai", "document", "quality"]),
    title: nonEmptyString,
    detail: z.string(),
    occurredAt: nonEmptyString,
  })).max(10),
});

export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

export const bootstrapResponseSchema = z.object({
  data: dataSnapshotSchema,
  dashboard: dashboardSummarySchema,
  meta: z.object({
    apiVersion: z.literal("v1"),
    requestId: nonEmptyString,
    generatedAt: z.string().datetime(),
    source: z.enum(["json", "postgres", "json-fallback"]),
  }),
});

export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

export const createProductSchema = productSchema.omit({ id: true });
export const updateProductSchema = productSchema.omit({ id: true }).partial().refine((value) => Object.keys(value).length > 0, "At least one field is required");
export const updateFollowupSchema = z.object({ status: z.enum(["open", "completed"]) }).strict();

export const listQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const productListQuerySchema = listQuerySchema.extend({ category: z.string().trim().max(80).optional() });
export const followupListQuerySchema = listQuerySchema.extend({ status: z.enum(["open", "completed"]).optional() });

export const assistantReasoningModeSchema = z.enum(["fast", "normal", "deep"]);

const assistantUiMessageSchema = z.object({
  id: idSchema,
  role: z.literal("user"),
  parts: z.array(z.object({
    type: z.literal("text"),
    text: z.string().trim().min(1).max(20_000),
  }).strict()).length(1),
});

export const assistantRequestSchema = z.object({
  // Until conversation history is persisted on the server, only a fresh user turn is accepted.
  // Client-supplied assistant messages and tool outputs must never become trusted model history.
  messages: z.array(assistantUiMessageSchema).length(1),
  mode: assistantReasoningModeSchema.default("normal"),
  customerId: idSchema.optional(),
});

export const assistantHealthResponseSchema = z.object({
  data: z.object({
    configured: z.boolean(),
    reachable: z.boolean(),
    provider: z.literal("vllm-openai-compatible"),
    connectionKind: z.enum(["live", "protocol-mock"]),
    model: z.string(),
    latencyMs: z.number().int().nonnegative().nullable(),
  }),
  meta: z.object({
    apiVersion: z.literal("v1"),
    requestId: nonEmptyString,
    checkedAt: z.string().datetime(),
  }),
});

export type AssistantReasoningMode = z.infer<typeof assistantReasoningModeSchema>;
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;
export type AssistantHealthResponse = z.infer<typeof assistantHealthResponseSchema>;

export type ApiErrorBody = {
  error: { code: string; message: string; details?: unknown };
  meta: { requestId: string };
};
