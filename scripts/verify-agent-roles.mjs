import assert from "node:assert/strict";
const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const prompts = {
  "sales-consultant": "请写两句客户回复草稿，保留已约定的日期，不检索新产品。",
  "wechat-service": "请用两句总结微信记录和下一步，不检索新产品。",
  "sales-review": "请用三条总结已知、待确认、下一步，不检索新产品。",
  "moments-operator": "请基于这条记录写一条不泄露客户身份的朋友圈选题建议和发布前核对项。不要编造价格、优惠或成交。",
};
const records = "这是虚构验收记录：QA客户需要30套黑色轨道灯，预算未确认，约定周三测量，尚未报价也未成交。";
const results = [];
const selectedRole = process.argv.find((arg) => arg.startsWith("--role="))?.slice(7);
if (selectedRole) assert.ok(Object.hasOwn(prompts, selectedRole), "Unknown role");
for (const [agentRoleId, prompt] of Object.entries(prompts)) {
  if (selectedRole && selectedRole !== agentRoleId) continue;
  const started = Date.now();
  const response = await fetch(`${base}/api/v1/assistant/chat`, {
    method: "POST", headers: { "content-type": "application/json", origin: new URL(base).origin },
    body: JSON.stringify({ agentRoleId, modelProfileId: "local-qwen3-8b", mode: "medium", messages: [{ id: `qa-${agentRoleId}`, role: "user", parts: [{ type: "text", text: `${records}\n${prompt}` }] }] }),
    signal: AbortSignal.timeout(190_000),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-agent-role"), agentRoleId);
  assert.equal(response.headers.get("x-model-profile"), "local-qwen3-8b");
  const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  assert.ok(!events.some((item) => item.type === "error"), "Model stream failed");
  assert.ok(!events.some((item) => item.type.startsWith("reasoning")), "Raw reasoning must not leave the server");
  const text = events.filter((item) => item.type === "text-delta").map((item) => item.delta).join("");
  assert.ok(text.trim(), "No real model answer");
  assert.ok(!events.some((item) => item.type === "finish" && item.finishReason === "length"), "Answer exhausted its budget");
  const result = { agentRoleId, elapsedMs: Date.now() - started, text, retainedDate: text.includes("周三"), changedDate: text.includes("周三前"), toolCalls: events.filter((item) => item.type === "tool-input-available").map((item) => item.toolName) };
  results.push(result); console.log(JSON.stringify(result));
}
console.log(JSON.stringify({ realRolesPassed: results.length, syntheticInputOnly: true, note: "Verifies real role routing and final answers; not a claim of perfect sales advice or live WeChat data verification." }));
