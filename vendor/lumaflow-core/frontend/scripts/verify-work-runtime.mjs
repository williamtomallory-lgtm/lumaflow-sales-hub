import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Script } from "node:vm";

const origin = "http://127.0.0.1:3000";
const artifactDirectory = resolve(process.cwd(), "../.local-runtime/work-acceptance");
await mkdir(artifactDirectory, { recursive: true });

async function ask(text, experience = "chat", mode = "instant", tag = `${experience}-${mode}`) {
  const started = Date.now();
  const response = await fetch(`${origin}/api/v1/assistant/chat`, {
    method: "POST", headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }],
      modelProfileId: "configured", mode, experience, ...(experience === "work" ? { agentId: "wechat-service" } : {}) }),
    signal: AbortSignal.timeout(610000),
  });
  if (response.status !== 200) assert.fail(await response.text());
  const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  const answer = events.filter((event) => event.type === "text-delta").map((event) => event.delta).join("");
  const finishReason = events.findLast((event) => event.type === "finish")?.finishReason;
  const tools = events.filter((event) => event.type === "tool-output-available");
  const report = { model: response.headers.get("X-Model-Id"), mode, experience, finishReason,
    seconds: (Date.now() - started) / 1000, characters: answer.length, tools };
  await writeFile(resolve(artifactDirectory, `${tag}-result.json`), JSON.stringify({ ...report, answer }, null, 2));
  assert.equal(events.some((event) => event.type === "error"), false, JSON.stringify(events.filter((event) => event.type === "error")));
  console.log(JSON.stringify({ ...report, tools: tools.map((event) => ({ toolCallId: event.toolCallId, output: event.output })) }));
  return { answer, report };
}

const selection = process.argv[2] || "all";
if (selection === "work" || selection === "all") {
  const result = await ask("请实际执行 PowerShell 命令：Write-Output 'LUMAFLOW-WORK-VERIFIED'; Get-Date -Format yyyy-MM-dd。再用文件工具在工作目录保存 lumaflow-work-verified.txt，内容为 本地模型工具执行成功。最后告诉我真实退出码和文件路径。", "work");
  assert(result.report.tools.some((event) => event.output?.stdout?.includes("LUMAFLOW-WORK-VERIFIED") && event.output.exitCode === 0), "Model did not execute the command");
  assert(result.report.tools.some((event) => event.output?.saved === true), "Model did not save the file");
}
if (selection === "html" || selection === "all") {
  const result = await ask("创建一个html可以离线打开包含踩踏 车轮 旋转 围巾飘动和海岸背景滚动 支持暂停");
  const html = result.answer.match(/```html\s*\n([\s\S]*?)```/i)?.[1];
  assert(html && /<\/html>\s*$/i.test(html.trim()), "HTML is incomplete");
  assert.equal(result.report.finishReason, "stop", "Answer still truncated");
  assert(!/<(?:script|link|img)[^>]+(?:src|href)\s*=\s*["']https?:\/\//i.test(html), "Offline HTML loads external resources");
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) new Script(match[1]);
  await writeFile(resolve(artifactDirectory, "coastal-animation.html"), html);
  console.log("Complete model-generated offline HTML saved: " + resolve(artifactDirectory, "coastal-animation.html"));
}
if (selection === "effort" || selection === "all") {
  for (const mode of ["medium", "high", "extra-high"]) {
    const result = await ask("128乘以6等于多少？只回复计算结果。", "chat", mode);
    assert(result.answer.includes("768"));
  }
}
if (selection === "repair") {
  const path = resolve(artifactDirectory, "coastal-animation.html");
  const result = await ask(`请用本机工具读取并验证/修复你生成的离线 HTML：${path}。JavaScript 在文件后半段，直接用 read_file 的 offsetCharacters=4000 读取，不必列目录或读取前半页。原问题是暂停只停了 requestAnimationFrame，但 CSS 波浪和脚部动画仍在运行；syncCSSAnimation 未被调用。请确保 start/stop 能停止及恢复所有 CSS 动画及 RAF。需要修改时用 edit_file 精确替换片段，不要整份重写。若已经修复则不重复编辑，执行一个实际文件检查命令，检查成功输出 LUMAFLOW-PAUSE-VERIFIED，最后报告真实工具结果。`, "work", "instant", "work-animation-repair");
  assert(result.report.tools.length > 0, "Repair did not use actual local tools");
  assert(result.report.tools.some((event) => event.output?.saved === true || event.output?.exitCode === 0), "Repair did not save or execute a command");
}
