"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart } from "ai";
import { ArrowRight, Copy, FileText, Paperclip, RefreshCw, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { QUICK_QUESTIONS } from "@/config/ui-static";
import { useModelCatalog } from "@/hooks/use-model-catalog";
import { useModelHealth } from "@/hooks/use-model-health";
import type { SalesAgentUIMessage } from "@/lib/ai/sales-agent";
import type { Product } from "@/lib/catalog";
import { projectAgentSearch } from "@/lib/client/agent-search-result";
import { ModelRuntimeControls, InferenceReceiptView } from "./model-runtime-controls";
import { parseInferenceReceipt, persistInferenceMode, savedInferenceMode, type InferenceMode, type InferenceReceipt } from "@/config/inference-ui";
import { getInferenceProfileInputBudget } from "@/lib/ai/inference-policy";
import "./smart-search.css";

type Props = {
  products: Product[];
  initialQuestion: string;
  onProduct: (product: Product) => void;
  onToast: (message: string) => void;
  onAddToKit: (id: string) => void;
};

export function SmartSearchView({ products, initialQuestion, onProduct, onToast, onAddToKit }: Props) {
  const [input, setInput] = useState(initialQuestion || QUICK_QUESTIONS[0]);
  const [question, setQuestion] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [mode, setMode] = useState<InferenceMode>(savedInferenceMode);
  const [receipt, setReceipt] = useState<InferenceReceipt | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const submitting = useRef(false);
  const catalog = useModelCatalog();
  const { health, checking, refresh } = useModelHealth(catalog.modelProfileId);
  const transport = useMemo(() => new DefaultChatTransport<SalesAgentUIMessage>({
    api: "/api/v1/assistant/chat",
    // Current server API accepts one fresh user turn, never browser-owned tool history.
    prepareSendMessagesRequest: ({ messages, body, ...rest }) => ({
      body: { ...body, id: rest.id, messages: messages.filter((message) => message.role === "user").slice(-1) },
    }),
    fetch: async (url, init) => {
      const timeout = AbortSignal.timeout(310_000);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const response = await fetch(url, { ...init, signal });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        if (typeof payload?.error?.message === "string") throw new Error(payload.error.message);
        const explanation = response.status === 429 ? "请求过于频繁，请稍后重试。" : response.status === 422 ? "问题格式不正确，请缩短内容后重试。" : "模型请求失败，请刷新连接后重试。";
        throw new Error(`${explanation}（HTTP ${response.status}）`);
      }
      setReceipt(parseInferenceReceipt(response.headers));
      return response;
    },
  }), []);
  const { messages, sendMessage, status, error, stop, setMessages, clearError } = useChat<SalesAgentUIMessage>({ transport, throttle: 40, onFinish: ({ finishReason }) => setExhausted(finishReason === "length") });
  const busy = status === "submitted" || status === "streaming";
  const ready = Boolean(catalog.selectedModel && !catalog.loading && !checking && health?.reachable);
  const result = useMemo(() => projectAgentSearch(messages), [messages]);
  const tools = messages.filter((message) => message.role === "assistant").flatMap((message) => message.parts).filter(isToolUIPart);
  const selectedName = health?.model ?? catalog.selectedModel?.model ?? "等待读取模型";

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => () => { void stop(); }, [stop]);

  async function submit(value = input) {
    if (submitting.current || busy || !ready || !value.trim()) return;
    if (value.trim().length > getInferenceProfileInputBudget(mode)) {
      onToast(`当前档位最多接受 ${getInferenceProfileInputBudget(mode).toLocaleString()} 字符，请缩小问题范围或选择 Instant。`);
      return;
    }
    submitting.current = true;
    setInput(value);
    setQuestion(value.trim());
    setCancelled(false);
    setElapsed(0);
    setReceipt(null);
    setExhausted(false);
    clearError();
    setMessages([]);
    try {
      await sendMessage({ text: value.trim() }, { body: { modelProfileId: catalog.modelProfileId, mode } });
    } finally {
      submitting.current = false;
    }
  }
  function changeModel(value: string) {
    if (busy || submitting.current || value === catalog.modelProfileId) return;
    catalog.selectModel(value);
    setMode("instant");
    persistInferenceMode("instant");
    setReceipt(null);
    setExhausted(false);
    setMessages([]);
    clearError();
    setQuestion("");
    setCancelled(false);
  }
  function changeMode(next: InferenceMode) {
    if (busy || submitting.current) return;
    setMode(next); persistInferenceMode(next);
    setMessages([]); clearError(); setQuestion(""); setCancelled(false); setReceipt(null); setExhausted(false);
  }
  async function copyAnswer() {
    try { await navigator.clipboard.writeText(result.text); onToast("已复制模型草稿，请核对后发送"); }
    catch { onToast("复制失败，请手动选择答案文本"); }
  }

  return <div className="assistant-layout smart-search-live" data-testid="smart-search-live">
    <section className="assistant-main">
      <div className="search-model-bar">
        <label>选择模型<select aria-label="选择模型" value={catalog.modelProfileId} disabled={busy || catalog.loading || !catalog.models.length} onChange={(event) => changeModel(event.target.value)}>
          {catalog.models.length ? catalog.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>) : <option value={catalog.modelProfileId}>正在读取模型列表…</option>}
        </select></label>
        <button type="button" onClick={() => { catalog.refresh(); refresh(); }} disabled={busy} aria-label="刷新模型连接"><RefreshCw size={15} /> 刷新连接</button>
        <span role="status">{checking ? "检测中" : health?.reachable ? health.connectionKind === "protocol-mock" ? "协议模拟已连接" : "模型已连接" : "模型未连接"}</span>
      </div>
      <p className="search-model-detail">当前模型：{selectedName} · 文字问答 / 受控业务工具 · 搜索入口 v2</p>
      <ModelRuntimeControls models={catalog.models} modelProfileId={catalog.modelProfileId} mode={mode} disabled={busy || catalog.loading} onModelChange={changeModel} onModeChange={changeMode} />
      {catalog.modelProfileId === "local-qwen3-14b" && <p className="search-capability-note">{catalog.selectedModel?.description}首次加载较慢，日常使用建议优先选择 8B。</p>}
      <p className="search-capability-note">可检索已人工确认的知识文件正文节选。图片识别和直接附件上传尚未接入；请在知识库上传文件。当前一次处理一个问题，不保存长期聊天记忆。</p>
      {catalog.error && <p className="search-error" role="alert">{catalog.error}</p>}
      {!checking && !health?.reachable && <p className="search-error" role="alert">{catalog.modelProfileId === "local-qwen3-8b" ? "本地模型未连接：首次安装运行 npm run local:setup，启动运行 npm run local:up，再刷新连接。" : catalog.modelProfileId === "local-qwen3-14b" ? "14B 尚未就绪。安装命令：npm run local:setup -- --model=14b；完成后刷新连接。未安装时不能生成答案，可切回 8B。" : "自定义模型未连接，请先在服务器配置 LLM_*。当前电脑已安装的演示模型是 Qwen3 8B，可切回该项。"}</p>}
      {!question && <div className="search-empty"><Sparkles size={24} /><h2>向你选择的模型提问</h2><p>发送后才会生成答案。模型会按需调用产品、库存和资料工具；这里不再使用预填的规则回答。</p></div>}
      {question && <>
        <div className="customer-message"><div className="avatar customer">客</div><div><small>本轮问题</small><p>{question}</p></div></div>
        <div className="ai-message"><div className="ai-avatar"><Sparkles size={17} /></div><div className="answer-card">
          <div className="answer-head"><strong>模型回答</strong><em>{busy ? `生成中 · ${elapsed} 秒` : error ? "生成失败" : cancelled ? "已停止 · 内容可能不完整" : exhausted ? "预算已用尽 · 答案可能不完整" : result.text ? "已完成 · 待人工核对" : "未返回文字"}</em></div>
          <InferenceReceiptView receipt={receipt} />
          {exhausted && <p role="alert">模型已用完本轮生成预算。请缩小问题范围或调整档位后重试；当前内容不作为完整答案。</p>}
          {busy && <p role="status">{tools.length ? `已观察到 ${tools.length} 次工具调用，正在整理答案…` : "正在等待本地模型，首次加载可能需要约一分钟…"} 可以点击停止。</p>}
          {error && <div className="search-error" role="alert">模型未能完成回答：{error.message === "An error occurred." ? "本地推理服务出错或超时，请刷新连接后重试。" : error.message}<button onClick={() => void submit(question)} disabled={!ready || busy}>重试本轮问题</button></div>}
          {result.text && <p className="search-answer-text" data-testid="model-answer">{result.text}</p>}
          {!busy && !error && !result.text && <p>{cancelled ? "本次生成已停止，尚无文字答案。" : "模型没有返回文字答案，请重试或简化问题；不会用本地规则冒充模型回答。"}</p>}
          {tools.length > 0 && <div className="search-tool-trace" aria-label="本轮工具调用">{tools.map((part) => <span key={part.toolCallId}>{part.type.replace(/^tool-/, "")} · {part.state === "output-available" ? "已返回" : part.state === "output-error" ? "失败" : "执行中"}</span>)}</div>}
          {result.products.map((record) => {
            const local = products.find((product) => product.id === record.id);
            return <button className="answer-product" key={record.id} disabled={!local} onClick={() => local && onProduct({ ...local, ...record })}><span><small>工具返回产品</small><strong>{record.name}</strong><em>{record.sku} · {record.power}</em></span><ArrowRight size={16} /></button>;
          })}
          <div className="answer-actions"><button disabled={busy || !result.text} onClick={() => void copyAnswer()}><Copy size={15} /> 复制答案</button><button disabled={busy || !result.products.length} onClick={() => onAddToKit(result.products[0].id)}><Paperclip size={15} /> 加入资料包</button></div>
        </div></div>
      </>}
      <form className="chat-input-wrap" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="chat-input"><Sparkles size={18} /><textarea value={input} maxLength={20000} disabled={busy} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} aria-label="输入产品问题" placeholder="输入客户的问题…" />
          {busy ? <button type="button" aria-label="停止生成" onClick={() => { setCancelled(true); void stop(); }}><X size={17} /></button> : <button type="submit" aria-label="发送问题" disabled={!ready || !input.trim()}><Send size={17} /></button>}
        </div><small>Enter 发送 · Shift + Enter 换行 · 生成期间不可切换模型</small>
      </form>
    </section>
    <aside className="assistant-side">
      <div className="side-block"><span className="side-label">试试这样问 · 点击发送给模型</span>{QUICK_QUESTIONS.map((item) => <button key={item} disabled={busy || !ready} onClick={() => void submit(item)}>{item}<ArrowRight size={14} /></button>)}</div>
      <div className="side-block sources" data-testid="search-evidence"><span className="side-label">本轮工具来源</span>{result.evidence.length ? result.evidence.map((entry, index) => <div className="source-row" key={`${entry.title}-${index}`}><span><FileText size={15} /></span><div><strong>{entry.title}</strong><small>{entry.detail}</small></div></div>) : <p className="no-source">尚无工具返回的引用。不会预填审核状态、版本或库存时间。</p>}</div>
      <div className="trust-note"><ShieldCheck size={17} /><p><strong>数据与能力边界</strong><span>{result.sources.length ? `本轮数据源：${result.sources.join(" / ")}。` : "等待后端返回本轮数据源。"} JSON 是演示或回退数据，不是正式库存或报价依据。模型可能出错，请人工核对。</span></p></div>
    </aside>
  </div>;
}
