import assert from "node:assert/strict";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const origin = new URL(base).origin;
const modes = ["instant", "medium", "high", "extra-high", "pro"];
const results = [];
for (const mode of modes) {
  const started = performance.now();
  const response = await fetch(`${base}/api/v1/assistant/chat`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ mode, modelProfileId: "local-qwen3-8b", agentRoleId: "sales-review", messages: [{ id: `tier-${mode}`, role: "user", parts: [{ type: "text", text: "验收题：17乘23等于多少？仅做算术，不查产品、不调用工具。最终答案只给数字。" }] }] }),
    signal: AbortSignal.timeout(310_000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const model = response.headers.get("X-Model-Id");
  const resolvedProfile = response.headers.get("X-Model-Profile");
  const thinkingEnabled = response.headers.get("X-Thinking-Enabled");
  const outputBudget = Number(response.headers.get("X-Output-Budget"));
  assert.equal(response.headers.get("X-Inference-Mode"), mode);
  assert.equal(resolvedProfile, mode === "pro" ? "local-qwen3-14b" : "local-qwen3-8b");
  assert.equal(thinkingEnabled, mode === "instant" ? "false" : "true");
  const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  assert.ok(!events.some((event) => event.type === "error"), JSON.stringify(events.filter((event) => event.type === "error")));
  assert.ok(!events.some((event) => event.type.startsWith("reasoning")), "Raw thinking must not be streamed to the browser");
  const answer = events.filter((event) => event.type === "text-delta").map((event) => event.delta).join("");
  assert.ok(answer.trim().length > 0, "The real model returned no final answer");
  assert.ok(!events.some((event) => event.type === "finish" && event.finishReason === "length"), "Test answer exceeded its generation budget");
  // Keep response correctness separate from transport/policy verification.
  // Do not reroute or replace a wrong model answer with a fixed expected one.
  const finalNumber = answer.match(/\d+(?:\.\d+)?/g)?.at(-1);
  const result = { mode, model, resolvedProfile, thinkingEnabled, outputBudget, elapsedMs: Math.round(performance.now() - started), answer, arithmeticCorrect: finalNumber === "391", numericOnlyFormat: /^391[。.!！\s]*$/.test(answer.trim()) };
  results.push(result);
  console.log(JSON.stringify(result));
}
assert.ok(results[1].outputBudget < results[2].outputBudget && results[2].outputBudget < results[3].outputBudget);
console.log(JSON.stringify({ inferencePassed: true, arithmeticCorrectCount: results.filter((item) => item.arithmeticCorrect).length, total: results.length, checks: "Five real local inference modes, actual model routing and non-empty final answers. Arithmetic accuracy is reported separately, never replaced or suppressed. This is a smoke test, not a model-quality benchmark.", results }, null, 2));
