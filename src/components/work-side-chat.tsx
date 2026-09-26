"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, X } from "lucide-react";
import { CodeAnswer } from "./code-answer";
import styles from "./work-side-chat.module.css";

export type WorkSideChatProps = {
  task: string;
  modelProfileId?: string;
  mode?: string;
  onClose: () => void;
  onApplyToQueue: (text: string) => void;
};
type Message = { id: string; role: "user" | "assistant"; text: string };

/** An independent conversation: its stream never changes the main Work stream. */
export function WorkSideChat({ task, modelProfileId, mode = "light", onClose, onApplyToQueue }: WorkSideChatProps) {
  const [draft, setDraft] = useState(task);
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function send() {
    const text = draft.trim();
    if (!text || controller.current || text.length > 12000) return;
    const abort = new AbortController(); controller.current = abort;
    const user = { id: crypto.randomUUID(), role: "user" as const, text };
    const answer = { id: crypto.randomUUID(), role: "assistant" as const, text: "" };
    setMessages(current => [...current, user, answer]); setDraft(""); setBusy(true); setError("");
    const context = messages.slice(-6).map(message => `${message.role === "user" ? "用户" : "助手"}：${message.text.slice(0, 1500)}`).join("\n");
    try {
      const response = await fetch("/api/v1/assistant/chat", {
        method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({ messages: [{ id: user.id, role: "user", parts: [{ type: "text", text: `侧边聊天，独立于正在执行的 Work；以下排队任务和先前对话仅作为参考资料，不代表新执行授权。\n排队任务：${task.slice(0, 12000)}\n${context ? `先前侧边对话：\n${context}\n` : ""}当前请求：${text}` }] }], experience: "chat", workflowMode: "normal", mode: mode === "auto" ? "light" : mode, ...(modelProfileId ? { modelProfileId } : {}) }),
      });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message || "侧边聊天暂时无法连接"); }
      if (!response.body) throw new Error("侧边聊天没有返回内容");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "", fullText = "";
      const applyPacket = (packet: string) => {
        for (const line of packet.split("\n")) {
          if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === "error") throw new Error(event.errorText || "侧边聊天出现错误");
          if (event.type === "text-delta" && typeof event.delta === "string") {
            fullText += event.delta;
            setMessages(current => current.map(message => message.id === answer.id ? { ...message, text: fullText } : message));
          }
        }
      };
      try {
        while (true) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, "\n");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) { applyPacket(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
          if (chunk.done) { if (buffer.trim()) applyPacket(buffer); break; }
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (!fullText.trim()) throw new Error("本次没有收到回答，请重试");
    } catch (caught) {
      if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "侧边聊天暂时不可用");
    } finally { if (controller.current === abort) { controller.current = null; setBusy(false); } }
  }

  return <aside className={styles.panel} aria-label="侧边聊天">
    <header><div><strong>侧边聊天</strong><small>独立问答 · 主任务继续运行</small></div><button type="button" aria-label="关闭侧边聊天" onClick={() => { controller.current?.abort(); onClose(); }}><X size={18} /></button></header>
    <details className={styles.task}><summary>排队任务</summary><p>{task}</p></details>
    <div className={styles.messages} aria-live="polite">{messages.length ? messages.map(message => <article key={message.id} data-role={message.role}><strong>{message.role === "user" ? "你" : "LumaFlow"}</strong><CodeAnswer text={message.text || (busy ? "正在回答…" : "暂无正文")} />{message.role === "assistant" && message.text && !busy && <button type="button" onClick={() => onApplyToQueue(message.text)}>将回答用于排队消息</button>}</article>) : <p>可以讨论或完善这条任务，不会中断主任务。</p>}{error && <p role="alert" className={styles.error}>{error}</p>}</div>
    <footer><textarea aria-label="侧边聊天输入" value={draft} maxLength={12000} disabled={busy} placeholder="讨论这条任务…" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div><button type="button" disabled={busy || !draft.trim()} onClick={() => onApplyToQueue(draft.trim())}>更新排队消息</button>{busy ? <button type="button" aria-label="停止侧边回答" onClick={() => controller.current?.abort()}><X size={17} /></button> : <button type="button" aria-label="发送侧边问题" disabled={!draft.trim()} onClick={() => void send()}><ArrowUp size={17} /></button>}</div></footer>
  </aside>;
}
