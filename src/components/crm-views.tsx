"use client";

import Link from "next/link";

import {
  AlertCircle,
  Archive,
  ArrowRight,
  CalendarDays,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Copy,
  FileBadge,
  FileImage,
  FileSpreadsheet,
  FileText,
  Flag,
  Mail,
  MessageCircle,
  MessageSquareText,
  Paperclip,
  Phone,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Tag,
  UserRound,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart } from "ai";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createCustomerViaApi, createFollowupViaApi, listFollowupsViaApi, updateFollowupStatusViaApi } from "@/lib/client/backend-api";
import { useModelHealth } from "@/hooks/use-model-health";
import { useModelCatalog } from "@/hooks/use-model-catalog";
import type { SalesAgentUIMessage } from "@/lib/ai/sales-agent";
import type { AssistantReasoningMode } from "@/lib/contracts/api";
import type { CalendarEvent } from "@/lib/contracts/calendar";
import { createCalendarEvent, getCalendarIdentity, listCalendarEvents, listCalendarPresence, sendCalendarHeartbeat, updateCalendarEvent, updateCalendarMemberStatus, type CalendarPresence } from "@/lib/client/calendar-api";
import { connectSharedCalendar, currentCalendarConnection, disconnectSharedCalendar, usesSharedCalendarConnection, type CalendarConnection, type CalendarIdentity } from "@/lib/client/calendar-connection";
import type { Product } from "@/lib/catalog";
import {
  analyzeCustomerMessage,
  buildFollowupMessage,
  filterFollowupTasks,
  formatFollowupDate,
  formatQuoteAmount,
  getCustomerById,
  getLatestInboundMessage,
  isTaskOverdue,
  searchCustomers,
  type CrmAsset,
  type Customer,
  type CustomerMessageAnalysis,
  type FollowupFilter,
  type FollowupTask,
  type FollowupTaskStatus,
  type Urgency,
} from "@/lib/crm";
import styles from "./crm-views.module.css";

export type CrmToastHandler = (message: string) => void;

export type ReplyConfirmation = {
  customer: Customer;
  message: string;
  assetIds: string[];
};

export type SalesAssistantViewProps = {
  customers: Customer[];
  products: Product[];
  assets: CrmAsset[];
  initialCustomerId?: string;
  initialMessage?: string;
  onConfirmReply?: (confirmation: ReplyConfirmation) => void;
  onOpenCustomer?: (customerId: string) => void;
  onOpenProduct?: (product: Product) => void;
  onToast?: CrmToastHandler;
};

export type CustomersViewProps = {
  customers: Customer[];
  initialCustomerId?: string;
  onAnalyzeCustomer?: (customer: Customer) => void;
  onOpenCustomer?: (customerId: string) => void;
  onToast?: CrmToastHandler;
};

export type FollowupViewProps = {
  customers: Customer[];
  tasks: FollowupTask[];
  referenceDate?: Date | string;
  timeZone?: string;
  onOpenCustomer?: (customerId: string) => void;
  onTaskStatusChange?: (task: FollowupTask, status: FollowupTaskStatus) => void;
  onToast?: CrmToastHandler;
};

type CalendarViewMode = "month" | "week" | "day";
type CalendarItemSource = "followup" | "shared";
type CalendarItem = {
  id: string;
  title: string;
  description: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  kind: CalendarEvent["kind"];
  status: CalendarEvent["status"];
  participantEmails: string[];
  createdByName?: string;
  updatedByName?: string;
  source: CalendarItemSource;
  task?: FollowupTask;
  event?: CalendarEvent;
};

type CalendarEventDraft = {
  title: string;
  description: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  kind: CalendarEvent["kind"];
  participantEmails: string[];
};


function cx(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(" ");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric" }).format(date);
}

function localDateKey(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addCalendarDays(value: Date, amount: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + amount);
  return next;
}

function startOfCalendarDay(value: Date): Date {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfCalendarWeek(value: Date): Date {
  const day = startOfCalendarDay(value);
  const mondayOffset = (day.getDay() + 6) % 7;
  return addCalendarDays(day, -mondayOffset);
}

function calendarRangeFor(mode: CalendarViewMode, cursor: Date): { from: Date; to: Date; days: Date[] } {
  if (mode === "day") {
    const from = startOfCalendarDay(cursor);
    return { from, to: addCalendarDays(from, 1), days: [from] };
  }
  if (mode === "week") {
    const from = startOfCalendarWeek(cursor);
    const days = Array.from({ length: 7 }, (_, index) => addCalendarDays(from, index));
    return { from, to: addCalendarDays(from, 7), days };
  }
  const firstOfMonth = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const from = startOfCalendarWeek(firstOfMonth);
  const lastOfMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const to = addCalendarDays(startOfCalendarWeek(addCalendarDays(lastOfMonth, 1)), 7);
  const days: Date[] = [];
  for (let day = from; day < to; day = addCalendarDays(day, 1)) days.push(day);
  return { from, to, days };
}

function calendarHeading(mode: CalendarViewMode, cursor: Date): string {
  if (mode === "month") return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(cursor);
  if (mode === "day") return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(cursor);
  const week = calendarRangeFor("week", cursor).days;
  const start = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(week[0]);
  const end = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(week[6]);
  return `${start} – ${end}`;
}

function calendarEventTime(value: string, allDay = false): string {
  if (allDay) return "全天";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未设置";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

function calendarKindLabel(kind: CalendarEvent["kind"]): string {
  if (kind === "followup") return "跟进";
  if (kind === "task") return "任务";
  if (kind === "focus") return "专注时间";
  return "会议";
}

function calendarStatusLabel(status: CalendarEvent["status"]): string {
  if (status === "completed") return "已完成";
  if (status === "cancelled") return "已取消";
  return "已确认";
}

function calendarMemberStatusLabel(status: string, kind: CalendarEvent["kind"]): string {
  if (status === "accepted") return "已接受";
  if (status === "declined") return "已拒绝";
  if (status === "in_progress") return "进行中";
  if (status === "done") return "已完成";
  return kind === "meeting" ? "待确认" : "待处理";
}

function calendarItemFromTask(task: FollowupTask): CalendarItem {
  const start = new Date(task.dueAt);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    id: `followup:${task.id}`,
    title: task.title,
    description: task.description,
    startAt: task.dueAt,
    endAt: end.toISOString(),
    allDay: false,
    kind: "followup",
    status: task.status === "completed" ? "completed" : "confirmed",
    participantEmails: [],
    source: "followup",
    task,
  };
}

function calendarItemFromEvent(event: CalendarEvent): CalendarItem {
  return {
    id: `shared:${event.id}`,
    title: event.title,
    description: event.description,
    startAt: event.startAt,
    endAt: event.endAt,
    allDay: event.allDay,
    kind: event.kind,
    status: event.status,
    participantEmails: event.participantEmails,
    createdByName: event.createdByName,
    updatedByName: event.updatedByName,
    source: "shared",
    event,
  };
}

function calendarTaskFromEvent(event: CalendarEvent): FollowupTask {
  return {
    id: `calendar-event:${event.id}`,
    customerId: "",
    customerName: event.createdByName,
    company: "协作日历",
    title: event.title,
    description: event.description,
    type: "内部任务",
    priority: "中",
    status: event.status === "completed" ? "completed" : "open",
    dueAt: event.startAt,
    dueLabel: calendarEventTime(event.startAt, event.allDay),
    createdAt: event.createdAt,
  };
}

function isCalendarEventTask(task: FollowupTask): boolean {
  return task.id.startsWith("calendar-event:");
}

function calendarEventIdFromTask(task: FollowupTask): string | undefined {
  return isCalendarEventTask(task) ? task.id.slice("calendar-event:".length) : undefined;
}

function calendarTaskContext(task: FollowupTask): string {
  return isCalendarEventTask(task) ? `${task.customerName}创建 · 协作日历` : `${task.company} · ${task.customerName}`;
}

function calendarTaskTypeLabel(task: FollowupTask, events: CalendarEvent[]): string {
  const eventId = calendarEventIdFromTask(task);
  if (!eventId) return task.type;
  const kind = events.find((event) => event.id === eventId)?.kind;
  return kind ? `协作${calendarKindLabel(kind)}` : "协作事件";
}

async function copyText(value: string, onToast?: CrmToastHandler, successMessage = "已复制") {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    onToast?.(successMessage);
  } catch {
    onToast?.("复制失败，请手动选择文本");
  }
}

function stageClass(stage: Customer["stage"]): string {
  const map: Record<Customer["stage"], string> = {
    新客: styles.stageNew,
    跟进中: styles.stageFollow,
    报价中: styles.stageQuote,
    已成交: styles.stageWon,
    沉睡: styles.stageDormant,
  };
  return map[stage];
}

function urgencyClass(urgency: Urgency): string {
  return urgency === "高" ? styles.urgencyHigh : urgency === "中" ? styles.urgencyMedium : styles.urgencyLow;
}

function priorityClass(priority: FollowupTask["priority"]): string {
  return priority === "高" ? styles.priorityHigh : priority === "中" ? styles.priorityMedium : styles.priorityLow;
}

function assetIcon(type: CrmAsset["type"]): LucideIcon {
  if (type === "图片") return FileImage;
  if (type === "参数表") return FileSpreadsheet;
  if (type === "证书") return FileBadge;
  return FileText;
}

function Avatar({ customer, small = false }: { customer: Customer; small?: boolean }) {
  return <span className={cx(styles.avatar, small && styles.avatarSmall)} aria-hidden="true">{customer.avatar}</span>;
}

function StageBadge({ stage }: { stage: Customer["stage"] }) {
  return <span className={cx(styles.stageBadge, stageClass(stage))}>{stage}</span>;
}

function PriorityBadge({ priority }: { priority: FollowupTask["priority"] }) {
  return <span className={cx(styles.priorityBadge, priorityClass(priority))}><Flag size={11} /> {priority}优先</span>;
}

function ProductVisual({ product, compact = false }: { product: Product; compact?: boolean }) {
  return <div className={cx(styles.productVisual, compact && styles.productVisualCompact)} style={{ background: product.gradient }}><span>{product.category}</span><strong>{product.model}</strong></div>;
}

function Metric({ icon: Icon, label, value, detail, tone }: { icon: LucideIcon; label: string; value: string; detail: string; tone: "green" | "gold" | "blue" | "rose" }) {
  return <div className={styles.metric}><span className={cx(styles.metricIcon, styles[`metric${tone[0].toUpperCase()}${tone.slice(1)}`])}><Icon size={17} /></span><div><small>{label}</small><strong>{value}</strong><em>{detail}</em></div></div>;
}

function EmptyPanel({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail: string }) {
  return <div className={styles.emptyPanel}><Icon size={24} /><strong>{title}</strong><p>{detail}</p></div>;
}

function CustomerSelect({ customers, value, onChange, disabled = false }: { customers: Customer[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return <label className={styles.selectField}><UserRound size={16} /><select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} aria-label="选择客户">{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.company} · {customer.name}</option>)}</select><ChevronDown size={16} /></label>;
}

export function SalesAssistantView({ customers, products, assets, initialCustomerId, initialMessage, onConfirmReply, onOpenCustomer, onOpenProduct, onToast }: SalesAssistantViewProps) {
  const initialCustomer = getCustomerById(initialCustomerId ?? "", customers) ?? customers[0];
  const initialInbound = getLatestInboundMessage(initialCustomer);
  const [customerId, setCustomerId] = useState(initialCustomer.id);
  const [message, setMessage] = useState(initialMessage ?? initialInbound?.content ?? "");
  const [analysis, setAnalysis] = useState<CustomerMessageAnalysis>(() => analyzeCustomerMessage(initialMessage ?? initialInbound?.content ?? "", initialCustomer.name, products, assets));
  const [draft, setDraft] = useState(analysis.replyDraft);
  const [selectedAssets, setSelectedAssets] = useState<string[]>(analysis.recommendedAssets.slice(0, 4).map((asset) => asset.id));
  const [confirmed, setConfirmed] = useState(false);
  const [draftEdited, setDraftEdited] = useState(false);
  const [reasoningMode, setReasoningMode] = useState<AssistantReasoningMode>("fast");
  const { models, modelProfileId, selectedModel, selectModel, loading: loadingModels, error: modelCatalogError, refresh: refreshModelCatalog } = useModelCatalog();
  const transport = useMemo(() => new DefaultChatTransport<SalesAgentUIMessage>({ api: "/api/v1/assistant/chat" }), []);
  const { messages: modelMessages, sendMessage, status: modelStatus, error: modelError, stop, setMessages, clearError } = useChat<SalesAgentUIMessage>({ transport, throttle: 40 });
  const { health: modelHealth, checking: checkingModel, refresh: refreshModelHealth } = useModelHealth(modelProfileId);
  const modelBusy = modelStatus === "streaming" || modelStatus === "submitted";
  const modelReady = Boolean(selectedModel && !loadingModels && !checkingModel && modelHealth?.reachable);
  const selectedModelName = modelHealth?.model ?? selectedModel?.model ?? "等待读取模型";
  const customer = getCustomerById(customerId, customers) ?? initialCustomer;

  const modelText = useMemo(() => modelMessages
    .filter((entry) => entry.role === "assistant")
    .flatMap((entry) => entry.parts)
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim(), [modelMessages]);

  const toolParts = useMemo(() => modelMessages
    .filter((entry) => entry.role === "assistant")
    .flatMap((entry) => entry.parts)
    .filter(isToolUIPart), [modelMessages]);

  const toolProductRecommendations = useMemo(() => {
    const byId = new Map(products.map((product) => [product.id, product]));
    return modelMessages.flatMap((entry) => entry.parts).flatMap((part) => {
      if (part.type !== "tool-searchProducts" || part.state !== "output-available") return [];
      return part.output.products.flatMap((record) => {
        const product = byId.get(record.id);
        return product ? [{ product: { ...product, ...record }, score: record.matchScore, reasons: record.matchedFields }] : [];
      });
    });
  }, [modelMessages, products]);

  const visibleDraft = modelText && !draftEdited ? modelText : draft;

  function updateLocalAnalysis(nextMessage = message, nextCustomer = customer) {
    const next = analyzeCustomerMessage(nextMessage, nextCustomer.name, products, assets);
    setAnalysis(next);
    setDraft(next.replyDraft);
    setDraftEdited(false);
    setSelectedAssets(next.recommendedAssets.slice(0, 4).map((asset) => asset.id));
    setConfirmed(false);
  }

  function selectCustomer(nextId: string) {
    const nextCustomer = getCustomerById(nextId, customers) ?? initialCustomer;
    const inbound = getLatestInboundMessage(nextCustomer);
    const nextMessage = inbound?.content ?? "";
    setCustomerId(nextCustomer.id);
    setMessage(nextMessage);
    updateLocalAnalysis(nextMessage, nextCustomer);
    setMessages([]);
    clearError();
  }

  function changeModel(nextId: string) {
    if (modelBusy || nextId === modelProfileId || !models.some((model) => model.id === nextId)) return;
    selectModel(nextId);
    setMessages([]);
    clearError();
    setDraft("");
    setDraftEdited(false);
    setConfirmed(false);
    setSelectedAssets([]);
    setReasoningMode("fast");
  }

  function refreshModels() {
    refreshModelCatalog();
    refreshModelHealth();
  }

  async function runModelAnalysis() {
    if (modelBusy || !modelReady) return;
    const cleanMessage = message.trim();
    if (!cleanMessage) {
      onToast?.("请先输入客户消息");
      return;
    }
    updateLocalAnalysis(cleanMessage, customer);
    setMessages([]);
    setConfirmed(false);
    await sendMessage({ text: cleanMessage }, {
      body: {
        mode: reasoningMode,
        customerId: customer.id,
        modelProfileId,
      },
    });
  }

  function toggleAsset(assetId: string) {
    setSelectedAssets((current) => current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId]);
    setConfirmed(false);
  }

  function confirmReply() {
    if (!visibleDraft.trim()) {
      onToast?.("请先填写回复内容");
      return;
    }
    setConfirmed(true);
    onConfirmReply?.({ customer, message: visibleDraft.trim(), assetIds: selectedAssets });
    onToast?.(onConfirmReply ? `已交给回复记录流程：${customer.name}` : `已在本页面确认给${customer.name}的草稿，尚未保存到数据库`);
  }

  const hasModelProductSearch = toolParts.some((part) => part.type === "tool-searchProducts" && part.state === "output-available");
  const analysisProducts = hasModelProductSearch ? toolProductRecommendations : analysis.recommendedProducts;
  const selectedAssetObjects = analysis.recommendedAssets.filter((asset) => selectedAssets.includes(asset.id));

  return (
    <div className={styles.root} data-testid="sales-assistant-view">
      <div className={styles.viewHeader}>
        <div><span className={styles.eyebrow}>Sales Assistant · 二期</span><h1>把客户消息变成下一步动作</h1><p>识别意图和紧急度，引用产品资料，生成一份可编辑、待确认的回复草稿。</p></div>
        <CustomerSelect customers={customers} value={customerId} onChange={selectCustomer} disabled={modelBusy} />
      </div>

      <div className={styles.metricStrip} aria-label="销售助手指标">
        <Metric icon={MessageSquareText} label="模型服务" value={checkingModel ? "检测中" : modelHealth?.reachable ? modelHealth.connectionKind === "protocol-mock" ? "模拟" : "在线" : "离线"} detail={selectedModelName} tone="gold" />
        <Metric icon={Sparkles} label="本轮模型状态" value={modelBusy ? "生成中" : modelError ? "失败" : modelText ? "已完成" : "待开始"} detail={`${toolParts.length} 次受控工具调用`} tone="green" />
        <Metric icon={Paperclip} label="资料候选" value={String(analysis.recommendedAssets.length).padStart(2, "0")} detail="来自后端产品资料" tone="blue" />
        <Metric icon={CheckCircle2} label="人工确认" value={confirmed ? "已确认" : "待确认"} detail="模型不能自动发送" tone="rose" />
      </div>

      <div className={styles.assistantLayout}>
        <section className={cx(styles.card, styles.messageCard)}>
          <div className={styles.cardHeader}><div><span className={styles.sectionKicker}>01 · 客户消息</span><h2>发送给销售 Agent</h2></div><span className={cx(styles.demoPill, !modelHealth?.reachable && styles.modelOffline)} role="status"><span /> {checkingModel ? "检测中" : modelHealth?.reachable ? modelHealth.connectionKind === "protocol-mock" ? "协议模拟已连接" : "模型已连接" : "模型未连接"}</span></div>
          <div className={styles.modelPicker}>
            <div className={styles.modelPickerRow}>
              <label className={styles.modelSelect}><span>选择模型</span><select aria-label="选择模型" value={modelProfileId} disabled={modelBusy || loadingModels || models.length === 0} onChange={(event) => changeModel(event.target.value)}>{models.length ? models.map((model) => <option key={model.id} value={model.id}>{model.label} · {model.id === modelProfileId ? checkingModel ? "检测中" : modelHealth?.reachable ? modelHealth.connectionKind === "protocol-mock" ? "协议模拟" : "已连接" : "未连接" : model.reachable ? model.connectionKind === "protocol-mock" ? "协议模拟" : "已连接" : model.configured ? "未连接" : "未配置"}</option>) : <option value={modelProfileId}>{loadingModels ? "正在读取模型列表…" : "模型列表不可用"}</option>}</select></label>
              <button className={styles.secondaryButton} disabled={modelBusy || loadingModels || checkingModel} onClick={refreshModels} aria-label="刷新模型连接"><RefreshCw size={14} /> 刷新</button>
            </div>
            {selectedModel && <p className={styles.modelDescription}>{selectedModel.description}</p>}
            {modelProfileId === "local-qwen3-8b" && <div className={styles.modelCapabilities}><span>本地演示</span><span>文字对话</span><span>业务工具</span>{selectedModel?.contextTokens && <span>{selectedModel.contextTokens.toLocaleString()} tokens 上下文</span>}</div>}
            <small className={styles.modelIdentifier}>当前模型：{selectedModelName}</small>
            {modelCatalogError && <p className={styles.modelSetupHint} role="alert">{modelCatalogError}</p>}
            {!checkingModel && !modelHealth?.reachable && <p className={styles.modelSetupHint}>{modelProfileId === "local-qwen3-8b" ? <>本地模型尚未启动。在项目目录运行 <code>npm run local:up</code>，完成后点击刷新。</> : "所选模型尚未连接，请检查后端模型配置和服务状态，然后点击刷新。"}</p>}
            {modelBusy && <p className={styles.modelSetupHint}>模型正在生成，结束或停止后可以切换。</p>}
          </div>
          <div className={styles.customerBanner}><Avatar customer={customer} /><div><strong>{customer.name} · {customer.company}</strong><span>{customer.role} · {customer.lastContactLabel}</span></div><button className={styles.linkButton} onClick={() => onOpenCustomer?.(customer.id)}>查看档案 <ArrowRight size={13} /></button><StageBadge stage={customer.stage} /></div>
          <label className={styles.textareaLabel} htmlFor="crm-customer-message">客户原消息</label>
          <textarea id="crm-customer-message" className={styles.messageTextarea} value={message} onChange={(event) => { setMessage(event.target.value); setConfirmed(false); }} placeholder="粘贴客户的微信、邮件或电话纪要…" />
          <div className={styles.messageFooter}><span>{message.length} 字 · 模型档位 <select aria-label="模型推理档位" value={reasoningMode} disabled={modelBusy} onChange={(event) => setReasoningMode(event.target.value as AssistantReasoningMode)}><option value="fast">FAST · 快速</option><option value="normal">NORMAL · 标准</option><option value="deep">DEEP · 深度</option></select></span>{modelBusy ? <button className={styles.secondaryButton} onClick={() => void stop()}><X size={15} /> 停止</button> : <button className={styles.primaryButton} disabled={!modelReady} onClick={() => void runModelAnalysis()}><Sparkles size={15} /> 调用模型分析</button>}</div>
          {modelError && <div className={styles.modelError}><AlertCircle size={14} /><span>{modelError.message}</span></div>}
          <div className={styles.tipLine}><ShieldCheck size={14} /><span>分析只引用当前产品资料，不会替客户承诺未经审批的正式价格。</span></div>
        </section>

        <section className={cx(styles.card, styles.analysisCard)}>
          <div className={styles.cardHeader}><div><span className={styles.sectionKicker}>02 · 本地预检</span><h2>规则初筛与 Agent 轨迹</h2></div><span className={styles.confidence}><ShieldCheck size={14} /> {analysis.confidence}% 规则匹配</span></div>
          <div className={styles.analysisSummary}><MessageCircle size={17} /><p>{analysis.summary || "等待客户消息"}</p></div>
          <div className={styles.signalGrid}>
            <div><span>客户意图</span><strong>{analysis.intentLabel}</strong><small>{analysis.intent}</small></div>
            <div><span>紧急程度</span><strong className={urgencyClass(analysis.urgency)}>{analysis.urgency}优先</strong><small>{analysis.urgencyReason}</small></div>
          </div>
          <div className={styles.signalSection}><div className={styles.subheading}><span>识别到的信号</span><em>{analysis.signals.length} 项</em></div>{analysis.signals.length > 0 ? <div className={styles.signalChips}>{analysis.signals.map((signal) => <span key={signal}><Check size={12} /> {signal}</span>)}</div> : <p className={styles.mutedText}>还没有足够的关键词，建议补充场景、数量或时间。</p>}</div>
          <div className={styles.toolTrace}><div className={styles.subheading}><span>受控工具调用</span><em>{toolParts.length} 次</em></div>{toolParts.length ? toolParts.map((part) => <div key={part.toolCallId}><CheckCircle2 size={13} /><span>{part.type.replace(/^tool-/, "")}</span><em>{part.state === "output-available" ? "已核对后端数据" : part.state === "output-error" ? "执行失败" : "执行中"}</em></div>) : <p className={styles.mutedText}>模型运行后，产品搜索、库存和资料核对会显示在这里。</p>}</div>
          <div className={styles.nextAction}><div><CalendarClock size={16} /><span><strong>建议下一步</strong><small>{analysis.urgency === "高" ? "优先在今天内回复并锁定库存" : "补齐项目参数后再给方案或报价"}</small></span></div><ArrowRight size={16} /></div>
        </section>

        <section className={cx(styles.card, styles.recommendationCard)}>
          <div className={styles.cardHeader}><div><span className={styles.sectionKicker}>03 · 产品与资料</span><h2>{hasModelProductSearch ? "模型工具查询的产品" : "后端数据的本地规则候选"}</h2></div><span className={styles.countPill}>{analysisProducts.length} 款产品 · {analysis.recommendedAssets.length} 份资料</span></div>
          {analysisProducts.length > 0 ? <div className={styles.recommendationList}>{analysisProducts.map((recommendation) => <button className={styles.recommendationRow} key={recommendation.product.id} onClick={() => onOpenProduct?.(recommendation.product)}><ProductVisual product={recommendation.product} compact /><span className={styles.recommendationCopy}><strong>{recommendation.product.name}</strong><small>{recommendation.product.model} · {recommendation.product.power} · {recommendation.product.status}</small><em>{recommendation.reasons.join("、")}</em></span><span className={styles.matchScore}>{Math.min(99, recommendation.score + 48)}<small>匹配</small></span><ChevronRight size={16} /></button>)}</div> : <EmptyPanel icon={Search} title="暂未匹配产品" detail="补充品类、功率、颜色或使用场景，才能给出可靠推荐。" />}
          {analysis.recommendedAssets.length > 0 && <div className={styles.assetPick}><div className={styles.subheading}><span>建议随回复发送的附件</span><em>{selectedAssets.length} 份已选</em></div><div className={styles.assetPickList}>{analysis.recommendedAssets.map((asset) => { const Icon = assetIcon(asset.type); const selected = selectedAssets.includes(asset.id); return <label key={asset.id} className={cx(styles.assetPickRow, selected && styles.assetSelected)}><input type="checkbox" checked={selected} onChange={() => toggleAsset(asset.id)} /><span className={styles.checkbox}>{selected && <Check size={12} />}</span><Icon size={15} /><span><strong>{asset.name}</strong><small>{asset.productName} · {asset.type} · {asset.size}</small></span>{selected && <CheckCircle2 className={styles.assetCheck} size={15} />}</label>; })}</div></div>}
          {selectedAssetObjects.length === 0 && analysis.recommendedAssets.length > 0 && <p className={styles.mutedText}>尚未选择附件，发送前可以勾选需要的资料。</p>}
        </section>

        <section className={cx(styles.card, styles.draftCard)}>
          <div className={styles.cardHeader}><div><span className={styles.sectionKicker}>04 · 回复草稿</span><h2>业务员确认后再发送</h2></div>{confirmed ? <span className={styles.confirmedPill}><CheckCircle2 size={14} /> 已确认待发送</span> : <span className={styles.reviewPill}><AlertCircle size={14} /> 待人工确认</span>}</div>
          <div className={styles.draftMeta}><div className={styles.aiMark}><Sparkles size={15} /></div><span><strong>{modelText ? modelHealth?.connectionKind === "protocol-mock" ? "协议模拟草稿" : "模型流式草稿" : draft ? "本地规则草稿" : "等待生成草稿"} · 可直接编辑</strong><small>{modelText ? `${selectedModelName} · Agent 已调用 ${toolParts.length} 次受控工具` : "尚未调用模型"}</small></span><button className={styles.iconButton} disabled={!modelReady || modelBusy} onClick={() => void runModelAnalysis()} aria-label="重新生成回复"><RefreshCw size={15} /></button></div>
          <textarea className={styles.draftTextarea} value={visibleDraft} onChange={(event) => { setDraft(event.target.value); setDraftEdited(true); setConfirmed(false); }} aria-label="可编辑回复草稿" />
          <div className={styles.draftActions}><button className={styles.secondaryButton} disabled={modelBusy} onClick={() => copyText(visibleDraft, onToast, "回复草稿已复制") }><Copy size={15} /> 复制草稿</button><button className={styles.primaryButton} disabled={modelBusy} onClick={confirmReply}><CheckCircle2 size={15} /> 确认本次草稿</button></div>
          <p className={styles.disclaimer}><ShieldCheck size={14} /> 当前确认保留在本页面，尚未保存到数据库；请复制后人工发送。</p>
        </section>
      </div>
    </div>
  );
}

export function CustomersView({ customers, initialCustomerId, onAnalyzeCustomer, onOpenCustomer, onToast }: CustomersViewProps) {
  const [customerState, setCustomerState] = useState(customers);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(initialCustomerId ?? customers[0]?.id ?? "");
  const [creating, setCreating] = useState(false);
  const filteredCustomers = useMemo(() => searchCustomers(query, customerState), [customerState, query]);
  const selectedCustomer = getCustomerById(selectedId, customerState) ?? filteredCustomers[0];

  function selectCustomer(customer: Customer) {
    setSelectedId(customer.id);
    onOpenCustomer?.(customer.id);
  }

  return (
    <div className={styles.root} data-testid="customers-view">
      <div className={styles.viewHeader}><div><span className={styles.eyebrow}>Customer & Conversation · 复盘 Agent</span><h1>客户档案，连同每一次上下文</h1><p>完整聊天记录、客户记忆与知识库文件可以一键交给复盘 Agent 分析。</p></div><button className={styles.primaryButton} onClick={() => setCreating(true)}><Plus size={16} /> 新建客户</button></div>
      <div className={styles.metricStrip} aria-label="客户指标"><Metric icon={UsersRound} label="客户总数" value={String(customerState.length).padStart(2, "0")} detail={`${customerState.filter((customer) => customer.stage !== "沉睡").length} 个活跃档案`} tone="green" /><Metric icon={MessageCircle} label="未读会话" value={String(customerState.reduce((sum, customer) => sum + customer.unreadCount, 0)).padStart(2, "0")} detail="需要及时处理" tone="gold" /><Metric icon={CircleDollarSign} label="机会金额" value={formatQuoteAmount(customerState.reduce((sum, customer) => sum + customer.estimatedValue, 0))} detail="含报价中客户" tone="blue" /><Metric icon={Tag} label="待确认需求" value={String(customerState.reduce((sum, customer) => sum + customer.needs.filter((need) => need.status === "待确认").length, 0)).padStart(2, "0")} detail="可转成跟进任务" tone="rose" /></div>

      <div className={styles.customersLayout}>
        <aside className={cx(styles.card, styles.customerListCard)}>
          <div className={styles.listHeader}><div><span className={styles.sectionKicker}>客户目录</span><h2>全部客户 <em>{filteredCustomers.length}</em></h2></div><button className={styles.iconButton} aria-label="客户筛选" onClick={() => onToast?.("可按阶段、行业或负责人筛选") }><Tag size={15} /></button></div>
          <label className={styles.searchField}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索公司、联系人、标签" aria-label="搜索客户" /><kbd>⌘ K</kbd></label>
          <div className={styles.customerFilters}><button className={!query ? styles.filterActive : ""} onClick={() => setQuery("")}>全部</button><button onClick={() => setQuery("报价中")}>报价中</button><button onClick={() => setQuery("跟进中")}>跟进中</button><button onClick={() => setQuery("未读")}>未读</button></div>
          <div className={styles.customerList}>{filteredCustomers.length > 0 ? filteredCustomers.map((customer) => <button className={cx(styles.customerRow, selectedCustomer?.id === customer.id && styles.customerRowSelected)} key={customer.id} onClick={() => selectCustomer(customer)}><Avatar customer={customer} /><span className={styles.customerRowCopy}><strong>{customer.name}<small>{customer.company}</small></strong><em>{customer.lastContactLabel}</em><span>{customer.tags.slice(0, 2).join(" · ")}</span></span><span className={styles.customerRowEnd}><StageBadge stage={customer.stage} />{customer.unreadCount > 0 && <b>{customer.unreadCount}</b>}</span></button>) : <EmptyPanel icon={Search} title={customerState.length ? "没有匹配客户" : "后端尚未返回客户"} detail={customerState.length ? "换一个公司名、联系人或标签。" : "可新建真实客户，或连接 PostgreSQL 后导入客户数据。"} />}</div>
        </aside>

        {selectedCustomer ? <CustomerProfile key={selectedCustomer.id} customer={selectedCustomer} onAnalyze={() => onAnalyzeCustomer?.(selectedCustomer)} onToast={onToast} /> : <section className={styles.card}><EmptyPanel icon={UsersRound} title="没有客户数据" detail="页面不会生成示例客户；请从后端导入或新建真实客户。" /></section>}
      </div>
      {creating && <CustomerForm onClose={() => setCreating(false)} onCreated={(customer) => { setCustomerState((current) => [customer, ...current]); setSelectedId(customer.id); setQuery(""); setCreating(false); onOpenCustomer?.(customer.id); onToast?.("客户已保存到后端"); }} />}
    </div>
  );
}

function CustomerProfile({ customer, onAnalyze, onToast }: { customer: Customer; onAnalyze: () => void; onToast?: CrmToastHandler }) {
  const latestInbound = getLatestInboundMessage(customer);
  const [showAllMessages, setShowAllMessages] = useState(false);
  return (
    <section className={styles.profileColumn}>
      <div className={cx(styles.card, styles.profileHero)}><div className={styles.profileIdentity}><Avatar customer={customer} /><div><div className={styles.profileTitle}><h2>{customer.company}</h2><StageBadge stage={customer.stage} /></div><p>{customer.name} · {customer.role} · {customer.industry}</p><span><Tag size={13} /> {customer.tags.join(" · ")}</span></div></div><div className={styles.profileActions}><button className={styles.secondaryButton} onClick={() => copyText([customer.email, customer.phone].filter(Boolean).join("\n"), onToast, "客户联系方式已复制")}><Phone size={15} /> 联系客户</button><button className={styles.primaryButton} onClick={onAnalyze}><Sparkles size={15} /> 复盘全部会话</button></div><div className={styles.profileStats}><div><small>机会金额</small><strong>{formatQuoteAmount(customer.estimatedValue)}</strong></div><div><small>负责人</small><strong>{customer.owner}</strong></div><div><small>最后联系</small><strong>{customer.lastContactLabel}</strong></div><div><small>来源</small><strong>{customer.source}</strong></div></div></div>
      <div className={styles.profileGrid}>
        <section className={cx(styles.card, styles.contactsCard)}><div className={styles.listHeader}><div><span className={styles.sectionKicker}>联系人</span><h2>联系方式</h2></div></div><div className={styles.contactList}>{customer.contacts.map((contact) => <div className={styles.contactRow} key={contact.id}><span className={styles.contactAvatar}>{contact.name.slice(0, 1)}</span><div><strong>{contact.name}{contact.isPrimary && <em>主要联系人</em>}</strong><small>{contact.role} · 首选 {contact.preferredChannel}</small><span>{contact.email && <a href={`mailto:${contact.email}`}><Mail size={13} /> {contact.email}</a>}{contact.phone && <a href={`tel:${contact.phone}`}><Phone size={13} /> {contact.phone}</a>}</span></div></div>)}{!customer.contacts.length && <EmptyPanel icon={UsersRound} title="暂无联系人明细" detail="当前只显示后端已保存的数据。" />}</div></section>
        <section className={cx(styles.card, styles.memoryCard)}><div className={styles.listHeader}><div><span className={styles.sectionKicker}>上下文记忆</span><h2>销售应该记住的事</h2></div><ShieldCheck size={17} className={styles.safeIcon} /></div><div className={styles.memoryList}>{customer.contextMemory.map((memory, index) => <div key={memory}><span>{String(index + 1).padStart(2, "0")}</span><p>{memory}</p></div>)}</div></section>
        <section className={cx(styles.card, styles.conversationCard)}><div className={styles.listHeader}><div><span className={styles.sectionKicker}>Conversation · {customer.conversations.length}</span><h2>聊天记录</h2></div><button className={styles.secondaryButton} onClick={() => setShowAllMessages((current) => !current)}><Archive size={14} /> {showAllMessages ? "收起" : "查看全部"}</button></div>{latestInbound && <div className={styles.latestMessage}><span><MessageCircle size={14} /> 待处理消息</span><p>{latestInbound.content}</p><small>{latestInbound.channel} · {formatDateTime(latestInbound.timestamp)}</small><button className={styles.linkButton} onClick={onAnalyze}>交给销售助手 <ArrowRight size={14} /></button></div>}<div className={styles.timeline}>{(showAllMessages ? customer.conversations : customer.conversations.slice(-3)).map((message) => <div className={cx(styles.timelineItem, message.direction === "inbound" ? styles.timelineInbound : message.direction === "internal" ? styles.timelineInternal : styles.timelineOutbound)} key={message.id}><span className={styles.timelineDot} /><div><div className={styles.timelineMeta}><strong>{message.author}</strong><span>{message.channel} · {formatDateTime(message.timestamp)}</span></div><p>{message.content}</p></div></div>)}</div></section>
        <section className={cx(styles.card, styles.needsCard)}><div className={styles.listHeader}><div><span className={styles.sectionKicker}>需求</span><h2>客户要解决的问题</h2></div></div><div className={styles.needList}>{customer.needs.map((need) => <div className={styles.needRow} key={need.id}><span className={cx(styles.needStatus, need.status === "待确认" && styles.needPending)}>{need.status === "已解决" ? <CheckCircle2 size={14} /> : <Clock3 size={14} />}</span><div><strong>{need.title}</strong><p>{need.detail}</p><small>更新于 {formatDateTime(need.updatedAt)}</small></div><PriorityBadge priority={need.priority} /></div>)}{!customer.needs.length && <EmptyPanel icon={Clock3} title="暂无客户需求" detail="当前只显示后端已保存的数据。" />}</div></section>
        <section className={cx(styles.card, styles.quotesCard)}><div className={styles.listHeader}><div><span className={styles.sectionKicker}>Quote history · {customer.quotes.length}</span><h2>历史报价记录</h2></div></div>{customer.quotes.length > 0 ? <div className={styles.quoteList}>{customer.quotes.map((quote) => <div className={styles.quoteRow} key={quote.id}><span className={styles.quoteIcon}><CircleDollarSign size={15} /></span><div><strong>{quote.quoteNo}</strong><p>{quote.productNames.join("、")}</p><small>{formatDate(quote.createdAt)} · 有效至 {formatDate(quote.validUntil)}</small></div><div className={styles.quoteAmount}><strong>{formatQuoteAmount(quote.amount)}</strong><span className={cx(styles.quoteStatus, quote.status === "已接受" ? styles.quoteAccepted : quote.status === "审批中" ? styles.quoteReview : quote.status === "已过期" ? styles.quoteExpired : "")}>{quote.status}</span></div></div>)}</div> : <EmptyPanel icon={CircleDollarSign} title="还没有历史报价" detail="客户的既有报价会在这里作为复盘上下文展示。" />}</section>
      </div>
    </section>
  );
}

function CustomerForm({ onClose, onCreated }: { onClose: () => void; onCreated: (customer: Customer) => void }) {
  const [form, setForm] = useState({ company: "", name: "", role: "", industry: "", location: "", email: "", phone: "", owner: "", source: "手动录入" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try { onCreated(await createCustomerViaApi(form)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "保存客户失败"); }
    finally { setBusy(false); }
  }
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  return <div className={styles.todoModal} role="dialog" aria-modal="true" aria-label="新建客户"><form onSubmit={submit} className={styles.todoForm}><h2>新建真实客户</h2><p>只有你填写并成功保存到后端的内容才会出现在客户列表。</p>
    <label>公司名称<input required maxLength={200} value={form.company} onChange={(event) => update("company", event.target.value)} /></label>
    <label>联系人姓名<input required maxLength={120} value={form.name} onChange={(event) => update("name", event.target.value)} /></label>
    <label>职位<input maxLength={120} value={form.role} onChange={(event) => update("role", event.target.value)} placeholder="可留空" /></label>
    <label>行业<input maxLength={120} value={form.industry} onChange={(event) => update("industry", event.target.value)} placeholder="可留空" /></label>
    <label>地区<input maxLength={200} value={form.location} onChange={(event) => update("location", event.target.value)} placeholder="可留空" /></label>
    <label>邮箱<input type="email" maxLength={254} value={form.email} onChange={(event) => update("email", event.target.value)} placeholder="可留空" /></label>
    <label>电话<input maxLength={60} value={form.phone} onChange={(event) => update("phone", event.target.value)} placeholder="可留空" /></label>
    <label>负责人<input maxLength={120} value={form.owner} onChange={(event) => update("owner", event.target.value)} placeholder="可留空" /></label>
    <label>数据来源<input required maxLength={120} value={form.source} onChange={(event) => update("source", event.target.value)} /></label>
    {error && <p role="alert">{error}</p>}<div><button type="button" className={styles.secondaryButton} disabled={busy} onClick={onClose}>取消</button><button className={styles.primaryButton} disabled={busy || !form.company.trim() || !form.name.trim()}>{busy ? "保存中…" : "保存到后端"}</button></div>
  </form></div>;
}


const followupFilterLabels: Record<FollowupFilter, string> = { all: "全部任务", overdue: "已逾期", today: "今天", upcoming: "即将到期", completed: "已完成" };

function CalendarEventChip({ item, compact = false, onSelect }: { item: CalendarItem; compact?: boolean; onSelect: (item: CalendarItem) => void }) {
  const statusClass = item.status === "cancelled" ? styles.calendarEventCancelled : item.status === "completed" ? styles.calendarEventCompleted : styles.calendarEventConfirmed;
  const href = item.event ? `/calendar/events/${encodeURIComponent(item.event.id)}` : `/calendar/followups/${encodeURIComponent(item.task!.id)}`;
  return <Link href={href} className={cx(styles.calendarEventChip, statusClass, compact && styles.calendarEventCompact)} data-status={item.status} onClick={() => onSelect(item)} aria-label={`${item.title}，${calendarKindLabel(item.kind)}，${calendarStatusLabel(item.status)}${item.createdByName ? `，由${item.createdByName}创建` : "，当前部署任务"}，打开详情`}>
    <span className={styles.calendarEventDot} />
    <span className={styles.calendarEventChipTitle}>{item.title}</span>
    {item.createdByName && <span className={styles.calendarEventChipOwner}>{item.createdByName}</span>}
    {!compact && <span className={styles.calendarEventChipTime}>{calendarEventTime(item.startAt, item.allDay)}</span>}
    {!compact && <span className={styles.calendarEventChipStatus}>{calendarStatusLabel(item.status)}</span>}
  </Link>;
}

function CalendarMembers({ event, identity, presence, busy, onChange }: { event: CalendarEvent; identity: CalendarIdentity | null; presence: CalendarPresence; busy: boolean; onChange: (status: CalendarEvent["memberStatuses"][string]) => void }) {
  const emails = [event.createdByEmail, ...event.participantEmails.filter((email) => email !== event.createdByEmail)];
  const myEmail = identity?.email.toLowerCase();
  const myStatus = myEmail && emails.includes(myEmail) ? event.memberStatuses?.[myEmail] ?? "pending" : null;
  const choices: Array<CalendarEvent["memberStatuses"][string]> = event.kind === "meeting" ? ["pending", "accepted", "declined"] : ["pending", "in_progress", "done"];
  if (myStatus && !choices.includes(myStatus)) choices.unshift(myStatus);
  return <div className={styles.calendarMemberPanel} aria-label="参与成员状态">
    <strong>成员进展</strong>
    <div className={styles.calendarMemberList}>{emails.map((email) => <div key={email} className={styles.calendarMemberRow}>
      <span className={styles.calendarMemberAvatar}>{(event.memberNames?.[email] || presence[email]?.name || email).slice(0, 1).toUpperCase()}</span>
      <span><b>{event.memberNames?.[email] || presence[email]?.name || (email === event.createdByEmail ? event.createdByName : email)}</b><small>{email}{email === event.createdByEmail ? " · 创建人" : ""}{email === myEmail ? " · 我" : ""}</small></span>
      <span className={cx(styles.calendarPresence, presence[email]?.online && styles.calendarPresenceOnline)} title={presence[email]?.lastSeenAt ? `最后活动：${formatDate(presence[email].lastSeenAt)}` : "暂无活动记录"}>{presence[email]?.online ? "在线" : presence[email] ? "离线" : "未上线"}</span>
      <em>{calendarMemberStatusLabel(event.memberStatuses?.[email] ?? (email === event.createdByEmail && event.kind === "meeting" ? "accepted" : "pending"), event.kind)}</em>
    </div>)}</div>
    {myStatus && <label className={styles.calendarMyStatus}>我的状态<select aria-label="我的参与状态" value={myStatus} disabled={busy} onChange={(change) => onChange(change.target.value as CalendarEvent["memberStatuses"][string])}>{choices.map((status) => <option key={status} value={status}>{calendarMemberStatusLabel(status, event.kind)}</option>)}</select></label>}
  </div>;
}

function CalendarDayEventList({ day, items, onSelect, limit = 5 }: { day: Date; items: CalendarItem[]; onSelect: (item: CalendarItem) => void; limit?: number }) {
  const dayItems = items.filter((item) => localDateKey(item.startAt) === localDateKey(day)).sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  return <>
    {dayItems.slice(0, limit).map((item) => <CalendarEventChip key={item.id} item={item} compact onSelect={onSelect} />)}
    {dayItems.length > limit && <span className={styles.calendarMoreEvents}>+ {dayItems.length - limit} 项</span>}
  </>;
}

function CalendarMonthView({ days, cursor, items, onSelect }: { days: Date[]; cursor: Date; items: CalendarItem[]; onSelect: (item: CalendarItem) => void }) {
  const weekdayLabels = ["一", "二", "三", "四", "五", "六", "日"];
  return <div className={styles.calendarMonthGrid} data-testid="calendar-month-view" role="grid" aria-label={`${calendarHeading("month", cursor)}月视图`}>
    {weekdayLabels.map((label) => <div key={label} className={styles.calendarWeekday} role="columnheader">{label}</div>)}
    {days.map((day) => {
      const isCurrentMonth = day.getMonth() === cursor.getMonth();
      const isToday = localDateKey(day) === localDateKey(new Date());
      return <div key={localDateKey(day)} className={cx(styles.calendarDayCell, !isCurrentMonth && styles.calendarDayOutside, isToday && styles.calendarDayToday)} role="gridcell">
        <div className={styles.calendarDayNumber}><span>{day.getDate()}</span>{isToday && <em>今天</em>}</div>
        <div className={styles.calendarDayEvents}><CalendarDayEventList day={day} items={items} onSelect={onSelect} /></div>
      </div>;
    })}
  </div>;
}

function CalendarWeekView({ days, items, onSelect }: { days: Date[]; items: CalendarItem[]; onSelect: (item: CalendarItem) => void }) {
  return <div className={styles.calendarWeekGrid} data-testid="calendar-week-view" role="grid" aria-label="周视图">
    {days.map((day) => <div key={localDateKey(day)} className={cx(styles.calendarWeekColumn, localDateKey(day) === localDateKey(new Date()) && styles.calendarDayToday)} role="gridcell">
      <div className={styles.calendarWeekHeader}><span>{new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(day)}</span><strong>{day.getDate()}</strong></div>
      <div className={styles.calendarWeekEvents}><CalendarDayEventList day={day} items={items} onSelect={onSelect} limit={12} /></div>
    </div>)}
  </div>;
}

function CalendarDayView({ day, items, onSelect }: { day: Date; items: CalendarItem[]; onSelect: (item: CalendarItem) => void }) {
  const dayItems = items.filter((item) => localDateKey(item.startAt) === localDateKey(day)).sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  const allDayItems = dayItems.filter((item) => item.allDay);
  const timedItems = dayItems.filter((item) => !item.allDay);
  return <div className={styles.calendarDayAgenda} data-testid="calendar-day-view" role="region" aria-label="日视图">
    {allDayItems.length > 0 && <div className={styles.calendarAllDayRow}><span>全天</span><div>{allDayItems.map((item) => <CalendarEventChip key={item.id} item={item} onSelect={onSelect} />)}</div></div>}
    <div className={styles.calendarTimeline}>{Array.from({ length: 24 }, (_, index) => index).map((hour) => {
      const hourItems = timedItems.filter((item) => new Date(item.startAt).getHours() === hour);
      return <div key={hour} className={styles.calendarTimelineRow}><time>{String(hour).padStart(2, "0")}:00</time><div>{hourItems.length ? hourItems.map((item) => <CalendarEventChip key={item.id} item={item} onSelect={onSelect} />) : <span className={styles.calendarEmptySlot}>—</span>}</div></div>;
    })}</div>
  </div>;
}

export function FollowupView({ customers, tasks, referenceDate, timeZone, onOpenCustomer, onTaskStatusChange, onToast }: FollowupViewProps) {
  const [taskState, setTaskState] = useState(tasks);
  const [filter, setFilter] = useState<FollowupFilter>("all");
  const [query, setQuery] = useState("");
  const [now, setNow] = useState<Date | null>(null);
  const [zone, setZone] = useState(timeZone ?? "UTC");
  const [selectedTaskId, setSelectedTaskId] = useState(tasks[0]?.id ?? "");
  const [script, setScript] = useState(() => tasks[0] ? buildFollowupMessage(tasks[0], getCustomerById(tasks[0].customerId, customers)) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [calendarMode, setCalendarMode] = useState<CalendarViewMode>("month");
  const [calendarAnchorDate] = useState(() => {
    const initial = referenceDate ? new Date(referenceDate) : new Date();
    return Number.isNaN(initial.getTime()) ? new Date() : initial;
  });
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const initial = referenceDate ? new Date(referenceDate) : new Date();
    return Number.isNaN(initial.getTime()) ? new Date() : initial;
  });
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [calendarError, setCalendarError] = useState("");
  const [calendarSelectedId, setCalendarSelectedId] = useState("");
  const [calendarEditor, setCalendarEditor] = useState<{ mode: "create" | "edit"; event?: CalendarEvent } | null>(null);
  const [calendarSubmitting, setCalendarSubmitting] = useState(false);
  const [calendarRefreshKey, setCalendarRefreshKey] = useState(0);
  const [localCalendarMode, setLocalCalendarMode] = useState(false);
  const [calendarConnection, setCalendarConnection] = useState<CalendarConnection | null>(null);
  const [calendarIdentity, setCalendarIdentity] = useState<CalendarIdentity | null>(null);
  const [calendarPresence, setCalendarPresence] = useState<CalendarPresence>({});
  const [calendarConnecting, setCalendarConnecting] = useState(false);
  const effectiveDate = referenceDate ?? now;
  const calendarRange = useMemo(() => calendarRangeFor(calendarMode, calendarCursor), [calendarCursor, calendarMode]);
  const calendarTaskEvents = useMemo(() => taskState.map(calendarItemFromTask), [taskState]);
  const calendarQueryRange = useMemo(() => {
    const from = new Date(calendarAnchorDate);
    from.setDate(from.getDate() - 30);
    from.setHours(0, 0, 0, 0);
    const to = new Date(calendarAnchorDate);
    to.setDate(to.getDate() + 330);
    to.setHours(23, 59, 59, 999);
    return { from, to };
  }, [calendarAnchorDate]);
  const sharedCalendarEvents = useMemo(() => {
    const taskIds = new Set(taskState.map((task) => task.id));
    return calendarEvents.filter((event) => !(event.kind === "followup" && taskIds.has(event.id))).map(calendarItemFromEvent);
  }, [calendarEvents, taskState]);
  const calendarEventTasks = useMemo(() => {
    const taskIds = new Set(taskState.map((task) => task.id));
    return calendarEvents.filter((event) => event.status !== "cancelled" && !taskIds.has(event.id)).map(calendarTaskFromEvent);
  }, [calendarEvents, taskState]);
  const visibleTasks = useMemo(() => {
    return [...taskState, ...calendarEventTasks];
  }, [calendarEventTasks, taskState]);
  const filteredTasks = useMemo(() => effectiveDate ? filterFollowupTasks(visibleTasks, filter, query, effectiveDate, zone) : visibleTasks, [filter, query, effectiveDate, zone, visibleTasks]);
  const selectedTask = visibleTasks.find((task) => task.id === selectedTaskId) ?? filteredTasks[0];
  const overdue = (task: FollowupTask) => Boolean(effectiveDate && isTaskOverdue(task, effectiveDate));
  const overdueCount = visibleTasks.filter(overdue).length;
  const selectedCalendarItem = useMemo(() => {
    const allItems = [...calendarTaskEvents, ...sharedCalendarEvents];
    return allItems.find((item) => item.id === calendarSelectedId) ?? null;
  }, [calendarSelectedId, calendarTaskEvents, sharedCalendarEvents]);
  const reminderTasks = useMemo(() => {
    const anchor = effectiveDate ? new Date(effectiveDate) : new Date();
    const horizon = anchor.getTime() + 7 * 86_400_000;
    return visibleTasks.filter((task) => task.status === "open" && (isTaskOverdue(task, anchor) || new Date(task.dueAt).getTime() <= horizon)).sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()).slice(0, 3);
  }, [effectiveDate, visibleTasks]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setLocalCalendarMode(usesSharedCalendarConnection());
      const saved = currentCalendarConnection();
      setCalendarConnection(saved);
      if (saved) setCalendarIdentity(saved.viewer);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (localCalendarMode && !calendarConnection) return;
    let active = true;
    void getCalendarIdentity().then((identity) => { if (active) setCalendarIdentity(identity); }).catch(() => {});
    return () => { active = false; };
  }, [localCalendarMode, calendarConnection]);

  useEffect(() => {
    if (usesSharedCalendarConnection() && !currentCalendarConnection()) return;
    const heartbeat = () => { if (document.visibilityState === "visible") void sendCalendarHeartbeat().catch(() => {}); };
    heartbeat();
    const interval = window.setInterval(heartbeat, 30_000);
    document.addEventListener("visibilitychange", heartbeat);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", heartbeat); };
  }, [calendarConnection]);

  useEffect(() => {
    let active = true;
    void listFollowupsViaApi().then((records) => { if (active) setTaskState(records); }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "读取待办失败"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const loadCalendar = async () => {
      setCalendarError("");
      try {
        const ranges = [{ from: calendarQueryRange.from.toISOString(), to: calendarQueryRange.to.toISOString() }];
        if (calendarRange.from < calendarQueryRange.from || calendarRange.to > calendarQueryRange.to) {
          ranges.push({ from: calendarRange.from.toISOString(), to: calendarRange.to.toISOString() });
        }
        const [pages, presence] = await Promise.all([
          Promise.all(ranges.map((range) => listCalendarEvents(range))),
          listCalendarPresence(ranges[0]).catch(() => ({} as CalendarPresence)),
        ]);
        if (active) {
          setCalendarEvents([...new Map(pages.flat().map((event) => [event.id, event])).values()]);
          setCalendarPresence(presence);
        }
      } catch (caught) {
        if (active) setCalendarError(caught instanceof Error ? caught.message : "协作日历暂时无法读取，请登录后重试");
      } finally {
        if (active) setCalendarLoading(false);
      }
    };
    void loadCalendar();
    const interval = localCalendarMode && !calendarConnection ? null : window.setInterval(() => { void loadCalendar(); }, 20_000);
    return () => { active = false; if (interval !== null) window.clearInterval(interval); };
  }, [calendarQueryRange.from, calendarQueryRange.to, calendarRange.from, calendarRange.to, calendarRefreshKey, localCalendarMode, calendarConnection]);

  useEffect(() => {
    if (referenceDate) return;
    const update = () => { setNow(new Date()); setZone(timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone); };
    const first = window.setTimeout(update, 0);
    const interval = window.setInterval(update, 60_000);
    return () => { window.clearTimeout(first); window.clearInterval(interval); };
  }, [referenceDate, timeZone]);

  async function refreshTasks() {
    setBusy(true); setError("");
    try { setTaskState(await listFollowupsViaApi()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "读取待办失败"); }
    finally { setBusy(false); }
  }
  function selectTask(task: FollowupTask) {
    setSelectedTaskId(task.id);
    const calendarEventId = calendarEventIdFromTask(task);
    const calendarEvent = calendarEventId ? calendarEvents.find((item) => item.id === calendarEventId) : undefined;
    setScript(calendarEvent?.description ?? (isCalendarEventTask(task) ? task.description : buildFollowupMessage(task, getCustomerById(task.customerId, customers))));
  }
  async function changeStatus(task: FollowupTask) {
    setBusy(true); setError("");
    try {
      const calendarEventId = calendarEventIdFromTask(task);
      if (calendarEventId) {
        const event = calendarEvents.find((item) => item.id === calendarEventId);
        if (!event) throw new Error("协作事件已不在当前日历范围内，请刷新后重试");
        const nextStatus: CalendarEvent["status"] = task.status === "completed" ? "confirmed" : "completed";
        const updated = await updateCalendarEvent(event.id, { status: nextStatus, revision: event.revision });
        setCalendarEvents((current) => current.map((item) => item.id === updated.id ? updated : item));
        onToast?.(nextStatus === "completed" ? "协作事件已完成" : "协作事件已重新打开");
        return;
      }
      const updated = await updateFollowupStatusViaApi(task.id, task.status === "completed" ? "open" : "completed");
      setTaskState((current) => current.map((item) => item.id === task.id ? updated : item));
      onTaskStatusChange?.(updated, updated.status);
      onToast?.(updated.status === "completed" ? "任务完成状态已保存到后端" : "任务已重新打开并保存");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败，任务状态未改变"); }
    finally { setBusy(false); }
  }
  const dateText = (value: string) => now || referenceDate ? formatFollowupDate(value, zone) : "正在读取本地日期…";
  function moveCalendarCursor(amount: number) {
    const next = new Date(calendarCursor);
    if (calendarMode === "month") next.setMonth(next.getMonth() + amount);
    else next.setDate(next.getDate() + amount * (calendarMode === "week" ? 7 : 1));
    setCalendarCursor(next);
    setCalendarSelectedId("");
  }
  function jumpToToday() { setCalendarCursor(new Date()); setCalendarSelectedId(""); }
  function selectCalendarItem(item: CalendarItem) {
    setCalendarSelectedId(item.id);
    if (item.task) selectTask(item.task);
    else if (item.source === "shared" && item.event) {
      const task = calendarTaskFromEvent(item.event);
      setSelectedTaskId(task.id);
      setScript(item.description);
    }
  }
  async function saveCalendarEvent(draft: CalendarEventDraft, event?: CalendarEvent) {
    setCalendarSubmitting(true); setCalendarError("");
    try {
      if (event) {
        const updated = await updateCalendarEvent(event.id, { ...draft, revision: event.revision });
        setCalendarEvents((current) => current.map((item) => item.id === updated.id ? updated : item));
        onToast?.("协作日历事件已更新");
      } else {
        const created = await createCalendarEvent(draft);
        setCalendarEvents((current) => [created, ...current.filter((item) => item.id !== created.id)]);
        setFilter("all");
        setQuery("");
        setSelectedTaskId(`calendar-event:${created.id}`);
        setScript(created.description);
        setCalendarCursor(new Date(created.startAt));
        onToast?.("协作事件已创建，并加入跟进待办");
      }
      setCalendarEditor(null);
    } catch (caught) {
      setCalendarError(caught instanceof Error ? caught.message : "保存协作日历失败，请刷新后重试");
    } finally { setCalendarSubmitting(false); }
  }
  async function toggleCalendarStatus(event: CalendarEvent) {
    setCalendarSubmitting(true); setCalendarError("");
    try {
      const nextStatus: CalendarEvent["status"] = event.status === "cancelled" ? "confirmed" : event.status === "completed" ? "confirmed" : "cancelled";
      const updated = await updateCalendarEvent(event.id, { status: nextStatus, revision: event.revision });
      setCalendarEvents((current) => current.map((item) => item.id === updated.id ? updated : item));
      onToast?.(nextStatus === "cancelled" ? "事件已取消" : "事件已恢复");
    } catch (caught) {
      setCalendarError(caught instanceof Error ? caught.message : "更新事件失败，可能已被其他协作者修改");
    } finally { setCalendarSubmitting(false); }
  }
  async function toggleCalendarFollowupStatus(event: CalendarEvent) {
    setCalendarSubmitting(true); setCalendarError("");
    try {
      const nextStatus: CalendarEvent["status"] = event.status === "completed" ? "confirmed" : "completed";
      const updated = await updateCalendarEvent(event.id, { status: nextStatus, revision: event.revision });
      setCalendarEvents((current) => current.map((item) => item.id === updated.id ? updated : item));
      onToast?.(nextStatus === "completed" ? "共享跟进已完成" : "共享跟进已重新打开");
    } catch (caught) {
      setCalendarError(caught instanceof Error ? caught.message : "更新共享跟进失败，可能已被其他协作者修改");
    } finally { setCalendarSubmitting(false); }
  }
  async function changeCalendarMemberStatus(event: CalendarEvent, status: CalendarEvent["memberStatuses"][string]) {
    setCalendarSubmitting(true); setCalendarError("");
    try {
      const updated = await updateCalendarMemberStatus(event.id, event.revision, status);
      setCalendarEvents((current) => current.map((item) => item.id === updated.id ? updated : item));
      onToast?.("你的参与状态已同步给团队");
    } catch (caught) { setCalendarError(caught instanceof Error ? caught.message : "更新参与状态失败，请刷新后重试"); }
    finally { setCalendarSubmitting(false); }
  }
  async function connectCalendar() {
    setCalendarConnecting(true); setCalendarError("");
    try {
      const connected = await connectSharedCalendar();
      setCalendarConnection(connected);
      setCalendarIdentity(connected.viewer);
      setCalendarRefreshKey((current) => current + 1);
      onToast?.(`已连接为 ${connected.viewer.name}，现在可以查看团队共享日历`);
    } catch (caught) { setCalendarError(caught instanceof Error ? caught.message : "连接云端日历失败"); }
    finally { setCalendarConnecting(false); }
  }
  function disconnectCalendar() {
    disconnectSharedCalendar();
    setCalendarConnection(null);
    setCalendarIdentity(null);
    setCalendarEvents([]);
    setCalendarPresence({});
    setCalendarSelectedId("");
    setCalendarError("");
    onToast?.("已断开此浏览器的协作日历连接");
  }
  const calendarNeedsLogin = /登录|401|unauthor/i.test(calendarError);
  const calendarDisconnected = localCalendarMode && !calendarConnection;

  return <div className={styles.root} data-testid="followup-view">
    <div className={styles.viewHeader}><div><span className={styles.eyebrow}>Shared Follow-up Workspace</span><h1>跟进待办</h1><p data-testid="followup-today">{effectiveDate ? formatFollowupDate(effectiveDate, zone, false) : "正在读取今天日期…"} · {zone}</p><p>客户任务只在当前部署中保存；协作事件连接云端后按账号和邀请成员同步。</p></div><div className={styles.followupHeaderActions}><button className={styles.secondaryButton} disabled={!customers.length || busy} onClick={() => setCreating(true)}><Plus size={16} />新建当前部署任务</button><button className={styles.primaryButton} disabled={calendarDisconnected} onClick={() => setCalendarEditor({ mode: "create" })}><CalendarDays size={16} />新建协作事件</button></div></div>
    {error && <p role="alert">{error}</p>}
    <div className={styles.metricStrip} aria-label="跟进指标">
      <Metric icon={AlertCircle} label="待处理任务" value={String(visibleTasks.filter((task) => task.status === "open").length)} detail="含协作事件" tone="gold" />
      <Metric icon={Clock3} label="今日到期" value={String(effectiveDate ? filterFollowupTasks(visibleTasks, "today", "", effectiveDate, zone).length : 0)} detail="按本地日期" tone="rose" />
      <Metric icon={Flag} label="已逾期" value={String(overdueCount)} detail="截止时间已过" tone="blue" />
      <Metric icon={CheckCircle2} label="已完成" value={String(visibleTasks.filter((task) => task.status === "completed").length)} detail="所有已完成任务" tone="green" />
    </div>
    {reminderTasks.length > 0 && <div className={styles.followupReminderStrip} role="status"><div className={styles.followupReminderTitle}><Clock3 size={15} /><strong>跟进提醒</strong><span>优先处理最近的任务</span></div><div className={styles.followupReminderItems}>{reminderTasks.map((task) => <button type="button" key={task.id} onClick={() => selectTask(task)}><span className={overdue(task) ? styles.reminderOverdue : styles.reminderUpcoming}>{overdue(task) ? "已逾期" : "即将到期"}</span><strong>{task.title}</strong><small>{calendarTaskContext(task)} · {dateText(task.dueAt)}</small></button>)}</div></div>}
    <section className={cx(styles.card, styles.calendarCard)} data-testid="collaboration-calendar">
      <div className={styles.calendarToolbar}>
        <div className={styles.calendarTitle}><span className={styles.sectionKicker}>Team Calendar</span><h2>多人在线协作日历</h2><p>各电脑使用自己的账号连接同一个云端日历；受邀成员能看到创建人和进展。</p></div>
        <div className={styles.calendarToolbarActions}>
          <button type="button" className={styles.secondaryButton} onClick={jumpToToday}>今天</button>
          <div className={styles.calendarPager}><button type="button" className={styles.iconButton} aria-label="上一个时间段" onClick={() => moveCalendarCursor(-1)}><ChevronLeft size={15} /></button><strong>{calendarHeading(calendarMode, calendarCursor)}</strong><button type="button" className={styles.iconButton} aria-label="下一个时间段" onClick={() => moveCalendarCursor(1)}><ChevronRight size={15} /></button></div>
          <div className={styles.calendarModeSwitcher} role="tablist" aria-label="日历视图"><button type="button" role="tab" aria-selected={calendarMode === "month"} className={calendarMode === "month" ? styles.calendarModeActive : ""} onClick={() => setCalendarMode("month")}>月</button><button type="button" role="tab" aria-selected={calendarMode === "week"} className={calendarMode === "week" ? styles.calendarModeActive : ""} onClick={() => setCalendarMode("week")}>周</button><button type="button" role="tab" aria-selected={calendarMode === "day"} className={calendarMode === "day" ? styles.calendarModeActive : ""} onClick={() => setCalendarMode("day")}>日</button></div>
          <button type="button" className={styles.primaryButton} disabled={calendarDisconnected} onClick={() => setCalendarEditor({ mode: "create" })}><Plus size={15} />安排</button>
        </div>
      </div>
      {localCalendarMode && <div className={styles.calendarConnectionBar} role="status"><span>{calendarConnection ? <>云端已连接：<strong>{calendarIdentity?.name || calendarConnection.viewer.name}</strong> · {calendarIdentity?.email || calendarConnection.viewer.email}</> : "当前是本机独立部署。连接云端后，其他电脑上受邀的同事才能看到你的协作事件。"}</span>{calendarConnection ? <button type="button" className={styles.linkButton} onClick={disconnectCalendar}>断开连接</button> : <button type="button" className={styles.primaryButton} disabled={calendarConnecting} onClick={() => void connectCalendar()}>{calendarConnecting ? "连接中…" : "连接云端日历"}</button>}</div>}
      {!localCalendarMode && calendarIdentity && <div className={styles.calendarConnectionBar} role="status">当前账号：<strong>{calendarIdentity.name}</strong> · {calendarIdentity.email}</div>}
      {calendarError && !calendarDisconnected && <div className={styles.calendarNotice} role="alert"><AlertCircle size={15} /><span>{calendarError}</span>{calendarNeedsLogin && <a className={styles.linkButton} href="/auth/login?returnTo=%2F%3Ffollowup%3D1">登录后打开跟进提醒</a>}<button type="button" className={styles.linkButton} onClick={() => setCalendarRefreshKey((current) => current + 1)}>重试</button></div>}
      {calendarError && calendarDisconnected && !calendarError.includes("请先连接云端") && <div className={styles.calendarNotice} role="alert"><AlertCircle size={15} /><span>{calendarError}</span></div>}
      {calendarLoading ? <div className={styles.calendarLoading}><RefreshCw size={16} /><span>正在加载共享日历…</span></div> : calendarMode === "month" ? <CalendarMonthView days={calendarRange.days} cursor={calendarCursor} items={[...calendarTaskEvents, ...sharedCalendarEvents]} onSelect={selectCalendarItem} /> : calendarMode === "week" ? <CalendarWeekView days={calendarRange.days} items={[...calendarTaskEvents, ...sharedCalendarEvents]} onSelect={selectCalendarItem} /> : <CalendarDayView day={calendarRange.days[0]} items={[...calendarTaskEvents, ...sharedCalendarEvents]} onSelect={selectCalendarItem} />}
      <div className={styles.calendarFooter}><span>事件状态：<i className={styles.calendarLegendConfirmed} />已确认 <i className={styles.calendarLegendCompleted} />已完成 <i className={styles.calendarLegendCancelled} />已取消</span><span><RefreshCw size={12} />已连接时每 20 秒同步</span></div>
      {selectedCalendarItem && <div className={styles.calendarSelectedEvent}><div className={styles.calendarSelectedCopy}><span className={cx(styles.calendarEventLabel, selectedCalendarItem.source === "followup" ? styles.calendarLabelFollowup : styles.calendarLabelShared)}>{calendarKindLabel(selectedCalendarItem.kind)}</span><strong>{selectedCalendarItem.title}</strong><p>{selectedCalendarItem.allDay ? "全天" : `${calendarEventTime(selectedCalendarItem.startAt)} – ${calendarEventTime(selectedCalendarItem.endAt)}`} · {calendarStatusLabel(selectedCalendarItem.status)}</p>{selectedCalendarItem.event && <p className={styles.calendarOwner}>创建人：<strong>{selectedCalendarItem.event.createdByName}</strong>（{selectedCalendarItem.event.createdByEmail}）</p>}{selectedCalendarItem.participantEmails.length > 0 && <div className={styles.calendarParticipants}>{selectedCalendarItem.participantEmails.map((email) => <span key={email} title={email}>{email.slice(0, 2).toUpperCase()}</span>)}<small>{selectedCalendarItem.participantEmails.join("、")}</small></div>}{selectedCalendarItem.event && <small className={styles.calendarUpdatedBy}>最后修改：{selectedCalendarItem.event.updatedByName} · {formatDate(selectedCalendarItem.event.updatedAt)}</small>}</div><div className={styles.calendarSelectedActions}>{selectedCalendarItem.source === "shared" && selectedCalendarItem.event && <><button type="button" className={styles.secondaryButton} disabled={calendarSubmitting} onClick={() => setCalendarEditor({ mode: "edit", event: selectedCalendarItem.event })}>编辑事件</button>{selectedCalendarItem.kind === "followup" ? <button type="button" className={styles.secondaryButton} disabled={calendarSubmitting} onClick={() => void toggleCalendarFollowupStatus(selectedCalendarItem.event!)}>{selectedCalendarItem.event.status === "completed" ? "重新打开跟进" : "完成跟进"}</button> : <button type="button" className={styles.secondaryButton} disabled={calendarSubmitting} onClick={() => void toggleCalendarStatus(selectedCalendarItem.event!)}>{selectedCalendarItem.event.status === "cancelled" ? "恢复安排" : selectedCalendarItem.event.status === "completed" ? "重新打开" : "取消事件"}</button>}</>}{selectedCalendarItem.source === "followup" && selectedCalendarItem.task && <button type="button" className={styles.secondaryButton} onClick={() => selectTask(selectedCalendarItem.task!)}>查看跟进</button>}</div></div>}
      {selectedCalendarItem?.event && <CalendarMembers event={selectedCalendarItem.event} identity={calendarIdentity} presence={calendarPresence} busy={calendarSubmitting} onChange={(status) => void changeCalendarMemberStatus(selectedCalendarItem.event!, status)} />}
    </section>
    <div className={styles.followupLayout}>
      <section className={cx(styles.card, styles.taskBoard)}>
        <div className={styles.listHeader}><h2>跟进待办 <em>{filteredTasks.length}</em></h2><button className={styles.iconButton} disabled={busy} aria-label="刷新待办" onClick={() => void refreshTasks()}><RefreshCw size={15} /></button></div>
        <label className={styles.searchField}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索跟进任务" placeholder="搜索客户、公司或任务" /></label>
        <div className={styles.taskFilters}>{(Object.keys(followupFilterLabels) as FollowupFilter[]).map((key) => <button key={key} className={filter === key ? styles.filterActive : ""} onClick={() => setFilter(key)}>{followupFilterLabels[key]}</button>)}</div>
        <div className={styles.taskList}>{filteredTasks.map((task) => <div key={task.id} className={cx(styles.taskRow, selectedTask?.id === task.id && styles.taskRowSelected, task.status === "completed" && styles.taskRowCompleted, overdue(task) && styles.taskRowOverdue)}>
          <button className={cx(styles.taskCheck, task.status === "completed" && styles.taskCheckDone)} disabled={busy} aria-label={(task.status === "completed" ? "重新打开 " : "完成 ") + task.title} aria-pressed={task.status === "completed"} onClick={() => void changeStatus(task)}>{task.status === "completed" && <Check size={13} />}</button>
          <button className={styles.taskRowMain} onClick={() => selectTask(task)}><div className={styles.taskRowTop}><PriorityBadge priority={task.priority} /><span>{calendarTaskTypeLabel(task, calendarEvents)}</span></div><strong>{task.title}</strong><p>{calendarTaskContext(task)}</p><time dateTime={task.dueAt} className={overdue(task) ? styles.overdueText : ""}>{dateText(task.dueAt)}</time></button>
        </div>)}{!filteredTasks.length && <EmptyPanel icon={CheckCircle2} title="这个筛选下没有任务" detail="切换筛选或新建任务。" />}</div>
      </section>
      {selectedTask ? <section className={cx(styles.card, styles.taskDetail)}>
        <div className={styles.taskDetailHeader}><div><h2>{selectedTask.title}</h2><p>{calendarTaskContext(selectedTask)}</p></div><PriorityBadge priority={selectedTask.priority} /></div>
        <div className={styles.taskFacts}><div><CalendarClock size={15} /><span>截止日期与星期<strong><time dateTime={selectedTask.dueAt}>{dateText(selectedTask.dueAt)}</time></strong></span></div><div><Tag size={15} /><span>任务状态<strong>{selectedTask.status === "completed" ? "已完成" : overdue(selectedTask) ? "已逾期" : "待处理"}</strong></span></div></div>
        <div className={styles.taskDescription}><p>{selectedTask.description}</p></div>
        <div className={styles.scriptBlock}><div className={styles.scriptHeader}><h3>{isCalendarEventTask(selectedTask) ? "协作事件备注" : "可编辑跟进话术（规则草稿）"}</h3>{!isCalendarEventTask(selectedTask) && <button className={styles.iconButton} aria-label="重新生成跟进话术" onClick={() => selectTask(selectedTask)}><RefreshCw size={15} /></button>}</div><textarea value={isCalendarEventTask(selectedTask) ? selectedTask.description : script} readOnly={isCalendarEventTask(selectedTask)} onChange={(event) => setScript(event.target.value)} aria-label={isCalendarEventTask(selectedTask) ? "协作事件备注" : "可编辑跟进话术"} />{isCalendarEventTask(selectedTask) ? <p className={styles.calendarFormHint}>共享备注通过“编辑协作事件”修改，当前内容不会在此处直接保存。</p> : <div className={styles.draftActions}><button className={styles.secondaryButton} onClick={() => void copyText(script, onToast, "跟进话术已复制")}><Copy size={15} />复制话术</button>{onOpenCustomer && <button className={styles.secondaryButton} onClick={() => onOpenCustomer(selectedTask.customerId)}><UsersRound size={15} />打开客户档案</button>}</div>}</div>
        <div className={styles.taskDetailFooter}><button className={styles.primaryButton} disabled={busy} onClick={() => void changeStatus(selectedTask)}><CheckCircle2 size={15} />{busy ? "保存中…" : selectedTask.status === "completed" ? "重新打开任务" : "完成任务"}</button><Link className={styles.secondaryButton} href={isCalendarEventTask(selectedTask) ? `/calendar/events/${encodeURIComponent(calendarEventIdFromTask(selectedTask)!)}` : `/calendar/followups/${encodeURIComponent(selectedTask.id)}`}>打开详情／删除</Link></div>
      </section> : <EmptyPanel icon={Clock3} title="选择一条任务" detail="从待办中选择或新建任务。" />}
    </div>
    {creating && <FollowupForm customers={customers} onClose={() => setCreating(false)} onCreated={(task) => { setTaskState((current) => [task, ...current]); selectTask(task); setFilter("all"); setQuery(""); setCreating(false); onToast?.("新任务已保存到后端"); }} />}
    {calendarEditor && <CalendarEventForm event={calendarEditor.event} submitting={calendarSubmitting} onClose={() => setCalendarEditor(null)} onSubmit={(draft) => void saveCalendarEvent(draft, calendarEditor.event)} />}
  </div>;
}

function FollowupForm({ customers, onClose, onCreated }: { customers: Customer[]; onClose: () => void; onCreated: (task: FollowupTask) => void }) {
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] = useState<FollowupTask["priority"]>("中");
  const [type, setType] = useState<FollowupTask["type"]>("回复客户");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { onCreated(await createFollowupViaApi({ customerId, title: title.trim(), description, dueAt: new Date(dueAt).toISOString(), priority, type })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "创建失败"); }
    finally { setBusy(false); }
  }
  return <div className={styles.todoModal} role="dialog" aria-modal="true" aria-label="新建跟进任务"><form onSubmit={submit} className={styles.todoForm}><h2>新建跟进任务</h2>
    <label>客户<select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.company} · {customer.name}</option>)}</select></label>
    <label>任务标题<input required maxLength={240} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>截止日期与时间<input type="datetime-local" required value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
    {dueAt && <p>{formatFollowupDate(new Date(dueAt))}</p>}
    <label>任务类型<select value={type} onChange={(event) => setType(event.target.value as FollowupTask["type"])}>{["回复客户", "发送资料", "电话沟通", "确认需求", "报价跟进", "内部任务"].map((value) => <option key={value}>{value}</option>)}</select></label>
    <label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as FollowupTask["priority"])}>{["高", "中", "低"].map((value) => <option key={value}>{value}</option>)}</select></label>
    <label>任务说明<textarea value={description} maxLength={5000} onChange={(event) => setDescription(event.target.value)} /></label>
    {error && <p role="alert">{error}</p>}<div><button type="button" className={styles.secondaryButton} disabled={busy} onClick={onClose}>取消</button><button className={styles.primaryButton} disabled={busy || !title.trim()}>{busy ? "保存中…" : "保存任务"}</button></div>
  </form></div>;
}

function datetimeLocalValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultCalendarDraft(): CalendarEventDraft {
  const start = new Date();
  start.setMinutes(start.getMinutes() < 30 ? 30 : 60, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { title: "", description: "", startAt: datetimeLocalValue(start.toISOString()), endAt: datetimeLocalValue(end.toISOString()), allDay: false, kind: "meeting", participantEmails: [] };
}

function CalendarEventForm({ event, submitting, onClose, onSubmit }: { event?: CalendarEvent; submitting: boolean; onClose: () => void; onSubmit: (draft: CalendarEventDraft) => void }) {
  const initial = event ? { title: event.title, description: event.description, startAt: datetimeLocalValue(event.startAt), endAt: datetimeLocalValue(event.endAt), allDay: event.allDay, kind: event.kind, participantEmails: event.participantEmails } : defaultCalendarDraft();
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [startAt, setStartAt] = useState(initial.startAt);
  const [endAt, setEndAt] = useState(initial.endAt);
  const [allDay, setAllDay] = useState(initial.allDay);
  const [kind, setKind] = useState<CalendarEvent["kind"]>(initial.kind);
  const [participants, setParticipants] = useState(initial.participantEmails.join(", "));
  const [error, setError] = useState("");
  function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (!title.trim()) { setError("请填写事件标题"); return; }
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) { setError("结束时间需要晚于开始时间"); return; }
    setError("");
    onSubmit({ title: title.trim(), description: description.trim(), startAt: start.toISOString(), endAt: end.toISOString(), allDay, kind, participantEmails: [...new Set(participants.split(/[，,\s]+/).map((email) => email.trim().toLowerCase()).filter(Boolean))] });
  }
  return <div className={styles.todoModal} role="dialog" aria-modal="true" aria-label={event ? "编辑协作日历事件" : "新建协作日历事件"}><form onSubmit={submit} className={cx(styles.todoForm, styles.calendarEventForm)}><div className={styles.calendarFormHeading}><div><span className={styles.sectionKicker}>Shared Event</span><h2>{event ? "编辑协作事件" : "新建协作事件"}</h2></div><button type="button" className={styles.iconButton} aria-label="关闭" onClick={onClose}><X size={16} /></button></div>
    <label>标题<input required maxLength={240} value={title} onChange={(formEvent) => setTitle(formEvent.target.value)} placeholder="例如：确认餐厅项目报价" /></label>
    <div className={styles.calendarFormGrid}><label>开始<input type="datetime-local" required value={startAt} onChange={(formEvent) => setStartAt(formEvent.target.value)} /></label><label>结束<input type="datetime-local" required value={endAt} onChange={(formEvent) => setEndAt(formEvent.target.value)} /></label></div>
    <label className={styles.calendarCheckbox}><input type="checkbox" checked={allDay} onChange={(formEvent) => setAllDay(formEvent.target.checked)} />全天事件</label>
    <label>事件类型<select value={kind} onChange={(formEvent) => setKind(formEvent.target.value as CalendarEvent["kind"])}><option value="followup">跟进</option><option value="meeting">会议</option><option value="task">普通任务</option><option value="focus">专注时间</option></select></label>
    <label>参与者邮箱<input maxLength={2000} value={participants} onChange={(formEvent) => setParticipants(formEvent.target.value)} placeholder="多个邮箱用逗号或空格分隔" /></label>
    <p className={styles.calendarFormHint}>新事件会立即加入跟进待办。只有创建者和受邀登录用户可以查看；无需先创建客户档案。</p>
    <label>说明<textarea maxLength={5000} value={description} onChange={(formEvent) => setDescription(formEvent.target.value)} placeholder="补充地点、目标或上下文" /></label>
    {event && <p className={styles.calendarFormStatus}>当前状态：{calendarStatusLabel(event.status)} · 更新人：{event.updatedByName}</p>}
    {error && <p role="alert">{error}</p>}<div><button type="button" className={styles.secondaryButton} disabled={submitting} onClick={onClose}>取消</button><button className={styles.primaryButton} disabled={submitting || !title.trim()}>{submitting ? "保存中…" : event ? "保存修改" : "创建事件"}</button></div>
  </form></div>;
}
