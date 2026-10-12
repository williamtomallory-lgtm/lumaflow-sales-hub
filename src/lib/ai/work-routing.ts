import "server-only";

import { z } from "zod";

/**
 * The router only accepts capability metadata that was resolved by the
 * server.  In particular, an arbitrary tool name submitted by a browser must
 * never become a reason to install the sales tools.
 */
export type WorkRoutingAgent = {
  id?: string;
  type?: string;
  agentType?: string;
  roleIds?: readonly string[];
  toolNames?: readonly string[];
  capabilities?: readonly string[];
};

export type WorkRoutingInput = {
  text: string;
  agent?: WorkRoutingAgent | null;
};

export type WorkDomain = "general" | "sales";

type SalesIntent = "product" | "lighting" | "quote" | "inventory";

const MAX_SAFE_SUMMARY_CHARACTERS = 280;
const TYPESAFE_ROUTING_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_MIN_PROBABILITY = 0.72;

const roleCapabilities: Record<string, readonly SalesIntent[]> = {
  "sales-consultant": ["product", "lighting", "quote", "inventory"],
  "wechat-service": ["product", "lighting", "inventory"],
  "sales-review": ["product", "lighting", "inventory"],
  "moments-operator": ["product", "lighting"],
};

const toolCapabilities: Record<string, readonly SalesIntent[]> = {
  searchproducts: ["product", "lighting"],
  getproductdetails: ["product", "lighting"],
  getproductassets: ["product", "lighting"],
  checkinventory: ["inventory"],
  createquotedraft: ["quote"],
};

const namedCapabilities: Record<string, readonly SalesIntent[]> = {
  sales: ["product", "lighting", "quote", "inventory"],
  product: ["product", "lighting"],
  products: ["product", "lighting"],
  productcatalog: ["product", "lighting"],
  lighting: ["product", "lighting"],
  quote: ["quote"],
  quotedraft: ["quote"],
  inventory: ["inventory"],
  stock: ["inventory"],
};

const choiceResponseSchema = z.object({
  answers: z.object({
    domain: z.object({
      type: z.literal("choice"),
      choice: z.string(),
      probabilities: z.record(z.string(), z.number()),
    }),
  }),
});

const generalPriorityPatterns = [
  /(?:\b(?:code|coding|program|programming|debug|bug|repository|repo|git|npm|node(?:\.js)?|python|typescript|javascript|html|css|api|script|function|class|test|build|compile|deploy|shell|powershell|frontend|backend|website|webpage)\b|编程|代码|写代码|修复(?:代码|bug|漏洞)|调试|开发|实现(?:功能|接口|程序)|仓库|项目|脚本|函数|类|测试|构建|编译|部署|命令行|终端|前端|后端|网页|网站|程序|应用)/i,
  /(?:整理|归类|分类|重命名|改名|移动|复制|删除|保存|写入|修改|读取|读回|列出|查找).{0,16}(?:文件|文件夹|目录|资料|文档|表格|工作区|路径)/i,
  /(?:文件|文件夹|目录|资料|文档|表格|工作区|路径).{0,16}(?:整理|归类|分类|重命名|改名|移动|复制|删除|保存|写入|修改|读取|读回|列出|查找)/i,
];

const lightingPatterns = /(?:灯具?|灯饰|照明|吸顶灯|吊灯|射灯|筒灯|轨道灯|壁灯|台灯|落地灯|灯带|光源)/i;
const productPatterns = /(?:产品|商品|sku|型号|货号|选型|规格|参数|色温|功率|材质|尺寸|款式|product|item|model|specification)/i;
const quotePatterns = /(?:报价|报价单|询价|价格|单价|折扣|quote|price)/i;
const inventoryPatterns = /(?:库存|现货|缺货|库存量|库存状态|余量|存量|stock|inventory|availability|交期|交货期|货期|发货|lead\s*time)/i;
const possibleSalesPatterns = /(?:产品|商品|sku|型号|货号|款|款式|灯|照明|规格|报价|询价|库存|现货|交期|product|item|model|quote|stock|inventory)/i;
const unsafeContextPatterns = /(?:附件|图片|截图|文件正文|原文|正文|知识库|工具回执|工具输出|回执|stdout|stderr|receipt|base64|data:image|上传|下载|日志|traceback|stack trace|以下(?:内容|正文)|全文)/i;

function normalize(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function compactCapability(value: string) {
  return normalize(value).toLowerCase().replace(/[\s_-]+/g, "");
}

function agentCapabilitySet(agent: WorkRoutingAgent | null | undefined) {
  const capabilities = new Set<SalesIntent>();
  if (!agent || (agent.type && agent.type !== "local") || agent.agentType === "weixin_personal" || agent.agentType === "wecom_group") {
    return capabilities;
  }

  for (const roleId of agent.roleIds ?? []) {
    for (const capability of roleCapabilities[roleId] ?? []) capabilities.add(capability);
  }
  for (const toolName of agent.toolNames ?? []) {
    for (const capability of toolCapabilities[compactCapability(toolName)] ?? []) capabilities.add(capability);
  }
  for (const capabilityName of agent.capabilities ?? []) {
    for (const capability of namedCapabilities[compactCapability(capabilityName)] ?? []) capabilities.add(capability);
  }
  return capabilities;
}

function hasCapability(agent: WorkRoutingAgent | null | undefined, intent: SalesIntent) {
  return agentCapabilitySet(agent).has(intent);
}

function detectSalesIntent(text: string): SalesIntent | undefined {
  if (quotePatterns.test(text)) return "quote";
  if (inventoryPatterns.test(text)) return "inventory";
  if (lightingPatterns.test(text)) return "lighting";
  if (productPatterns.test(text)) return "product";
  return undefined;
}

function isGeneralPriorityTask(text: string) {
  return generalPriorityPatterns.some((pattern) => pattern.test(text));
}

/**
 * A summary is deliberately conservative.  If the caller gives us a pasted
 * document, attachment marker, path, log, or multi-line body, Jev is skipped
 * and the local decision remains authoritative.  This is a boundary check,
 * not a claim that arbitrary text can be perfectly classified as a summary.
 */
function safeTaskSummary(text: string): string | undefined {
  const summary = normalize(text);
  if (!summary || summary.length > MAX_SAFE_SUMMARY_CHARACTERS || /[\r\n]/.test(text)) return undefined;
  if (unsafeContextPatterns.test(summary)) return undefined;
  if (/```|[{}\[\]<>]|(?:https?:\/\/|file:\/\/|[A-Za-z]:[\\/]|\\\\|\/(?:home|users|tmp|workspace)(?:[\\/]|$))/i.test(summary)) return undefined;
  if (!/(?:请|帮我|需要|查询|查|看看|找|推荐|比较|选择|确认|核对|介绍|生成|计算|判断|是否|有没有|show|find|check|search|recommend|compare|identify|lookup)/i.test(summary)) return undefined;
  return summary.replace(/^(?:任务摘要|任务|请求)\s*[:：]\s*/i, "").trim() || undefined;
}

function canUseTypeSafe() {
  return process.env.TYPESAFE_WORK_ROUTING === "true" && Boolean(process.env.TYPESAFE_API_KEY?.trim());
}

async function chooseWithTypeSafe(summary: string, agent: WorkRoutingAgent): Promise<WorkDomain | undefined> {
  if (!canUseTypeSafe()) return undefined;
  const capabilities = [...agentCapabilitySet(agent)].sort();
  if (!capabilities.length) return undefined;

  try {
    const response = await fetch(TYPESAFE_ROUTING_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY!.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "jev-latest",
        // This state intentionally contains only the bounded task summary and
        // capability labels. It never includes attachments, file正文, tools,
        // receipts, knowledge documents, or the Agent's private ID.
        state: { task_summary: summary, available_work_capabilities: capabilities },
        questions: {
          domain: {
            type: "choice",
            instructions: "仅根据 task_summary 选择工作域。编程、代码、文件整理和电脑文件操作属于 general；只有真实产品、灯饰、报价或库存查询属于 sales。证据不足时选择 general。",
            criteria: {
              general: "编程、代码、文件整理、文档处理或其他普通本机任务",
              sales: "明确的灯饰、真实产品、报价或库存查询，且可用能力支持该业务任务",
            },
          },
        },
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return undefined;
    const parsed = choiceResponseSchema.parse(await response.json()).answers.domain;
    if (parsed.choice !== "sales" || (parsed.probabilities.sales ?? 0) < TYPESAFE_MIN_PROBABILITY) return "general";
    return "sales";
  } catch {
    // Optional routing must never make local Work unavailable.
    return undefined;
  }
}

/**
 * Choose the least-privileged Work tool domain.  Local deterministic routing
 * is the default; the optional Jev path is a narrow Choice check behind two
 * explicit server-only switches and a strict summary boundary.
 */
export async function chooseWorkDomain({ text, agent }: WorkRoutingInput): Promise<WorkDomain> {
  const normalized = normalize(typeof text === "string" ? text : "");
  if (!normalized || isGeneralPriorityTask(normalized)) return "general";
  // Treat multi-line/pasted context as local data. This also prevents a word
  // such as “报价” inside an attachment from escalating the tool domain.
  if (/[\r\n]/.test(typeof text === "string" ? text : "") || unsafeContextPatterns.test(normalized)) return "general";

  const intent = detectSalesIntent(normalized);
  if (intent) return hasCapability(agent, intent) ? "sales" : "general";

  const summary = possibleSalesPatterns.test(normalized) ? safeTaskSummary(text) : undefined;
  if (!summary || !agent || !agentCapabilitySet(agent).size) return "general";
  return (await chooseWithTypeSafe(summary, agent)) ?? "general";
}

