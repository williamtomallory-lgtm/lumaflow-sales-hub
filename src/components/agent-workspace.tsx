"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart } from "ai";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Copy,
  FileText,
  MessageCircle,
  Paperclip,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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

function sourceLabel(roleId: AgentRoleId): string {
  if (roleId === "wechat-service") return "个人微信导出记录 / 知识库文件";
  if (roleId === "sales-review") return "聊天记录 / 跟进纪要 / 知识库文件";
  if (roleId === "moments-operator") return "产品素材 / 知识库文件";
  return "客户问题 / 产品资料 / 后端工具";
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
  onConfirmReply,
  onOpenCustomer,
  onOpenProduct,
  onToast,
}: AgentWorkspaceProps) {
  const [roleId, setRoleId] = useState<AgentRoleId>(savedRole);
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

  function changeRole(value: string) {
    if (busy || !isAgentRoleId(value)) return;
    setRoleId(value);
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

  return (
    <div className={styles.root} data-testid="agent-workspace">
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Agent 工作台 · 角色驱动</span>
          <h2>从资料到草稿，结果可核对</h2>
          <p>角色决定模型的工作边界；知识文件和聊天记录只作为本轮上下文，不会自动发送或写回系统。</p>
        </div>
        <div className={styles.headerStatus} role="status"><span className={cx(styles.statusDot, health?.reachable && styles.statusDotOnline)} />{statusText}<small>{selectedModelName}</small></div>
      </header>

      <section className={styles.roleSection} aria-label="选择 Agent 角色">
        <div className={styles.sectionHeading}><div><span className={styles.kicker}>01 · 工作角色</span><h2>你现在要谁来帮忙？</h2></div><span className={styles.selectionNote}>当前：{role.name}</span></div>
        <div className={styles.roleGrid}>
          {AGENT_ROLES.map((option) => <button key={option.id} type="button" className={cx(styles.roleCard, roleId === option.id && styles.roleCardActive)} onClick={() => changeRole(option.id)} disabled={busy} aria-pressed={roleId === option.id}>
            <span className={styles.roleIcon}><Sparkles size={17} /></span>
            <span className={styles.roleCopy}><strong>{option.name}</strong><small>{option.description}</small><span className={styles.chips}>{option.useCases.map((useCase) => <em key={useCase}>{useCase}</em>)}</span></span>
            {roleId === option.id && <CheckCircle2 className={styles.roleCheck} size={17} />}
          </button>)}
        </div>
      </section>

      <section className={styles.modelBar} aria-label="模型与上下文设置">
        <label className={styles.modelSelect}><span>选择模型</span><select aria-label="选择模型" value={catalog.modelProfileId} disabled={busy || catalog.loading || !catalog.models.length} onChange={(event) => changeModel(event.target.value)}>
          {catalog.models.length ? catalog.models.map((model) => <option key={model.id} value={model.id}>{model.label} · {model.id === catalog.modelProfileId ? statusText : model.reachable ? "已连接" : model.configured ? "未连接" : "未配置"}</option>) : <option value={catalog.modelProfileId}>{catalog.loading ? "正在读取模型列表…" : "模型列表不可用"}</option>}
        </select><ChevronDown size={15} /></label>
        <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => { catalog.refresh(); refreshHealth(); }}><RefreshCw size={14} /> 刷新连接</button>
        <span className={styles.modelHint}>{catalog.selectedModel?.description ?? "模型列表尚未读取"}</span>
        {catalog.error && <span className={styles.errorText} role="alert">{catalog.error}</span>}
      </section>

      <ModelRuntimeControls models={catalog.models} modelProfileId={catalog.modelProfileId} mode={mode} disabled={busy || catalog.loading} onModelChange={changeModel} onModeChange={changeMode} />
      {!checking && !health?.reachable && <p className={styles.setupHint} role="alert">{catalog.modelProfileId === "local-qwen3-8b" ? "本地 Qwen3 8B 尚未连接，请在项目目录运行 npm run local:up 后刷新。" : "所选模型尚未连接，请先配置对应的本地服务。"}</p>}

      <div className={styles.workspaceGrid}>
        <section className={styles.inputPanel}>
          <div className={styles.panelHeading}><div><span className={styles.kicker}>02 · 工作输入</span><h2>{role.inputLabel}</h2></div><span className={styles.sourcePill}><MessageCircle size={13} /> {sourceLabel(roleId)}</span></div>
          {customers.length > 0 && <div className={styles.contextRow}>
            <label className={styles.customerSelect}><UserRound size={15} /><select aria-label="选择客户" value={customerId} disabled={busy} onChange={(event) => { setCustomerId(event.target.value); onOpenCustomer?.(event.target.value); }}><option value="">不绑定客户上下文</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customerLabel(customer)}</option>)}</select><ChevronDown size={14} /></label>
            {selectedCustomer && <span className={styles.customerNote}>仅提供客户身份上下文，不自动带入历史聊天</span>}
          </div>}
          <div className={styles.inputToolbar}>
            <span className={styles.inputLabel}><FileText size={15} /> {role.inputLabel}</span>
            {roleId === "wechat-service" && <button type="button" className={styles.importButton} onClick={() => setWechatDialogOpen(true)} disabled={busy}><Upload size={14} /> 导入微信记录</button>}
          </div>
          <textarea className={styles.messageInput} value={input} maxLength={4_000} disabled={busy} aria-label={role.inputLabel} placeholder={role.inputPlaceholder} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
          <div className={styles.inputFooter}><span>{input.length.toLocaleString()} / {getInferenceProfileInputBudget(mode).toLocaleString()} 字 · 较长记录请上传到知识库 · Ctrl/⌘ + Enter 发送</span>{busy ? <button type="button" className={styles.secondaryButton} onClick={() => { setCancelled(true); void stop(); }}><X size={15} /> 停止</button> : <button type="button" className={styles.primaryButton} disabled={!ready || !input.trim()} onClick={() => void submit()}><Send size={15} /> 交给 {role.name}</button>}</div>
          {error && <div className={styles.errorBox} role="alert"><span>模型没有完成本轮任务：{error.message === "An error occurred." ? "本地推理服务出错或超时" : error.message}</span><button type="button" onClick={() => void submit(question)} disabled={!ready || busy}>重试</button></div>}
          <div className={styles.boundaryNote}><ShieldCheck size={15} /><span>{role.outputHint}</span></div>
        </section>

        <section className={styles.documentsPanel} data-testid="knowledge-picker">
          <div className={styles.panelHeading}><div><span className={styles.kicker}>03 · 参考资料</span><h2>选择知识库文件</h2></div><span className={styles.fileCount}>{selectedDocumentIds.length} / 5 · 产品资料 {assets.length} 份</span></div>
          <p className={styles.panelDescription}>只把知识库中已归档、可读取的文本文件作为本轮上下文。未选择文件时，模型不会假装看过附件。</p>
          {knowledgeLoading && <p className={styles.muted}>正在读取知识库文件…</p>}
          {!knowledgeLoading && knowledgeError && <p className={styles.muted} role="alert">{knowledgeError}。你仍可以粘贴聊天记录继续工作。</p>}
          {!knowledgeLoading && !knowledgeError && knowledgeDocuments.length === 0 && <p className={styles.muted}>知识库暂无可选文本文件。请先在知识库归档文件。</p>}
          <div className={styles.documentList}>{knowledgeDocuments.map((document) => <label key={document.id} className={cx(styles.documentRow, selectedDocumentIds.includes(document.id) && styles.documentSelected, !document.selectable && styles.documentDisabled)} title={document.unavailableReason}>
            <input type="checkbox" aria-label={`选择 ${document.title}`} checked={selectedDocumentIds.includes(document.id)} disabled={!document.selectable || busy || (!selectedDocumentIds.includes(document.id) && selectedDocumentIds.length >= 5)} onChange={() => toggleDocument(document)} />
            <span className={styles.checkbox}>{selectedDocumentIds.includes(document.id) && <Check size={12} />}</span>
            <span className={styles.documentCopy}><strong>{document.title}</strong><small>{document.category} · {document.status} · {document.updatedAt}{document.size ? ` · ${document.size}` : ""}</small>{document.summary && <em>{document.summary}</em>}{!document.selectable && <i>{document.unavailableReason}</i>}</span>
          </label>)}</div>
          {selectedDocuments.length > 0 && <div className={styles.selectedFiles}><span>本轮已选</span>{selectedDocuments.map((document) => <em key={document.id}><Paperclip size={12} /> {document.title}</em>)}</div>}
        </section>
      </div>

      <section className={styles.outputPanel} data-testid="agent-output">
        <div className={styles.panelHeading}><div><span className={styles.kicker}>04 · Agent 输出</span><h2>{role.outputLabel}</h2></div><div className={styles.outputStatus}>{busy ? <><Clock3 size={14} /> 生成中 · {elapsed} 秒</> : exhausted ? "预算已用尽 · 结果可能不完整" : confirmed ? <><CheckCircle2 size={14} /> 已人工核对</> : result.text ? "待人工核对" : "尚未运行"}</div></div>
        <InferenceReceiptView receipt={receipt} />
        {exhausted && <p className={styles.errorBox} role="alert">本轮生成预算已用尽。请缩小任务范围或调整档位后重试，当前内容不作为完整复盘。</p>}
        {!question && <div className={styles.outputEmpty}><Sparkles size={25} /><strong>发送工作输入后，这里才会出现模型输出</strong><span>当前角色：{role.name} · 不预填规则答案、不伪造聊天或资料引用</span></div>}
        {question && <div className={styles.outputBody}>
          <div className={styles.questionStrip}><span>本轮输入</span><p>{question}</p></div>
          {busy && <p className={styles.generating} role="status">{toolParts.length ? `已观察到 ${toolParts.length} 次真实工具调用，正在整理…` : "正在等待本地模型，首次加载可能需要一些时间…"}</p>}
          {result.text && <p className={styles.answer} data-testid="agent-answer">{result.text}</p>}
          {!busy && error && <p className={styles.muted}>本轮没有可用输出，请修正输入或连接后重试。</p>}
          {!busy && !error && !result.text && <p className={styles.muted}>{cancelled ? "本次生成已停止，内容可能不完整。" : "模型没有返回文字输出；不会使用本地规则冒充回答。"}</p>}
          {toolParts.length > 0 && <div className={styles.toolTrace} aria-label="本轮工具调用"><span>真实工具轨迹</span>{toolParts.map((part) => <em key={part.toolCallId}>{part.type.replace(/^tool-/, "")} · {part.state === "output-available" ? "已返回" : part.state === "output-error" ? "失败" : "执行中"}</em>)}</div>}
          {result.products.length > 0 && <div className={styles.productResults}><span>工具返回产品</span>{result.products.map((record) => { const product = products.find((item) => item.id === record.id); return <button type="button" key={record.id} disabled={!product} onClick={() => product && onOpenProduct?.({ ...product, ...record })}><span><strong>{record.name}</strong><small>{record.sku} · {record.power} · {record.status}</small></span><ArrowRight size={15} /></button>; })}</div>}
          {result.evidence.length > 0 && <div className={styles.evidence}><span>本轮实际引用</span>{result.evidence.map((entry, index) => <div key={`${entry.title}-${index}`}><FileText size={14} /><span><strong>{entry.title}</strong><small>{entry.detail}</small></span></div>)}</div>}
          {knowledgeCoverage.length > 0 && <div className={styles.coverage} data-testid="knowledge-coverage"><span>本轮知识上下文覆盖</span>{knowledgeCoverage.map((entry) => <div key={entry.id}><strong>{entry.name}</strong><small>{entry.hasText ? `已纳入 ${entry.includedCharacters.toLocaleString()} / ${entry.totalCharacters.toLocaleString()} 字` : "没有可读正文"}{entry.truncated ? " · 已截断" : ""}</small></div>)}</div>}
          {result.text && <div className={styles.outputActions}><button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void copyOutput()}><Copy size={14} /> 复制草稿</button><button type="button" className={styles.primaryButton} disabled={busy || confirmed} onClick={confirmOutput}><CheckCircle2 size={14} /> {confirmed ? "已人工核对" : "标记人工核对"}</button></div>}
          <p className={styles.disclaimer}><ShieldCheck size={14} /> {role.outputHint} {health?.connectionKind === "protocol-mock" ? "当前为协议模拟连接，不能作为真实业务结论。" : "请以实际业务资料和人工判断为准。"}</p>
        </div>}
      </section>

      {wechatDialogOpen && <div className={styles.dialogLayer} role="presentation"><button type="button" className={styles.dialogScrim} aria-label="关闭微信导入说明" onClick={() => setWechatDialogOpen(false)} /><section className={styles.dialog} role="dialog" aria-modal="true" aria-label="导入微信记录"><div className={styles.dialogHeading}><div><span className={styles.kicker}>微信记录导入</span><h2>先使用导出的聊天和文件</h2></div><button type="button" aria-label="关闭" onClick={() => setWechatDialogOpen(false)}><X size={17} /></button></div><p>个人微信：尚未连接；当前只读取你主动导出的内容。请把导出的聊天记录粘贴到输入区，或选择可读文本文件导入。</p><p>图片、PDF和其他附件请先在知识库归档，再回到本页选择；本入口不会生成二维码、索取密码或自动发送消息。</p><label className={styles.fileImport}><Upload size={16} /><span>选择导出的文本记录（TXT / Markdown / CSV / JSON）</span><input ref={fileInputRef} type="file" multiple accept=".txt,.md,.csv,.json,text/plain,text/markdown" onChange={(event) => void importTextFiles(event.target.files)} /></label><button type="button" className={styles.secondaryButton} onClick={() => setWechatDialogOpen(false)}>返回工作台</button></section></div>}
    </div>
  );
}
