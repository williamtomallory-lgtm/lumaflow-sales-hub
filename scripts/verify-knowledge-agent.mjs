import assert from "node:assert/strict";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const origin = new URL(base).origin;
const suffix = Date.now();
const text = `验收样本（虚构客户，不是真实公司数据）。\n2026-09-07 客户：需要30套轨道灯，预算未提供，请周三确认安装尺寸。\n销售：已记下需求，尚未报价，尚未成交。\n客户：喜欢黑色外观，请先提供参数，不要先下单。`;
const form = new FormData();
form.append("file", new Blob([text], { type: "text/plain" }), `验收样本-微信记录-${suffix}.txt`);
form.append("modelProfileId", "local-qwen3-8b");
const response = await fetch(`${base}/api/v1/knowledge`, { method: "POST", headers: { origin }, body: form, signal: AbortSignal.timeout(150_000) });
assert.ok([200, 201].includes(response.status), await response.clone().text());
const upload = await response.json();
assert.equal(upload.data.hasText, true);
assert.equal(upload.data.classificationSource, "model", JSON.stringify(upload));
assert.equal(upload.data.classificationStatus, "classified");
const documentId = upload.data.id;
const list = await (await fetch(`${base}/api/v1/knowledge`, { headers: { origin } })).json();
assert.ok(list.data.some((document) => document.id === documentId));
const original = await fetch(`${base}${upload.data.downloadUrl}`, { headers: { origin } });
assert.equal(await original.text(), text);
assert.match(original.headers.get("content-disposition"), /attachment/);
const duplicate = await (await fetch(`${base}/api/v1/knowledge`, { method: "POST", headers: { origin }, body: form })).json();
assert.equal(duplicate.data.id, documentId);
assert.equal(duplicate.meta.deduplicated, true);

const archiveForm = new FormData();
archiveForm.append("file", new Blob([new Uint8Array([0, 15, 100, 202])]), `验收样本-未知格式-${suffix}.bin`);
const archived = await (await fetch(`${base}/api/v1/knowledge`, { method: "POST", headers: { origin }, body: archiveForm })).json();
assert.equal(archived.data.parseStatus, "archive_only");
assert.equal(archived.data.classificationSource, "none");
assert.equal(archived.data.hasText, false);

const result = await fetch(`${base}/api/v1/assistant/chat`, {
  method: "POST", headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ modelProfileId: "local-qwen3-8b", agentRoleId: "wechat-service", knowledgeDocumentIds: [documentId], mode: "fast", messages: [{ id: `qa-${suffix}`, role: "user", parts: [{ type: "text", text: "根据所选聊天记录，简短总结客户需求和下一步。只用记录里的事实，不推荐新产品。" }] }] }),
  signal: AbortSignal.timeout(150_000),
});
assert.equal(result.status, 200);
assert.equal(result.headers.get("x-agent-role"), "wechat-service");
const coverage = JSON.parse(decodeURIComponent(result.headers.get("x-knowledge-coverage")));
assert.equal(coverage[0].id, documentId);
assert.equal(coverage[0].includedCharacters, text.length);
const wire = await result.text();
const events = wire.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
assert.ok(!events.some((event) => event.type === "error"));
const answer = events.filter((event) => event.type === "text-delta").map((event) => event.delta).join("");
assert.ok(answer.includes("30"), answer);
assert.ok(answer.includes("黑"), answer);
console.log(JSON.stringify({ ok: true, documentId, archiveDocumentId: archived.data.id, sampleNames: [upload.data.originalName, archived.data.originalName], classification: upload.data.category, title: upload.data.title, summary: upload.data.summary, coverage, answer, note: "Two clearly named synthetic QA samples are retained locally for restart/browser verification; no company documents were used." }, null, 2));
