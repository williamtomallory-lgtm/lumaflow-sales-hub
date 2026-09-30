import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Real inference against the same Agent used by WeChat. This deliberately uses
// its local web transport and never sends a message or publishes to WeChat.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const agentId = process.argv.find((value) => value.startsWith("--agent="))?.slice(8) ?? "wechat-service";
const onlyCase = process.argv.find((value) => value.startsWith("--case="))?.slice(7);
assert.match(agentId, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const frontend = "http://127.0.0.1:3000";
const backend = "http://127.0.0.1:9876";
const route = `${frontend}/api/v1/knowledge/agent-library`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`LOCAL_HTTP_${response.status}`);
  const value = await response.json();
  if (value.status === "error") throw new Error("COWAGENT_RESPONSE_ERROR");
  return value;
}
async function ask(sessionId, message) {
  const start = Date.now();
  const submitted = await jsonRequest(`${backend}/message`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: agentId, session_id: sessionId, message, stream: false }) });
  assert.ok(submitted.request_id || submitted.inline_reply, "Missing request handle");
  let text = submitted.inline_reply ?? "";
  while (!text && Date.now() - start < 240_000) {
    await delay(1_500);
    const result = await jsonRequest(`${backend}/poll`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: agentId, session_id: sessionId }) });
    if (result.has_content && result.request_id === submitted.request_id) text = result.content;
  }
  assert.ok(typeof text === "string" && text.trim(), "MODEL_TIMEOUT_OR_EMPTY");
  assert.doesNotMatch(text, /\[ERROR\]|Agent error:/i);
  const history = await jsonRequest(`${backend}/api/history?agent_id=${encodeURIComponent(agentId)}&session_id=${encodeURIComponent(sessionId)}&page_size=50`);
  const tools = (history.messages ?? []).filter((item) => item.role === "assistant")
    .flatMap((item) => (item.steps ?? []).map((step) => step.name).filter(Boolean));
  const statistics = (history.messages ?? []).filter((item) => item.role === "assistant")
    .flatMap((item) => item.steps ?? []).filter((step) => step.name === "sales_statistics" && !step.is_error)
    .flatMap((step) => { try { const data = JSON.parse(step.result); return data.metrics ? [data.metrics] : []; } catch { return []; } });
  const drafts = (history.messages ?? []).filter((item) => item.role === "assistant")
    .flatMap((item) => item.steps ?? []).filter((step) => step.name === "moments_draft" && !step.is_error)
    .flatMap((step) => { try { const data = JSON.parse(step.result); return data.body ? [data] : []; } catch { return []; } });
  return { text, tools, statistics, drafts, elapsedMs: Date.now() - start };
}

const report = { at: new Date().toISOString(), agentId, transport: "CowAgent web API using the WeChat Agent; phone delivery NOT tested", cases: [] };
let phase = "read-private-bridge-config";
try {
  const bridge = JSON.parse(await readFile(path.join(root, ".local-data/agent-bridge.json"), "utf8"));
  assert.match(bridge.knowledgeToken, /^[a-f0-9]{64}$/);
  if (process.argv.includes("--import-demo")) {
    phase = "explicit-demo-import";
    await jsonRequest(route, { method: "POST", headers: { origin: frontend, "content-type": "application/json" },
      body: JSON.stringify({ action: "import-demo", agentId }) });
  }
  const query = `${route}?agentId=${encodeURIComponent(agentId)}`;
  phase = "browser-metadata-boundary";
  const safe = await jsonRequest(query, { headers: { origin: frontend } });
  assert.equal(safe.meta.bodyIncluded, false);
  assert.ok(safe.data.documents.every((document) => !("text" in document)));
  phase = "private-bridge-file-bodies";
  const full = await jsonRequest(query, { headers: { authorization: `Bearer ${bridge.knowledgeToken}` } });
  const markers = ["金桔-739-SAFE", "青柠-582-SAFE", "葡萄-416-SAFE", "蓝莓-268-SAFE"];
  for (const marker of markers) assert.ok(full.data.documents.some((document) => document.collection === "demo" && document.text.includes(marker)), `Missing actual TXT marker ${marker}`);
  phase = "agent-isolation";
  const other = await jsonRequest(`${route}?agentId=kb-isolation-${randomUUID().slice(0, 8)}`, { headers: { authorization: `Bearer ${bridge.knowledgeToken}` } });
  assert.deepEqual(other.data.documents, []);
  console.log("Actual four TXT bodies, browser metadata boundary and Agent isolation: PASS");
  const prefix = `kb-verify-${randomUUID().slice(0, 8)}`;
  const cases = [
    { id: "identity", prompt: "你好，你是谁？用一句话介绍你的职责。", required: [/LumaFlow.*销售助手|销售助手.*LumaFlow/], retrieve: false },
    { id: "customer-service", prompt: "请根据已授权的网站产品文件回答：PTEST-739 的功率、材质、快照库存、模拟单价和质保是什么？可以保证今天发货吗？注明实际文件名及是否虚构。", required: [/18\s*W/i, /压铸铝/, /37/, /119/, /2\s*年/, /01-products\.txt/, /虚构|演示/], retrieve: true },
    { id: "chat-review", prompt: "请读取网站授权的聊天记录，复盘 SYN-01 和 SYN-02。SYN-01 最终数量是多少？色温确认了吗？明天14点指哪一天？两个客户分别有哪些待确认项？注明文件名，不自动创建任务。", required: [/25/, /2026[-年/]0?9[-月/]17|9\s*月\s*17/, /02-chat-log\.txt/, /SYN-02/, /虚构|演示/], retrieve: true },
    { id: "sales-dedup", prompt: "根据网站授权的销售结果文件，按客户ID去重计算：新开发客户数、已报价客户数、成交客户数、成交金额、开发到成交转化率。不要重复统计 SYN-03；没数据的毛利不要估计。注明文件名。", required: [/5/, /3/, /1/, /2[,]?975/, /20(?:\.0{1,2})?\s*%|20(?:\.0{1,2})?\s*％/, /03-sales-results\.txt/, /虚构|演示/], retrieve: true },
    { id: "moments-draft", prompt: "请读取网站授权的运营简报与产品文件，生成一条80至120字的朋友圈文案（包含18W、材质、可选色温及质保），以及配图建议。禁止写价格、库存、未经证实的色温可调或当天发货，不要直接发布。按【正文】【配图建议】【发布核对】三段输出，注明文件来源。", required: [/04-moments-brief\.txt/, /18\s*W/i, /配图|图片/, /示意图|实拍|AI/, /草稿|未发布|待确认|核对/], retrieve: true },
    { id: "moments-regenerate", prompt: "请基于网站授权的产品资料和运营简报，重新生成第二版朋友圈草稿（moments_draft 的 variant=2）。正文只放工具生成的80至120字，不要改写产品事实；另列配图建议与来源核对。不要发布。", required: [/04-moments-brief\.txt/, /18\s*W/i, /配图|图片/, /草稿|未发布|待确认|核对/], retrieve: true },
    { id: "moments-custom", prompt: "自定义模式(Test)", required: [/【你写的朋友圈正文】\s*Test/, /未发布/, /没有字数、SKU、运营简报或配图要求/], retrieve: false },
    { id: "moments-mode-menu", prompt: "朋友圈模式", required: [/资料模式/, /自定义模式/, /不能直接发布朋友圈/], retrieve: false },
    { id: "moments-source-mode", prompt: "朋友圈资料模式：生成文案", required: [/04-moments-brief\.txt/, /【正文】/, /未发布朋友圈/], retrieve: true },
  ];
  if (onlyCase) assert.ok(cases.some((item) => item.id === onlyCase), `Unknown verification case: ${onlyCase}`);
  for (const item of cases) {
    if (onlyCase && item.id !== onlyCase) continue;
    phase = `real-model-${item.id}`;
    console.log(`Real Qwen inference: ${item.id} ...`);
    const result = await ask(`${prefix}-${item.id}`, item.prompt);
    const checks = item.required.map((pattern) => ({ expected: pattern.source, passed: pattern.test(result.text) }));
    if (item.retrieve) {
      const tool = item.id === "sales-dedup" ? "sales_statistics" : item.id.startsWith("moments-") ? "moments_draft" : "website_knowledge";
      checks.push({ expected: `actual ${tool} tool execution`, passed: result.tools.includes(tool) });
    }
    if (item.id === "moments-custom" || item.id === "moments-mode-menu") {
      checks.push({ expected: "actual moments_custom tool execution", passed: result.tools.includes("moments_custom") });
      checks.push({ expected: "no source-backed draft or publish claim", passed: !result.tools.includes("moments_draft") && !/已发布朋友圈|状态[^\n]{0,20}发布成功/.test(result.text) });
    }
    if (item.id === "sales-dedup") {
      checks.push({ expected: "actual deterministic metrics: 5/3/1/2975/20", passed: result.statistics.some((metrics) =>
        metrics.newCustomerCount === 5 && metrics.quotedCustomerCount === 3 && metrics.wonCustomerCount === 1 &&
        Number(metrics.wonAmount) === 2975 && Number(metrics.developmentToWonPercent) === 20) });
    }
    if (item.id === "moments-draft" || item.id === "moments-regenerate" || item.id === "moments-source-mode") {
      const body = (result.text.match(/【正文】\s*([\s\S]+?)(?=【|$)/)?.[1] ?? "")
        .replace(/（来源[:：][\s\S]*$/u, "").replace(/\(来源[:：][\s\S]*$/u, "").trim();
      const length = [...body.replace(/\s/g, "")].length;
      checks.push({ expected: "final body equals authoritative source-backed draft", passed: result.drafts.some((draft) =>
        body.replace(/\s/g, "") === draft.body.replace(/\s/g, "") && draft.publicationStatus === "draft_only" && draft.imageStatus === "not_generated") });
      if (item.id === "moments-regenerate") checks.push({ expected: "second source-backed variant was generated", passed: result.drafts.some((draft) => draft.variant === 2) });
      checks.push({ expected: "Moments body contains 80–120 characters", passed: length >= 80 && length <= 120 });
      checks.push({ expected: "CCT and colors are selectable options", passed: /色温可选|色温.{0,5}可选|可选.{0,8}色温/.test(body) });
      checks.push({ expected: "no unsupported tunable CCT, superlatives, discounts, public prices or inventory in body", passed: Boolean(body) &&
        !/色温.{0,12}(可调|调节)|可调.{0,12}色温|专业级|高品质|限时折扣|全国销量第一|今天发货|当天发货|库存|119|单价/.test(body) });
    }
    report.cases.push({ id: item.id, question: item.prompt, ...result, checks, passed: checks.every((check) => check.passed) });
    console.log(`${item.id}: ${checks.every((check) => check.passed) ? "PASS" : "FAIL"} (${Math.round(result.elapsedMs / 1000)}s; tools: ${result.tools.join(", ") || "none"})`);
  }
  report.passed = report.cases.every((item) => item.passed);
} catch (error) {
  report.passed = false;
  // Do not log the bridge file, HTTP headers, model secrets or request objects.
  report.phase = phase;
  report.error = error instanceof assert.AssertionError ? error.message
    : `LOCAL_AGENT_VERIFICATION_FAILED (${error.code ?? error.name ?? "UNKNOWN"})`;
  console.error(report.error);
} finally {
  const output = path.join(root, ".local-runtime", "agent-library-verification.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Evidence saved locally: ${output}`);
  if (!report.passed) process.exitCode = 1;
}
