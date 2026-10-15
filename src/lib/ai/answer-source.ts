import "server-only";
import { z } from "zod";

export type AnswerSource = "local" | "web" | "mixed" | "direct";
const internal = /知识库|本地资料|本地文件|上传的|附件|我们(?:的|公司|店)|公司(?:的|资料|产品|库存)|天昭|TZ[-_]|库存|现货|发货|交期|报价单|客户资料|合同|\bsku\b/i;
const products = /灯具?|灯饰|照明|产品|商品|型号|货号|规格|选型|色温|功率|尺寸|材质|认证|\bproduct\b/i;
const external = /互联网|网上|全网|网页|新闻|天气|航班|机票|汇率|股价|比赛|电影上映|官方(?:文档|发布|说明|公告)|公开资料|最新.{0,12}(?:版|发布|更新|消息|新闻|政策)|\b(?:news|weather|flight|internet)\b/i;
const creative = /写(?:一个|个|段|篇)?(?:代码|脚本|函数|程序|故事|小说|诗)|生成(?:代码|html)|计算|翻译|改写|润色|解释.{0,10}(?:原理|概念)|\b(?:html|typescript|python|javascript)\b/i;
const choice = z.object({ answers: z.object({ source: z.object({ type: z.literal("choice"), choice: z.enum(["local", "web", "mixed", "direct"]), probabilities: z.record(z.string(), z.number().min(0).max(1)) }) }) });

export function isInternalKnowledgeQuestion(text: string) { return internal.test(text.normalize("NFKC")); }

/** Internal evidence requirements are code-owned, never relaxed by a classifier. */
export async function chooseAnswerSource(input: { text: string; selectedDocuments?: boolean; projectOnly?: boolean; signal?: AbortSignal }): Promise<AnswerSource> {
  const text = input.text.normalize("NFKC");
  if (input.projectOnly) return "local";
  const needsLocal = input.selectedDocuments || internal.test(text) || (products.test(text) && !creative.test(text));
  const needsWeb = external.test(text);
  if (needsLocal) return needsWeb && (input.selectedDocuments || internal.test(text)) ? "mixed" : needsWeb ? "web" : "local";
  if (needsWeb) return "web";
  if (creative.test(text)) return "direct";
  // Only an opt-in, short public task summary may leave this computer. Never
  // send documents, evidence, paths, account information or pasted content.
  if (process.env.TYPESAFE_WORK_ROUTING === "true" && process.env.TYPESAFE_API_KEY?.trim() && text.length <= 280 && !/[\r\n{}<>]|https?:|[A-Za-z]:[\\/]|密码|密钥|客户|正文|附件|知识库/.test(text)) {
    try {
      const response = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST", headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "jev-latest", state: { task_summary: text }, questions: { source: { type: "choice", instructions: "选择回答所需证据来源。公司产品、库存、用户文件必须 local；无关本地资料的时效事实 web；同时需要两类证据 mixed；普通写作计算 direct。不确定选 direct。", criteria: { local: "用户或公司私有本地证据", web: "公开且需要查询互联网的事实", mixed: "私有证据和公开事实均不可缺", direct: "无需检索，或无明确匹配" } } } }),
        signal: AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(8000)]),
      });
      if (response.ok) {
        const result = choice.parse(await response.json()).answers.source;
        if ((result.probabilities[result.choice] ?? 0) >= 0.8) return result.choice;
      }
    } catch { /* Deterministic rules remain usable without Jev or credentials. */ }
  }
  return "direct";
}
