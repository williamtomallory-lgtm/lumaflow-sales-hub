import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Read-only inventory smoke test through the real app and local Bonsai runtime.
// Does not create quotes, change stock, or save a chat through the browser UI.
const baseUrl = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const modelUrl = "http://127.0.0.1:8081";
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseUrl).hostname), "Use the local app URL.");
const outputPath = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);
for (const arg of process.argv.slice(2)) assert.ok(arg.startsWith("--output=") && arg.length > 9, `Unknown option: ${arg}`);
const modelId = "ternary-bonsai-2-27b";

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, `HTTP ${response.status} from ${new URL(url).pathname}`);
  return response.json();
}

const [catalog, health, props, bootstrap] = await Promise.all([
  getJson(`${baseUrl}/api/v1/assistant/models`),
  getJson(`${baseUrl}/api/v1/assistant/health`),
  getJson(`${modelUrl}/props`),
  getJson(`${baseUrl}/api/v1/bootstrap`),
]);
const configured = catalog.data.models.find((model) => model.id === "configured");
assert.equal(configured?.model, modelId);
assert.equal(configured?.reachable, true);
assert.equal(configured?.connectionKind, "live");
assert.equal(health.data.model, modelId);
assert.equal(health.data.reachable, true);
assert.equal(props.model_alias, modelId);
assert.equal(props.default_generation_settings.n_ctx, 32768);
const product = bootstrap.data.products.find((item) => item.sku && Number.isFinite(item.stock));
// An empty operational inventory is valid: verify its real not-found result
// instead of inserting synthetic stock or treating the knowledge archive as stock.
if (!product) assert.equal(bootstrap.data.products.length, 0, "Inventory records are missing their expected fields.");
const sku = product?.sku ?? "LOCAL-PERF-CHECK-MISSING";
const prompt = `本地验证：请调用 checkInventory 查询 SKU ${sku} 的库存，再用一句话告诉我该 SKU 和查询结果；未找到时明确说明暂无库存资料，不推测库存。`;
const started = performance.now();
const response = await fetch(`${baseUrl}/api/v1/assistant/chat`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: new URL(baseUrl).origin },
  body: JSON.stringify({
    modelProfileId: "configured", mode: "light",
    messages: [{ id: `bonsai-check-${Date.now()}`, role: "user", parts: [{ type: "text", text: prompt }] }],
  }),
  signal: AbortSignal.timeout(180_000),
});
assert.equal(response.status, 200);
assert.equal(response.headers.get("x-model-profile"), "configured");
assert.equal(response.headers.get("x-model-id"), modelId);
assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
assert.ok(response.body);

const events = [];
let pending = "";
let firstTextMs = null;
let done = false;
const decoder = new TextDecoder();
function parseLine(line) {
  if (!line.startsWith("data: ")) return;
  const data = line.slice(6).trim();
  if (data === "[DONE]") { done = true; return; }
  const event = JSON.parse(data);
  events.push(event);
  if (event.type === "text-delta" && firstTextMs === null) firstTextMs = Math.round(performance.now() - started);
}
for await (const chunk of response.body) {
  pending += decoder.decode(chunk, { stream: true });
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) parseLine(line);
}
pending += decoder.decode();
if (pending.trim()) parseLine(pending);
assert.equal(done, true, "The response stream ended without DONE.");
assert.equal(events.some((event) => event.type === "error"), false, "The app reported a stream error.");
assert.ok(events.some((event) => event.type === "finish"), "The app never completed the answer.");
const calls = events.filter((event) => event.type === "tool-input-available");
const inventoryCall = calls.find((event) => event.toolName === "checkInventory");
assert.ok(inventoryCall, "The model did not invoke the inventory tool.");
const inventoryResult = events.find((event) => event.type === "tool-output-available" && event.toolCallId === inventoryCall.toolCallId);
assert.equal(inventoryCall.input?.identifier, sku);
assert.ok(inventoryResult, "Missing inventory tool output.");
if (product) {
  assert.equal(inventoryResult.output?.found, true);
  assert.equal(inventoryResult.output?.inventory?.sku, sku);
  assert.equal(inventoryResult.output?.inventory?.stock, product.stock);
} else {
  assert.equal(inventoryResult.output?.found, false);
  assert.equal(inventoryResult.output?.inventory, null);
}
const reply = events.filter((event) => event.type === "text-delta").map((event) => event.delta).join("");
assert.ok(reply.includes(sku), "Reply omitted the verified SKU.");
if (product) assert.ok(reply.includes(String(product.stock)), "Reply omitted the verified inventory count.");
else assert.match(reply, /暂无|未找到|未查到|没有找到|无.*资料|无法.*查询/, "Reply must acknowledge the missing inventory.");
const report = {
  ok: true, checkedAt: new Date().toISOString(), baseUrl, model: modelId,
  modelProfileId: "configured", connectionKind: configured.connectionKind,
  runtime: props.build_info, contextTokens: props.default_generation_settings.n_ctx,
  scenario: product ? "exact-sku-inventory" : "empty-inventory-not-found", dataSource: bootstrap.meta.source,
  sku, expectedStock: product?.stock ?? null, found: inventoryResult.output.found,
  toolCalls: calls.map((event) => event.toolName), firstTextMs,
  elapsedMs: Math.round(performance.now() - started), reply,
};
if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
