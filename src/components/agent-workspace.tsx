"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart } from "ai";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  Copy,
  FileText,
  MessageCircle,
  Paperclip,
  RefreshCw,
  ArrowUp,
  SquarePen,
  Plus,
  ShieldCheck,
  Sparkles,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { QUICK_QUESTIONS } from "@/config/ui-static";
import { DEFAULT_AGENT_ROLE_ID, AGENT_ROLES, getAgentRoleOption, isAgentRoleId, type AgentRoleId } from "@/config/agent-roles";
import { useModelCatalog } from "@/hooks/use-model-catalog";
import { useModelHealth } from "@/hooks/use-model-health";
import type { SalesAgentUIMessage } from "@/lib/ai/sales-agent";
import type { Product } from "@/lib/catalog";
import type { CrmAsset, Customer } from "@/lib/crm";
import { projectAgentSearch } from "@/lib/client/agent-search-result";
import styles from "./agent-workspace.module.css";
import { ModelRuntimeControls, InferenceReceiptView } from "./model-runtime-controls";
import { parseInferenceReceipt, persistInferenceMode, savedInferenceMode, type InferenceMode, type InferenceReceipt } from "@/config/inference-ui";
import { getInferenceProfileInputBudget } from "@/lib/ai/inference-policy";

export type AgentReplyConfirmation = {
  customer: Customer;
  message: string;
  assetIds: string[];
};

/** Props intentionally mirror the previous SalesAssistantView entry point. */
export type AgentWorkspaceProps = {
  customers: Customer[];
  products: Product[];
  assets: CrmAsset[];
  initialCustomerId?: string;
  initialMessage?: string;
  initialExperience?: "chat" | "work";
  onOpenKnowledge?: () => void;
  onAddToKit?: (id: string) => void;
  onConfirmReply?: (confirmation: AgentReplyConfirmation) => void;
  onOpenCustomer?: (customerId: string) => void;
  onOpenProduct?: (product: Product) => void;
  onToast?: (message: string) => void;
};

export type KnowledgeDocument = {
  id: string;
  title: string;
  category: string;
  summary: string;
  status: string;
  updatedAt: string;
  size?: string;
  format?: string;
  selectable: boolean;
  unavailableReason?: string;
};

export type KnowledgeCoverage = {
  id: string;
  name: string;
  includedCharacters: number;
  totalCharacters: number;
  truncated: boolean;
  hasText: boolean;
};

const rolePreferenceKey = "lumaflow.agent.role";

function cx(...names: Array<string | false | undefined>) {
  return names.filter(Boolean).join(" ");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textValue(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function numberValue(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  }
  return 0;
}

/** The knowledge API contract returns safe public entries in `data`. */
export function parseKnowledgeDocuments(payload: unknown): KnowledgeDocument[] {
  const root = asRecord(payload);
  const items = Array.isArray(root?.data) ? root.data : [];
  return items.flatMap((value) => {
    const record = asRecord(value);
    if (!record) return [];
    const id = textValue(record, "id", "documentId", "fileId");
    const title = textValue(record, "title", "name", "fileName", "originalName");
    if (!id || !title) return [];
    const format = textValue(record, "format", "extension", "mimeType", "type");
    const statusCode = textValue(record, "status", "classificationStatus");
    const status = statusCode === "classified" ? "已分类" : statusCode === "pending" ? "待分类" : statusCode === "archived" ? "已归档" : statusCode || (record.archived === true ? "已归档" : "已发布");
    const explicitSelectable = record.selectable;
    const contentAvailable = record.contentAvailable;
    const hasText = record.hasText !== false && record.parseStatus !== "archive_only" && record.parseStatus !== "parse_failed";
    // File extension is not an authority: parsed PDF/Office text is usable;
    // archive-only or failed extraction is shown but cannot be selected.
    const selectable = explicitSelectable === false || contentAvailable === false || !hasText
      ? false
      : explicitSelectable !== true || contentAvailable === true;
    return [{
      id,
      title,
      category: textValue(record, "category", "kind", "type") || "知识文档",
      summary: textValue(record, "summary", "description", "excerpt", "textPreview"),
      status,
      updatedAt: textValue(record, "updatedAt", "modifiedAt", "createdAt") || "时间未提供",
      size: textValue(record, "size", "sizeLabel", "fileSize") || undefined,
      format: format || undefined,
      selectable,
      unavailableReason: selectable ? undefined : "仅支持已归档的可读文本内容",
    }];
  });
}

export function parseKnowledgeCoverageHeader(value: string | null): KnowledgeCoverage[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const record = asRecord(entry);
      if (!record) return [];
      const id = textValue(record, "id");
      if (!id) return [];
      return [{
        id,
        name: textValue(record, "name", "title") || id,
        includedCharacters: numberValue(record, "includedCharacters"),
        totalCharacters: numberValue(record, "totalCharacters"),
        truncated: record.truncated === true,
        hasText: record.hasText !== false,
      }];
    });
  } catch {
    return [];
  }
}

function savedRole(): AgentRoleId {
  if (typeof window === "undefined") return DEFAULT_AGENT_ROLE_ID;
  try {
    const value = localStorage.getItem(rolePreferenceKey);
    return value && isAgentRoleId(value) ? value : DEFAULT_AGENT_ROLE_ID;
  } catch {
    return DEFAULT_AGENT_ROLE_ID;
  }
}

function customerLabel(customer: Customer) {
  return `${customer.company} · ${customer.name}`;
}

export function AgentWorkspace({
  customers,
  products,
  assets,
  initialCustomerId,
  initialMessage,
  initialExperience = "chat",
  onOpenKnowledge,
  onAddToKit,
  onConfirmReply,
  onOpenCustomer,
  onOpenProduct,
  onToast,
}: AgentWorkspaceProps) {
  const [experience, setExperience] = useState(initialExperience);
  const [workRoleId, setWorkRoleId] = useState<AgentRoleId>(savedRole);
  const roleId = experience === "chat" ? DEFAULT_AGENT_ROLE_ID : workRoleId;
  const [contextOpen, setContextOpen] = useState(false);
  const [input, setInput] = useState(initialMessage ?? "");
  // Do not silently attach an arbitrary demo customer to a free-form chat.
  // A customer context is sent only when the caller or user explicitly picks it.
  const initialCustomer = initialCustomerId ? customers.find((customer) => customer.id === initialCustomerId) : undefined;
  const [customerId, setCustomerId] = useState(initialCustomer?.id ?? "");
  const [question, setQuestion] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [cancelled, setCancelled] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [mode, setMode] = useState<InferenceMode>(savedInferenceMode);
  const [receipt, setReceipt] = useState<InferenceReceipt | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [knowledgeCoverage, setKnowledgeCoverage] = useState<KnowledgeCoverage[]>([]);
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<KnowledgeDocument[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(true);
  const [knowledgeError, setKnowledgeError] = useState("");
  const [wechatDialogOpen, setWechatDialogOpen] = useState(false);
  const submitting = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const importDialog = useRef<HTMLDialogElement>(null);
  const catalog = useModelCatalog();
  const { health, checking, refresh: refreshHealth } = useModelHealth(catalog.modelProfileId);
  const role = getAgentRoleOption(roleId);
  const transport = useMemo(() => new DefaultChatTransport<SalesAgentUIMessage>({
    api: "/api/v1/assistant/chat",
    prepareSendMessagesRequest: ({ messages, body, ...rest }) => ({
      body: {
        ...body,
        id: rest.id,
        // The server accepts one fresh user turn. Never replay browser-owned
        // assistant/tool parts as trusted model history.
        messages: messages.filter((message) => message.role === "user").slice(-1),
      },
    }),
    fetch: async (url, init) => {
      const timeout = AbortSignal.timeout(310_000);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const response = await fetch(url, { ...init, signal });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        if (typeof payload?.error?.message === "string") throw new Error(payload.error.message);
        const explanation = response.status === 429
          ? "请求过于频繁，请稍后重试。"
          : response.status === 422
            ? "问题格式不正确，请缩短内容后重试。"
            : "模型请求失败，请刷新连接后重试。";
        throw new Error(`${explanation}（HTTP ${response.status}）`);
      }
      setKnowledgeCoverage(parseKnowledgeCoverageHeader(response.headers.get("X-Knowledge-Coverage")));
      setReceipt(parseInferenceReceipt(response.headers));
      return response;
    },
  }), []);
  const { messages, sendMessage, status, error, stop, setMessages, clearError } = useChat<SalesAgentUIMessage>({ transport, throttle: 40, onFinish: ({ finishReason }) => setExhausted(finishReason === "length") });
  const busy = status === "submitted" || status === "streaming";
  const ready = Boolean(catalog.selectedModel && !catalog.loading && !checking && health?.reachable);
  const result = useMemo(() => projectAgentSearch(messages), [messages]);
  const toolParts = useMemo(() => messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .filter(isToolUIPart), [messages]);
  const selectedCustomer = customers.find((customer) => customer.id === customerId);
  const selectedDocuments = knowledgeDocuments.filter((document) => selectedDocumentIds.includes(document.id));
  const selectedModelName = health?.model ?? catalog.selectedModel?.model ?? "等待读取模型";

  useEffect(() => {
    const controller = new AbortController();
    async function loadKnowledge() {
      setKnowledgeLoading(true);
      setKnowledgeError("");
      try {
        const response = await fetch("/api/v1/knowledge", { cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(`知识库接口返回 ${response.status}`);
        const documents = parseKnowledgeDocuments(payload);
        for (let offset = 100; documents.length >= offset && offset < 500; offset += 100) {
          const page = await fetch(`/api/v1/knowledge?limit=100&offset=${offset}`, { cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal });
          if (!page.ok) throw new Error(`知识库后续页面返回 ${page.status}`);
          documents.push(...parseKnowledgeDocuments(await page.json()));
        }
        setKnowledgeDocuments([...new Map(documents.map((document) => [document.id, document])).values()]);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setKnowledgeDocuments([]);
          setKnowledgeError(loadError instanceof Error ? loadError.message : "暂时无法读取知识库文件。");
        }
      } finally {
        if (!controller.signal.aborted) setKnowledgeLoading(false);
      }
    }
    void loadKnowledge();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => () => { void stop(); }, [stop]);

  useEffect(() => {
    if (wechatDialogOpen && importDialog.current && !importDialog.current.open) importDialog.current.showModal();
    if (!wechatDialogOpen && importDialog.current?.open) importDialog.current.close();
  }, [wechatDialogOpen]);

  function resetOutput() {
    setMessages([]); clearError(); setQuestion(""); setCancelled(false);
    setConfirmed(false); setReceipt(null); setExhausted(false); setKnowledgeCoverage([]);
  }

  function changeExperience(next: "chat" | "work") {
    if (busy || submitting.current || next === experience) return;
    setExperience(next); resetOutput();
    // Customer and explicitly attached files remain visible in the composer.
  }

  function newQuestion() {
    if (busy || submitting.current) return;
    resetOutput(); setInput(""); setCustomerId(""); setSelectedDocumentIds([]);
    setContextOpen(false); inputRef.current?.focus();
  }

  function changeRole(value: string) {
    if (busy || !isAgentRoleId(value)) return;
    setWorkRoleId(value);
    setReceipt(null);
    setExhausted(false);
    setMessages([]);
    clearError();
    setQuestion("");
    setCancelled(false);
    setConfirmed(false);
    setKnowledgeCoverage([]);
    try { localStorage.setItem(rolePreferenceKey, value); } catch { /* persistence is optional */ }
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
    setConfirmed(false);
    setKnowledgeCoverage([]);
  }

  function changeMode(next: InferenceMode) {
    if (busy || submitting.current) return;
    setMode(next); persistInferenceMode(next);
    setMessages([]); clearError(); setQuestion(""); setCancelled(false); setConfirmed(false);
    setReceipt(null); setExhausted(false); setKnowledgeCoverage([]);
  }

  function toggleDocument(document: KnowledgeDocument) {
    if (!document.selectable || busy) return;
    setSelectedDocumentIds((current) => {
      if (current.includes(document.id)) return current.filter((id) => id !== document.id);
      if (current.length >= 5) {
        onToast?.("每次最多选择 5 份知识库文件");
        return current;
      }
      return [...current, document.id];
    });
  }

  async function submit(value = input) {
    const cleanValue = value.trim();
    if (submitting.current || busy || !ready || !cleanValue) return;
    if (cleanValue.length > getInferenceProfileInputBudget(mode)) {
      onToast?.(`当前档位最多接受 ${getInferenceProfileInputBudget(mode).toLocaleString()} 字符，请缩小任务范围或选择 Instant。`);
      return;
    }
    submitting.current = true;
    setInput(value);
    setQuestion(cleanValue);
    setCancelled(false);
    setConfirmed(false);
    setElapsed(0);
    setReceipt(null);
    setExhausted(false);
    setKnowledgeCoverage([]);
    clearError();
    setMessages([]);
    try {
      await sendMessage({ text: cleanValue }, {
        body: {
          agentRoleId: roleId,
          knowledgeDocumentIds: selectedDocumentIds,
          modelProfileId: catalog.modelProfileId,
          mode,
          ...(customerId ? { customerId } : {}),
        },
      });
    } finally {
      submitting.current = false;
    }
  }

  async function copyOutput() {
    if (!result.text) return;
    try {
      await navigator.clipboard.writeText(result.text);
      onToast?.("草稿已复制；请人工核对后自行发送");
    } catch {
      onToast?.("复制失败，请手动选择输出内容");
    }
  }

  function confirmOutput() {
    if (!result.text) return;
    setConfirmed(true);
    if (onConfirmReply && selectedCustomer && (roleId === "sales-consultant" || roleId === "wechat-service")) {
      onConfirmReply({ customer: selectedCustomer, message: result.text, assetIds: [] });
    }
    onToast?.("已标记为人工核对；不会自动发送");
  }

  async function importTextFiles(files: FileList | null) {
    if (!files?.length) return;
    const selected = Array.from(files);
    if (selected.length > 5) {
      onToast?.("一次最多导入 5 个文本文件；请分批选择，未导入本次文件");
      return;
    }
    const chunks: string[] = [];
    let skipped = 0;
    let decodeFailures = 0;
    for (const file of selected) {
      if (file.size > 1_000_000 || !/\.(txt|md|csv|json)$/i.test(file.name)) {
        skipped += 1;
        continue;
      }
      try {
        // File.text() replaces malformed UTF-8 bytes. A chat export that
        // cannot be decoded must be rejected rather than silently changed.
        const text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(await file.arrayBuffer()));
        if (text.includes("\0")) throw new Error("NUL byte");
        chunks.push(`【${file.name}】\n${text}`);
      } catch {
        decodeFailures += 1;
      }
    }
    const merged = `${input.trim()}${input.trim() && chunks.length ? "\n\n" : ""}${chunks.join("\n\n")}`;
    if (merged.length > getInferenceProfileInputBudget(mode)) {
      onToast?.(`导入内容超过当前档位 ${getInferenceProfileInputBudget(mode).toLocaleString()} 字，本次未导入；请将完整记录上传到知识库或分段导入`);
      return;
    }
    if (chunks.length) setInput(merged);
    const notices = [
      skipped ? `${skipped} 个文件不是可读文本或超过 1 MB，已跳过；图片/PDF请先放入知识库` : "",
      decodeFailures ? `${decodeFailures} 个文本文件 UTF-8 解码失败或含非法 NUL 字节，已跳过` : "",
    ].filter(Boolean);
    if (notices.length) onToast?.(`${notices.join("；")}${chunks.length ? "；其余文本已导入，请发送前检查" : ""}`);
    else if (chunks.length) onToast?.("已导入导出聊天文本，请发送前检查内容");
    setWechatDialogOpen(false);
  }

  const statusText = checking
    ? "检测模型连接中"
    : health?.reachable
      ? health.connectionKind === "protocol-mock" ? "协议模拟已连接" : "模型已连接"
      : "模型未连接";

  const inputLabel = experience === "chat" ? "输入产品问题" : role.inputLabel;
  const inputBudget = getInferenceProfileInputBudget(mode);

  return (
    <div className={cx(styles.root, Boolean(question) && styles.hasConversation)} data-testid="chat-ai-workspace">
      <header className={styles.header}>
        <h1>Chat-AI</h1>
        <div className={styles.tabs} role="group" aria-label="Chat-AI 工作模式">
          <button type="button" aria-pressed={experience === "chat"} disabled={busy} onClick={() => changeExperience("chat")}>Chat</button>
          <button type="button" aria-pressed={experience === "work"} disabled={busy} onClick={() => changeExperience("work")}>Work</button>
        </div>
        <button type="button" className={styles.iconButton} aria-label="新问题" title="清空本轮输入与资料" disabled={busy} onClick={newQuestion}><SquarePen size={19} /></button>
      </header>

      <div className={styles.stage}>
        {!question && <div className={styles.welcome}>
          <span className={styles.welcomeMark}><Sparkles size={23} /></span>
          <h2>{experience === "chat" ? "你好，今天想解决什么？" : "选一位 Agent，一起把工作做好。"}</h2>
          <p>{experience === "chat" ? "问产品，找资料，或整理一个想法。" : role.description}</p>
        </div>}

        {question && <section className={styles.conversation} aria-label="本轮问答" data-testid="agent-output">
          <div className={styles.questionBubble}><span>你</span><p>{question}</p></div>
          <article className={styles.response}>
            <div className={styles.answerHeading}><span className={styles.answerMark}><Sparkles size={16} /></span><strong>{experience === "chat" ? "LumaFlow" : role.name}</strong><span className={styles.outputStatus}>{busy ? <><Clock3 size={12} /> {elapsed} 秒</> : cancelled ? "已停止 · 内容可能不完整" : exhausted ? "预算已用尽 · 答案可能不完整" : result.text ? confirmed ? "已人工核对" : "待人工核对" : ""}</span></div>
            {busy && <p className={styles.generating} role="status">{toolParts.length ? `已观察到 ${toolParts.length} 次真实工具调用，正在整理…` : "正在等待本地模型，首次加载可能需要一些时间…"}</p>}
            {result.text && <div className={styles.answer} data-testid="agent-answer">{result.text}</div>}
            {result.sources.some((source) => source === "json" || source === "json-fallback") && <p className={styles.muted}>本轮使用 JSON 演示数据，不能作为正式库存或报价依据。</p>}
            {!busy && !error && !result.text && <p className={styles.muted}>{cancelled ? "本次生成已停止。" : "模型没有返回文字输出；不会使用本地规则冒充回答。"}</p>}
            {exhausted && <p className={styles.errorBox} role="alert">本轮生成预算已用尽，答案可能不完整。请缩小任务范围或调整档位后重试。</p>}
            {error && <div className={styles.errorBox} role="alert"><span>模型没有完成本轮任务：{error.message === "An error occurred." ? "本地推理服务出错或超时" : error.message}</span><button type="button" onClick={() => void submit(question)} disabled={!ready || busy} aria-label="重试本轮问题">重试</button></div>}
            {result.products.length > 0 && <div className={styles.productResults}>{result.products.map((record) => { const product = products.find((item) => item.id === record.id); return <div key={record.id}><button type="button" disabled={!product} onClick={() => product && onOpenProduct?.({ ...product, ...record })}><span><strong>{record.name}</strong><small>{record.sku} · {record.power}</small></span><ArrowRight size={15} /></button>{product && onAddToKit && <button type="button" className={styles.kitButton} onClick={() => onAddToKit(product.id)}><Plus size={14} /> 加入资料包</button>}</div>; })}</div>}
            {(receipt || result.evidence.length > 0 || toolParts.length > 0 || knowledgeCoverage.length > 0) && <details className={styles.sources}>
              <summary>查看依据与本轮模型 <ChevronIcon /></summary>
              <InferenceReceiptView receipt={receipt} />
              {result.sources.length > 0 && <p className={styles.muted}>本轮数据源：{result.sources.join("、")}{result.sources.some((source) => source === "json" || source === "json-fallback") ? " · 演示数据，非正式库存或报价依据" : ""}</p>}
              {result.evidence.length > 0 && <div className={styles.evidence} data-testid="search-evidence">{result.evidence.map((entry, index) => <div key={`${entry.title}-${index}`}><FileText size={14} /><span><strong>{entry.title}</strong><small>{entry.detail}</small></span></div>)}</div>}
              {toolParts.length > 0 && <div className={styles.toolTrace} aria-label="本轮工具调用">{toolParts.map((part) => <span key={part.toolCallId}>{part.type.replace(/^tool-/, "")} · {part.state === "output-available" ? "已返回" : part.state === "output-error" ? "失败" : "执行中"}</span>)}</div>}
              {knowledgeCoverage.length > 0 && <div className={styles.coverage} data-testid="knowledge-coverage"><strong>本轮知识上下文覆盖</strong>{knowledgeCoverage.map((entry) => <div key={entry.id}><span>{entry.name}</span><small>{entry.hasText ? `已纳入 ${entry.includedCharacters.toLocaleString()} / ${entry.totalCharacters.toLocaleString()} 字` : "没有可读正文"}{entry.truncated ? " · 已截断" : ""}</small></div>)}</div>}
            </details>}
            {result.text && <div className={styles.outputActions}><button type="button" disabled={busy} onClick={() => void copyOutput()}><Copy size={14} /> 复制</button><button type="button" disabled={busy || confirmed || cancelled || exhausted || Boolean(error)} onClick={confirmOutput}><CheckCircle2 size={14} /> {confirmed ? "已人工核对" : "标记人工核对"}</button></div>}
          </article>
        </section>}

        <div className={styles.composerArea}>
          <div className={styles.composer}>
            {experience === "work" && <div className={styles.roleRow}>
              <label><Sparkles size={14} /><select aria-label="选择 Agent 角色" value={roleId} disabled={busy} onChange={(event) => changeRole(event.target.value)}>{AGENT_ROLES.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
              {roleId === "wechat-service" && <button type="button" disabled={busy} onClick={() => setWechatDialogOpen(true)}><Upload size={14} /> 导入微信记录</button>}
            </div>}
            {selectedDocuments.length > 0 && <div className={styles.selectedFiles}>{selectedDocuments.map((document) => <button type="button" key={document.id} disabled={busy} onClick={() => toggleDocument(document)} aria-label={`移除 ${document.title}`}><Paperclip size={12} /><span>{document.title}</span><X size={12} /></button>)}</div>}
            {selectedCustomer && <div className={styles.selectedCustomer}><UserRound size={13} />{customerLabel(selectedCustomer)}<button type="button" aria-label="取消客户上下文" disabled={busy} onClick={() => setCustomerId("")}><X size={13} /></button></div>}
            <textarea ref={inputRef} className={styles.messageInput} value={input} maxLength={4_000} disabled={busy} aria-label={inputLabel} placeholder={experience === "chat" ? "向 Chat-AI 提问…" : role.inputPlaceholder} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
            <div className={styles.composerTools}>
              <button type="button" className={styles.iconButton} aria-label="添加资料与客户上下文" aria-expanded={contextOpen} disabled={busy} title="选择知识库文件或客户" onClick={() => setContextOpen((open) => !open)}><Plus size={21} /></button>
              <div className={styles.modelTools}><ModelRuntimeControls compact models={catalog.models} modelProfileId={catalog.modelProfileId} mode={mode} disabled={busy || catalog.loading} onModelChange={changeModel} onModeChange={changeMode} /></div>
              {busy ? <button type="button" className={styles.sendButton} aria-label="停止生成" onClick={() => { setCancelled(true); void stop(); }}><X size={18} /></button> : <button type="button" className={styles.sendButton} aria-label="发送问题" title={`交给 ${role.name}`} disabled={!ready || !input.trim() || input.trim().length > inputBudget} onClick={() => void submit()}><ArrowUp size={20} /></button>}
            </div>
          </div>
          <div className={styles.composerMeta}><span className={styles.connection} title={selectedModelName}><i className={health?.reachable ? styles.online : ""} />{statusText}<button type="button" aria-label="刷新模型连接" disabled={busy} onClick={() => { catalog.refresh(); refreshHealth(); }}><RefreshCw size={12} /></button></span><span>{input.length > 0 ? `${input.length.toLocaleString()} / ${inputBudget.toLocaleString()} 字 · ` : ""}Enter 发送 · Shift + Enter 换行</span></div>
          {input.length > inputBudget && <p className={styles.errorBox} role="alert">内容超过当前档位 {inputBudget.toLocaleString()} 字符，请缩小任务范围或选择 Instant；不会静默截断你的输入。</p>}
          {catalog.error && <p className={styles.errorBox} role="alert">{catalog.error}</p>}
          {!checking && !catalog.loading && !health?.reachable && <p className={styles.errorBox} role="alert">{catalog.modelProfileId === "local-qwen3-8b" ? "本地 Qwen3 8B 尚未连接，请双击 Start-LumaFlow.cmd 启动后刷新。" : catalog.modelProfileId === "local-qwen3-14b" ? "所选模型尚未连接。14B 安装命令：npm run local:setup -- --model=14b；也可以切回已安装的 8B。" : "所选模型尚未连接，请先配置对应的本地服务。"}</p>}

          {contextOpen && <section className={styles.contextPanel} data-testid="knowledge-picker" aria-label="参考资料与客户">
            <div className={styles.panelHeading}><h3>本轮参考资料</h3><span>{selectedDocumentIds.length} / 5</span>{onOpenKnowledge && <button type="button" onClick={onOpenKnowledge}><Upload size={14} /> 去知识库上传</button>}</div>
            <p className={styles.muted}>仅选择你希望本轮读取的文件；长文件按预算节选，覆盖范围随答案返回。产品资料共 {assets.length} 份。</p>
            {knowledgeLoading && <p className={styles.muted}>正在读取知识库文件…</p>}
            {!knowledgeLoading && knowledgeError && <p className={styles.errorBox} role="alert">{knowledgeError}。仍可粘贴记录。</p>}
            {!knowledgeLoading && !knowledgeError && knowledgeDocuments.length === 0 && <p className={styles.muted}>暂无文件，请先到知识库上传。</p>}
            <div className={styles.documentList}>{knowledgeDocuments.map((document) => <label key={document.id} className={cx(styles.documentRow, selectedDocumentIds.includes(document.id) && styles.documentSelected, !document.selectable && styles.documentDisabled)} title={document.unavailableReason}>
              <input type="checkbox" aria-label={`选择 ${document.title}`} checked={selectedDocumentIds.includes(document.id)} disabled={!document.selectable || busy || (!selectedDocumentIds.includes(document.id) && selectedDocumentIds.length >= 5)} onChange={() => toggleDocument(document)} />
              <span><strong>{document.title}</strong><small>{document.category} · {document.status}{!document.selectable ? ` · ${document.unavailableReason}` : ""}</small></span>
            </label>)}</div>
            {customers.length > 0 && <label className={styles.customerSelect}><UserRound size={14} /><select aria-label="选择客户" value={customerId} disabled={busy} onChange={(event) => setCustomerId(event.target.value)}><option value="">不绑定客户上下文</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customerLabel(customer)}</option>)}</select>{selectedCustomer && onOpenCustomer && <button type="button" onClick={() => onOpenCustomer(selectedCustomer.id)}>查看档案</button>}</label>}
          </section>}

          {!question && <div className={styles.suggestions} aria-label="提问示例">{(experience === "chat" ? QUICK_QUESTIONS : role.useCases.map((item) => `${item}：请根据我提供的资料整理`)).map((item) => <button key={item} type="button" disabled={busy} onClick={() => { setInput(item); inputRef.current?.focus(); }}><MessageCircle size={14} /><span>{item}</span><ArrowRight size={13} /></button>)}</div>}
          <p className={styles.disclaimer}><ShieldCheck size={12} />{experience === "work" ? role.outputHint : "内容由本地模型生成，请核对重要信息。"} 每次独立提问，不自动引用上一轮。{health?.connectionKind === "protocol-mock" ? "当前为协议模拟连接。" : ""}</p>
        </div>
      </div>

      <dialog ref={importDialog} className={styles.dialog} aria-label="导入微信记录" onCancel={() => setWechatDialogOpen(false)} onClose={() => setWechatDialogOpen(false)}>
        <header><h2>导入微信记录</h2><button type="button" aria-label="关闭微信导入说明" onClick={() => setWechatDialogOpen(false)}><X size={18} /></button></header>
        <p>个人微信：尚未连接；当前只读取你主动导出的内容。请粘贴聊天记录，或选择可读文本文件导入。</p><p>图片、PDF 和其他附件请先在知识库归档，再选择作为上下文。本入口不会生成二维码、索取密码或自动发送消息。</p>
        <label className={styles.fileImport}><Upload size={16} /><span>选择导出的文本记录（TXT / Markdown / CSV / JSON）</span><input ref={fileInputRef} type="file" multiple accept=".txt,.md,.csv,.json,text/plain,text/markdown" onChange={(event) => void importTextFiles(event.target.files)} /></label>
        <button type="button" onClick={() => setWechatDialogOpen(false)}>返回 Chat-AI</button>
      </dialog>
    </div>
  );
}

function ChevronIcon() { return <span aria-hidden="true">⌄</span>; }
