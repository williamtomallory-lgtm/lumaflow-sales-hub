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
assert.ok(["local", "postgres", "local-fallback"].includes(bootstrap.data.source));
const prompt = "请调用 searchProducts 搜索 ARC T18。如果后端没有结果，请明确说明暂无产品数据，不要补造 SKU、库存或价格。";

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
const searchCall = calls.find((event) => event.toolName === "searchProducts");
if (!searchCall) {
  console.error("Unexpected real-model trace:", JSON.stringify(events.filter((event) => event.type !== "tool-input-delta"), null, 2));
}
assert.ok(searchCall, "Actual model did not query searchProducts.");
const searchResult = events.find((event) => event.type === "tool-output-available" && event.toolCallId === searchCall.toolCallId);
assert.equal(searchResult?.output?.total, 0, "A clean runtime must not surface fixture products.");
assert.deepEqual(searchResult?.output?.products, []);
const reply = events.filter((event) => event.type === "text-delta").map((event) => event.delta).join("");
assert.ok(reply.trim(), "Model returned no text.");
assert.doesNotMatch(reply, /LT-ARC-T18-BK|库存\s*126/, "Model surfaced removed fixture business values.");
const loaded = await (await fetch("http://127.0.0.1:11434/api/ps")).json();
const loadedModel = loaded.models.find((entry) => entry.name === modelId);
assert.ok(loadedModel, "Local runtime did not report the actual loaded model.");

console.log(JSON.stringify({
  ok: true,
  model: modelId,
  modelProfileId: profileId,
  connectionKind: "live",
  scenario: "empty-runtime-no-fabrication",
  toolCalls: calls.map((event) => event.toolName),
  source: bootstrap.meta.source,
  fixtureProductsVisible: false,
  firstTextMs: firstTokenMs,
  elapsedMs: Math.round(performance.now() - startedAt),
  sizeBytes: loadedModel.size,
  vramBytes: loadedModel.size_vram,
  contextLength: loadedModel.context_length,
  reply,
}, null, 2));
