import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Uses an isolated web test session on the real WeChat Agent profile. Does not
// send a WeChat message, alter the owner's transcript or publish a Moments post.
const backend = "http://127.0.0.1:9876";
const sessionId = "lumaflow-work-acceptance-20260918";
const response = await fetch(`${backend}/message`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ agent_id: "wechat-service", session_id: sessionId, stream: true,
    message: "/work 请实际执行 PowerShell 命令 Write-Output 'WECHAT-WORK-VERIFIED'; Get-Date -Format yyyy-MM-dd，然后把测试结果用文件工具保存为 wechat-work-verified.txt，最后告诉我真实退出码和文件路径。" }),
});
const started = await response.json();
assert.equal(started.status, "success", JSON.stringify(started));
const stream = await fetch(`${backend}/stream?request_id=${encodeURIComponent(started.request_id)}`, { signal: AbortSignal.timeout(300000) });
// This reconnectable endpoint can remain open after the terminal event.
const events = [];
const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
let pending = "";
let ended = false;
try {
  while (!ended) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += value;
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: {")) continue;
      const event = JSON.parse(line.slice(6));
      events.push(event);
      if (event.type === "stream_end" || event.type === "done") { ended = true; break; }
    }
  }
} finally { await reader.cancel(); }
const tools = events.filter((event) => event.type === "tool_end" && event.tool === "local_computer");
const directory = resolve(process.cwd(), "../.local-runtime/work-acceptance");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "wechat-agent-work-result.json"), JSON.stringify(events, null, 2));
assert(tools.some((event) => event.status === "success" && event.result.includes("WECHAT-WORK-VERIFIED")), "WeChat Agent did not execute actual command");
console.log(JSON.stringify({ realAgentProfile: "wechat-service", isolatedSession: true, actualTools: tools, eventCount: events.length }));
