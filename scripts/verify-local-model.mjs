import assert from "node:assert/strict";

const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const is14b = process.argv.includes("--model=14b");
const profileId = is14b ? "local-qwen3-14b" : "local-qwen3-8b";
const modelId = is14b ? "qwen3:14b" : "lumaflow-qwen3-8b:latest";
const catalog = await (await fetch(`${baseUrl}/api/v1/assistant/models`)).json();
const local = catalog.data.models.find((entry) => entry.id === profileId);
assert.equal(local?.model, modelId);
assert.equal(local?.reachable, true, "Start the installed local model service first.");
assert.equal(local?.connectionKind, "live");
const bootstrap = await (await fetch(`${baseUrl}/api/v1/bootstrap`)).json();
const product = bootstrap.data.products[0];
assert.ok(product?.sku);
const recommendation = process.argv.includes("--recommend");
const color = product.colors[0].includes("黑") ? "黑色" : product.colors[0];
const prompt = recommendation
  ? `推荐一款${product.power}${color}${product.category}，查询库存并提供参数表和场景图资料，回复要注明SKU。`
  : `请搜索产品 ${product.sku}，调用库存工具核对它有多少库存，再用两句话告诉我型号、SKU和库存。`;

const startedAt = performance.now();
const response = await fetch(`${baseUrl}/api/v1/assistant/chat`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: new URL(baseUrl).origin },
  body: JSON.stringify({
    modelProfileId: profileId,
    mode: "fast",
    messages: [{ id: `local-check-${Date.now()}`, role: "user", parts: [{ type: "text", text: prompt }] }],
  }),
  signal: AbortSignal.timeout(180_000),
});
assert.equal(response.status, 200);
assert.equal(response.headers.get("x-model-profile"), profileId);
assert.equal(response.headers.get("x-model-id"), modelId);
assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

let pending = "";
const decoder = new TextDecoder();
const events = [];
let firstTokenMs = null;
for await (const chunk of response.body) {
  pending += decoder.decode(chunk, { stream: true });
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const event = JSON.parse(line.slice(6));
    events.push(event);
    if (firstTokenMs === null && event.type === "text-delta") firstTokenMs = Math.round(performance.now() - startedAt);
  }
}
assert.equal(events.some((event) => event.type === "error"), false, JSON.stringify(events.filter((event) => event.type === "error")));
const calls = events.filter((event) => event.type === "tool-input-available");
// An exact-SKU inventory result already carries the authoritative SKU and model.
// Recommendation mode below still requires search, details and asset lookups.
const hasProductLookup = calls.some((event) => ["searchProducts", "getProductDetails", "checkInventory"].includes(event.toolName));
if (!hasProductLookup || !calls.some((event) => event.toolName === "checkInventory")) {
  console.error("Unexpected real-model trace:", JSON.stringify(events.filter((event) => event.type !== "tool-input-delta"), null, 2));
}
assert.ok(hasProductLookup, "Actual model did not query a product tool.");
assert.ok(calls.some((event) => event.toolName === "checkInventory"), "Actual model did not call inventory.");
const inventoryCall = calls.find((event) => event.toolName === "checkInventory");
const inventoryResult = events.find((event) => event.type === "tool-output-available" && event.toolCallId === inventoryCall.toolCallId);
assert.equal(inventoryResult?.output?.inventory?.sku, product.sku);
assert.equal(inventoryResult?.output?.inventory?.stock, product.stock);
const reply = events.filter((event) => event.type === "text-delta").map((event) => event.delta).join("");
assert.ok(reply.includes(product.sku), `Model reply omitted the SKU: ${reply}`);
assert.ok(reply.includes(String(product.stock)), `Model reply omitted the verified inventory: ${reply}`);
if (recommendation) {
  for (const name of ["searchProducts", "getProductDetails", "getProductAssets"]) {
    assert.ok(calls.some((call) => call.toolName === name), `Model did not call ${name}.`);
  }
  assert.doesNotMatch(reply, /\]\([^)]*\)/, "Attachment tool provides metadata, not download links.");
  assert.ok(product.assets.some((asset) => reply.includes(asset.name)), "Reply must reference actual attachment names.");
}
const loaded = await (await fetch("http://127.0.0.1:11434/api/ps")).json();
const loadedModel = loaded.models.find((entry) => entry.name === modelId);
assert.ok(loadedModel, "Local runtime did not report the actual loaded model.");

console.log(JSON.stringify({
  ok: true,
  model: modelId,
  modelProfileId: profileId,
  connectionKind: "live",
  scenario: recommendation ? "recommendation-and-assets" : "exact-sku-inventory",
  toolCalls: calls.map((event) => event.toolName),
  source: bootstrap.meta.source,
  sku: product.sku,
  expectedStock: product.stock,
  firstTextMs: firstTokenMs,
  elapsedMs: Math.round(performance.now() - startedAt),
  sizeBytes: loadedModel.size,
  vramBytes: loadedModel.size_vram,
  contextLength: loadedModel.context_length,
  reply,
}, null, 2));
