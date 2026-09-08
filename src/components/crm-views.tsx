"use client";

import {
  AlertCircle,
  Archive,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
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
import { useMemo, useState } from "react";
import { useModelHealth } from "@/hooks/use-model-health";
import type { SalesAgentUIMessage } from "@/lib/ai/sales-agent";
import type { AssistantReasoningMode } from "@/lib/contracts/api";
import type { Product } from "@/lib/catalog";
import {
  analyzeCustomerMessage,
  buildFollowupMessage,
  filterFollowupTasks,
  formatQuoteAmount,
  getCustomerById,
  getLatestInboundMessage,
  isTaskOverdue,
  searchCustomers,
  toggleFollowupTask,
  type CrmAsset,
  type Customer,
  type CustomerContact,
  type CustomerMessageAnalysis,
  type CustomerNeed,
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
  onCreateQuote?: (customerId: string) => void;
  onOpenCustomer?: (customerId: string) => void;
  onToast?: CrmToastHandler;
};

export type FollowupViewProps = {
  customers: Customer[];
  tasks: FollowupTask[];
  referenceDate?: Date | string;
  onOpenCustomer?: (customerId: string) => void;
  onTaskStatusChange?: (task: FollowupTask, status: FollowupTaskStatus) => void;
  onToast?: CrmToastHandler;
};

const defaultReferenceDate = "2026-09-04T14:00:00+08:00";

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
  const [reasoningMode, setReasoningMode] = useState<AssistantReasoningMode>("normal");
  const transport = useMemo(() => new DefaultChatTransport<SalesAgentUIMessage>({ api: "/api/v1/assistant/chat" }), []);
  const { messages: modelMessages, sendMessage, status: modelStatus, error: modelError, stop, setMessages } = useChat<SalesAgentUIMessage>({ transport, throttle: 40 });
  const { health: modelHealth, checking: checkingModel, refresh: refreshModelHealth } = useModelHealth();
  const modelBusy = modelStatus === "streaming" || modelStatus === "submitted";
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
  }

  async function runModelAnalysis() {
    if (modelBusy) return;
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
        <Metric icon={MessageSquareText} label="模型服务" value={modelHealth?.reachable ? modelHealth.connectionKind === "protocol-mock" ? "模拟" : "在线" : "离线"} detail={modelHealth?.model ?? "等待检测"} tone="gold" />
        <Metric icon={Sparkles} label="本轮模型状态" value={modelBusy ? "生成中" : modelError ? "失败" : modelText ? "已完成" : "待开始"} detail={`${toolParts.length} 次受控工具调用`} tone="green" />
        <Metric icon={Paperclip} label="资料候选" value={String(analysis.recommendedAssets.length).padStart(2, "0")} detail="来自后端产品资料" tone="blue" />
        <Metric icon={CheckCircle2} label="人工确认" value={confirmed ? "已确认" : "待确认"} detail="模型不能自动发送" tone="rose" />
      </div>

      <div className={styles.assistantLayout}>
        <section className={cx(styles.card, styles.messageCard)}>
          <div className={styles.cardHeader}><div><span className={styles.sectionKicker}>01 · 客户消息</span><h2>发送给 Qwen 销售 Agent</h2></div><button className={styles.demoPill} onClick={() => void refreshModelHealth()}><span /> {checkingModel ? "检测中" : modelHealth?.reachable ? modelHealth.connectionKind === "protocol-mock" ? "协议模拟已连接" : "Qwen 已连接" : "Qwen 未连接"}</button></div>
          <div className={styles.customerBanner}><Avatar customer={customer} /><div><strong>{customer.name} · {customer.company}</strong><span>{customer.role} · {customer.lastContactLabel}</span></div><button className={styles.linkButton} onClick={() => onOpenCustomer?.(customer.id)}>查看档案 <ArrowRight size={13} /></button><StageBadge stage={customer.stage} /></div>
          <label className={styles.textareaLabel} htmlFor="crm-customer-message">客户原消息</label>
          <textarea id="crm-customer-message" className={styles.messageTextarea} value={message} onChange={(event) => { setMessage(event.target.value); setConfirmed(false); }} placeholder="粘贴客户的微信、邮件或电话纪要…" />
          <div className={styles.messageFooter}><span>{message.length} 字 · 模型档位 <select aria-label="模型推理档位" value={reasoningMode} onChange={(event) => setReasoningMode(event.target.value as AssistantReasoningMode)}><option value="fast">FAST</option><option value="normal">NORMAL</option><option value="deep">DEEP</option></select></span>{modelStatus === "streaming" || modelStatus === "submitted" ? <button className={styles.secondaryButton} onClick={() => void stop()}><X size={15} /> 停止</button> : <button className={styles.primaryButton} disabled={!modelHealth?.reachable} onClick={() => void runModelAnalysis()}><Sparkles size={15} /> 调用 Qwen 分析</button>}</div>
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
          <div className={styles.draftMeta}><div className={styles.aiMark}><Sparkles size={15} /></div><span><strong>{modelText ? modelHealth?.connectionKind === "protocol-mock" ? "协议模拟草稿" : "模型流式草稿" : "本地规则草稿"} · 可直接编辑</strong><small>{modelText ? `Agent 已调用 ${toolParts.length} 次受控工具` : "尚未调用模型，不冒充 AI 输出"}</small></span><button className={styles.iconButton} disabled={!modelHealth?.reachable || modelBusy} onClick={() => void runModelAnalysis()} aria-label="重新生成回复"><RefreshCw size={15} /></button></div>
          <textarea className={styles.draftTextarea} value={visibleDraft} onChange={(event) => { setDraft(event.target.value); setDraftEdited(true); setConfirmed(false); }} aria-label="可编辑回复草稿" />
          <div className={styles.draftActions}><button className={styles.secondaryButton} disabled={modelBusy} onClick={() => copyText(visibleDraft, onToast, "回复草稿已复制") }><Copy size={15} /> 复制草稿</button><button className={styles.primaryButton} disabled={modelBusy} onClick={confirmReply}><CheckCircle2 size={15} /> 确认本次草稿</button></div>
          <p className={styles.disclaimer}><ShieldCheck size={14} /> 当前确认保留在本页面，尚未保存到数据库；请复制后人工发送。</p>
        </section>
      </div>
    </div>
  );
}

export function CustomersView({ customers, initialCustomerId, onAnalyzeCustomer, onCreateQuote, onOpenCustomer, onToast }: CustomersViewProps) {
  const [customerState, setCustomerState] = useState(customers);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(initialCustomerId ?? customers[0]?.id ?? "");
  const filteredCustomers = useMemo(() => searchCustomers(query, customerState), [customerState, query]);
  const selectedCustomer = getCustomerById(selectedId, customerState) ?? filteredCustomers[0];

  function selectCustomer(customer: Customer) {
    setSelectedId(customer.id);
    onOpenCustomer?.(customer.id);
  }

  function createCustomer() {
    const id = `cust-local-${Date.now()}`;
    const customer: Customer = {
      id, company: "新客户（待完善）", name: "新联系人", role: "待补充", avatar: "新", industry: "待补充", location: "待补充",
      stage: "新客", source: "手动创建", tags: ["新建"], email: "", phone: "", owner: "Junjun Hu", estimatedValue: 0,
      lastContactAt: new Date().toISOString(), lastContactLabel: "刚刚", unreadCount: 0, contacts: [], conversations: [], needs: [], quotes: [],
      contextMemory: ["这是一个本地新建客户，请补充联系人、行业和项目需求。"],
    };
    setCustomerState((current) => [customer, ...current]);
    setSelectedId(id);
    setQuery("");
    onOpenCustomer?.(id);
    onToast?.("新客户档案已创建");
  }

  return (
    <div className={styles.root} data-testid="customers-view">
      <div className={styles.viewHeader}><div><span className={styles.eyebrow}>Customer & Conversation · 二期</span><h1>客户档案，连同每一次上下文</h1><p>联系人、聊天记录、需求、历史报价和关键记忆集中在一处。</p></div><button className={styles.primaryButton} onClick={createCustomer}><Plus size={16} /> 新建客户</button></div>
      <div className={styles.metricStrip} aria-label="客户指标"><Metric icon={UsersRound} label="客户总数" value={String(customerState.length).padStart(2, "0")} detail={`${customerState.filter((customer) => customer.stage !== "沉睡").length} 个活跃档案`} tone="green" /><Metric icon={MessageCircle} label="未读会话" value={String(customerState.reduce((sum, customer) => sum + customer.unreadCount, 0)).padStart(2, "0")} detail="需要及时处理" tone="gold" /><Metric icon={CircleDollarSign} label="机会金额" value={formatQuoteAmount(customerState.reduce((sum, customer) => sum + customer.estimatedValue, 0))} detail="含报价中客户" tone="blue" /><Metric icon={Tag} label="待确认需求" value={String(customerState.reduce((sum, customer) => sum + customer.needs.filter((need) => need.status === "待确认").length, 0)).padStart(2, "0")} detail="可转成跟进任务" tone="rose" /></div>

      <div className={styles.customersLayout}>
        <aside className={cx(styles.card, styles.customerListCard)}>
          <div className={styles.listHeader}><div><span className={styles.sectionKicker}>客户目录</span><h2>全部客户 <em>{filteredCustomers.length}</em></h2></div><button className={styles.iconButton} aria-label="客户筛选" onClick={() => onToast?.("可按阶段、行业或负责人筛选") }><Tag size={15} /></button></div>
          <label className={styles.searchField}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索公司、联系人、标签" aria-label="搜索客户" /><kbd>⌘ K</kbd></label>
          <div className={styles.customerFilters}><button className={!query ? styles.filterActive : ""} onClick={() => setQuery("")}>全部</button><button onClick={() => setQuery("报价中")}>报价中</button><button onClick={() => setQuery("跟进中")}>跟进中</button><button onClick={() => setQuery("未读")}>未读</button></div>
          <div className={styles.customerList}>{filteredCustomers.length > 0 ? filteredCustomers.map((customer) => <button className={cx(styles.customerRow, selectedCustomer?.id === customer.id && styles.customerRowSelected)} key={customer.id} onClick={() => selectCustomer(customer)}><Avatar customer={customer} /><span className={styles.customerRowCopy}><strong>{customer.name}<small>{customer.company}</small></strong><em>{customer.lastContactLabel}</em><span>{customer.tags.slice(0, 2).join(" · ")}</span></span><span className={styles.customerRowEnd}><StageBadge stage={customer.stage} />{customer.unreadCount > 0 && <b>{customer.unreadCount}</b>}</span></button>) : <EmptyPanel icon={Search} title="没有匹配客户" detail="换一个公司名、联系人或标签。" />}</div>
        </aside>

        {selectedCustomer ? <CustomerProfile key={selectedCustomer.id} customer={selectedCustomer} onAnalyze={() => onAnalyzeCustomer?.(selectedCustomer)} onCreateQuote={() => onCreateQuote?.(selectedCustomer.id)} onToast={onToast} /> : <section className={styles.card}><EmptyPanel icon={UsersRound} title="选择一个客户" detail="从左侧目录选择客户查看完整上下文。" /></section>}
      </div>
    </div>
  );
}

function CustomerProfile({ customer, onAnalyze, onCreateQuote, onToast }: { customer: Customer; onAnalyze: () => void; onCreateQuote: () => void; onToast?: CrmToastHandler }) {
  const latestInbound = getLatestInboundMessage(customer);
  const [contacts, setContacts] = useState<CustomerContact[]>(customer.contacts);
  const [needs, setNeeds] = useState<CustomerNeed[]>(customer.needs);
  const [showAllMessages, setShowAllMessages] = useState(false);

  function addContact() {
    setContacts((current) => [...current, { id: `contact-${Date.now()}`, name: "新联系人", role: "待补充", email: "", phone: "", preferredChannel: "微信" }]);
    onToast?.("联系人已添加，请继续完善资料");
  }

  function addNeed() {
    setNeeds((current) => [{ id: `need-${Date.now()}`, title: "新需求（待确认）", detail: "请记录使用场景、数量、规格和交期。", status: "待确认", priority: "中", updatedAt: new Date().toISOString() }, ...current]);
    onToast?.("客户需求已添加");
  }
  return (
    <section className={styles.profileColumn}>
      <div className={cx(styles.card, styles.profileHero)}><div className={styles.profileIdentity}><Avatar customer={customer} /><div><div className={styles.profileTitle}><h2>{customer.company}</h2><StageBadge stage={customer.stage} /></div><p>{customer.name} · {customer.role} · {customer.industry}</p><span><Tag size={13} /> {customer.tags.join(" · ")}</span></div></div><div className={styles.profileActions}><button className={styles.secondaryButton} onClick={() => copyText([customer.email, customer.phone].filter(Boolean).join("\n"), onToast, "客户联系方式已复制")}><Phone size={15} /> 联系客户</button><button className={styles.primaryButton} onClick={onAnalyze}><Sparkles size={15} /> 分析最新消息</button></div><div className={styles.profileStats}><div><small>机会金额</small><strong>{formatQuoteAmount(customer.estimatedValue)}</strong></div><div><small>负责人</small><strong>{customer.owner}</strong></div><div><small>最后联系</small><strong>{customer.lastContactLabel}</strong></div><div><small>来源</small><strong>{customer.source}</strong></div></div></div>
      <div className={styles.profileGrid}>
        <section className={cx(styles.card, styles.contactsCard)}><div className={styles.listHeader}><div><span className={styles.sectionKicker}>联系人</span><h2>联系方式</h2></div><button className={styles.iconButton} aria-label="添加联系人" onClick={addContact}><Plus size={15} /></button></div><div className={styles.contactList}>{contacts.map((contact) => <div className={styles.contactRow} key={contact.id}><span className={styles.contactAvatar}>{contact.name.slice(0, 1)}</span><div><strong>{contact.name}{contact.isPrimary && <em>主要联系人</em>}</strong><small>{contact.role} · 首选 {contact.preferredChannel}</small><span>{contact.email && <a href={`mailto:${contact.email}`}><Mail size={13} /> {contact.email}</a>}{contact.phone && <a href={`tel:${contact.phone}`}><Phone size={13} /> {contact.phone}</a>}</span></div></div>)}</div></section>
        <section className={cx(styles.card, styles.memoryCard)}><div className={styles.listHeader}><div><span className={styles.sectionKicker}>上下文记忆</span><h2>销售应该记住的事</h2></div><ShieldCheck size={17} className={styles.safeIcon} /></div><div className={styles.memoryList}>{customer.contextMemory.map((memory, index) => <div key={memory}><span>{String(index + 1).padStart(2, "0")}</span><p>{memory}</p></div>)}</div></section>
        <section className={cx(styles.card, styles.conversationCard)}><div className={styles.listHeader}><div><span className={styles.sectionKicker}>Conversation · {customer.conversations.length}</span><h2>聊天记录</h2></div><button className={styles.secondaryButton} onClick={() => setShowAllMessages((current) => !current)}><Archive size={14} /> {showAllMessages ? "收起" : "查看全部"}</button></div>{latestInbound && <div className={styles.latestMessage}><span><MessageCircle size={14} /> 待处理消息</span><p>{latestInbound.content}</p><small>{latestInbound.channel} · {formatDateTime(latestInbound.timestamp)}</small><button className={styles.linkButton} onClick={onAnalyze}>交给销售助手 <ArrowRight size={14} /></button></div>}<div className={styles.timeline}>{(showAllMessages ? customer.conversations : customer.conversations.slice(-3)).map((message) => <div className={cx(styles.timelineItem, message.direction === "inbound" ? styles.timelineInbound : message.direction === "internal" ? styles.timelineInternal : styles.timelineOutbound)} key={message.id}><span className={styles.timelineDot} /><div><div className={styles.timelineMeta}><strong>{message.author}</strong><span>{message.channel} · {formatDateTime(message.timestamp)}</span></div><p>{message.content}</p></div></div>)}</div></section>
        <section className={cx(styles.card, styles.needsCard)}><div className={styles.listHeader}><div><span className={styles.sectionKicker}>需求</span><h2>客户要解决的问题</h2></div><button className={styles.iconButton} aria-label="添加需求" onClick={addNeed}><Plus size={15} /></button></div><div className={styles.needList}>{needs.map((need) => <div className={styles.needRow} key={need.id}><span className={cx(styles.needStatus, need.status === "待确认" && styles.needPending)}>{need.status === "已解决" ? <CheckCircle2 size={14} /> : <Clock3 size={14} />}</span><div><strong>{need.title}</strong><p>{need.detail}</p><small>更新于 {formatDateTime(need.updatedAt)}</small></div><PriorityBadge priority={need.priority} /></div>)}</div></section>
        <section className={cx(styles.card, styles.quotesCard)}><div className={styles.listHeader}><div><span className={styles.sectionKicker}>Quote history · {customer.quotes.length}</span><h2>历史报价</h2></div><button className={styles.secondaryButton} onClick={onCreateQuote}><Plus size={14} /> 新报价</button></div>{customer.quotes.length > 0 ? <div className={styles.quoteList}>{customer.quotes.map((quote) => <div className={styles.quoteRow} key={quote.id}><span className={styles.quoteIcon}><CircleDollarSign size={15} /></span><div><strong>{quote.quoteNo}</strong><p>{quote.productNames.join("、")}</p><small>{formatDate(quote.createdAt)} · 有效至 {formatDate(quote.validUntil)}</small></div><div className={styles.quoteAmount}><strong>{formatQuoteAmount(quote.amount)}</strong><span className={cx(styles.quoteStatus, quote.status === "已接受" ? styles.quoteAccepted : quote.status === "审批中" ? styles.quoteReview : quote.status === "已过期" ? styles.quoteExpired : "")}>{quote.status}</span></div></div>)}</div> : <EmptyPanel icon={CircleDollarSign} title="还没有报价记录" detail="确认客户需求后，可进入报价流程。" />}</section>
      </div>
    </section>
  );
}

const followupFilterLabels: Record<FollowupFilter, string> = { all: "全部任务", overdue: "已逾期", today: "今天", upcoming: "即将到期", completed: "已完成" };

export function FollowupView({ customers, tasks, referenceDate = defaultReferenceDate, onOpenCustomer, onTaskStatusChange, onToast }: FollowupViewProps) {
  const [taskState, setTaskState] = useState(tasks);
  const [filter, setFilter] = useState<FollowupFilter>("all");
  const [query, setQuery] = useState("");
  const initialTask = taskState[0];
  const [selectedTaskId, setSelectedTaskId] = useState(initialTask?.id ?? "");
  const [script, setScript] = useState(() => initialTask ? buildFollowupMessage(initialTask, getCustomerById(initialTask.customerId, customers)) : "");
  const filteredTasks = useMemo(() => filterFollowupTasks(taskState, filter, query, referenceDate), [filter, query, referenceDate, taskState]);
  const selectedTask = taskState.find((task) => task.id === selectedTaskId) ?? filteredTasks[0];
  const overdueCount = taskState.filter((task) => isTaskOverdue(task, referenceDate)).length;
  const openCount = taskState.filter((task) => task.status === "open").length;
  const completedCount = taskState.filter((task) => task.status === "completed").length;

  function selectTask(task: FollowupTask) {
    setSelectedTaskId(task.id);
    setScript(buildFollowupMessage(task, getCustomerById(task.customerId, customers)));
  }

  function changeStatus(task: FollowupTask, completed: boolean) {
    const nextTasks = toggleFollowupTask(taskState, task.id, completed);
    const nextTask = nextTasks.find((item) => item.id === task.id) ?? task;
    setTaskState(nextTasks);
    onTaskStatusChange?.(nextTask, nextTask.status);
    onToast?.(completed ? "任务已完成" : "任务已重新打开");
  }

  function completeSelected() {
    if (selectedTask) changeStatus(selectedTask, selectedTask.status !== "completed");
  }

  function createTask() {
    const customer = customers[0];
    const task: FollowupTask = {
      id: `task-local-${Date.now()}`,
      customerId: customer.id,
      customerName: customer.name,
      company: customer.company,
      title: "新跟进任务（待完善）",
      description: "补充下一步动作、负责人和客户承诺边界。",
      type: "回复客户",
      priority: "中",
      status: "open",
      dueAt: "2026-09-04T18:30:00+08:00",
      dueLabel: "今天 18:30",
      createdAt: new Date().toISOString(),
    };
    setTaskState((current) => [task, ...current]);
    setSelectedTaskId(task.id);
    setScript(buildFollowupMessage(task, customer));
    setFilter("all");
    setQuery("");
    onToast?.("新跟进任务已创建");
  }

  return (
    <div className={styles.root} data-testid="followup-view">
      <div className={styles.viewHeader}><div><span className={styles.eyebrow}>Follow-up · 二期</span><h1>不错过该推进的客户</h1><p>把未回复提醒、下一步行动、跟进话术和销售任务放在一个工作队列里。</p></div><button className={styles.primaryButton} onClick={createTask}><Plus size={16} /> 新建任务</button></div>
      <div className={styles.metricStrip} aria-label="跟进指标"><Metric icon={AlertCircle} label="待处理任务" value={String(openCount).padStart(2, "0")} detail="含未回复提醒" tone="gold" /><Metric icon={Clock3} label="今日到期" value={String(filterFollowupTasks(taskState, "today", "", referenceDate).length).padStart(2, "0")} detail="优先处理" tone="rose" /><Metric icon={Flag} label="已逾期" value={String(overdueCount).padStart(2, "0")} detail="需要马上推进" tone="blue" /><Metric icon={CheckCircle2} label="本周完成" value={String(completedCount).padStart(2, "0")} detail="持续积累" tone="green" /></div>

      <div className={styles.followupLayout}>
        <section className={cx(styles.card, styles.taskBoard)}>
          <div className={styles.listHeader}><div><span className={styles.sectionKicker}>Sales task queue</span><h2>销售任务 <em>{filteredTasks.length}</em></h2></div><button className={styles.iconButton} aria-label="刷新任务" onClick={() => setTaskState([...tasks])}><RefreshCw size={15} /></button></div>
          <label className={styles.searchField}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索客户、公司或任务" aria-label="搜索跟进任务" /></label>
          <div className={styles.taskFilters}>{(Object.keys(followupFilterLabels) as FollowupFilter[]).map((key) => <button key={key} className={filter === key ? styles.filterActive : ""} onClick={() => setFilter(key)}>{followupFilterLabels[key]}{key === "overdue" && overdueCount > 0 && <b>{overdueCount}</b>}</button>)}</div>
          <div className={styles.taskList}>{filteredTasks.length > 0 ? filteredTasks.map((task) => <TaskRow key={task.id} task={task} selected={selectedTask?.id === task.id} overdue={isTaskOverdue(task, referenceDate)} onSelect={() => selectTask(task)} onToggle={(completed) => changeStatus(task, completed)} />) : <EmptyPanel icon={CheckCircle2} title="这个筛选下没有任务" detail="可以切换筛选条件，或创建一条新的跟进任务。" />}</div>
        </section>

        {selectedTask ? <section className={cx(styles.card, styles.taskDetail)}><div className={styles.taskDetailHeader}><div><span className={styles.sectionKicker}>Selected task</span><h2>{selectedTask.title}</h2><p>{selectedTask.company} · {selectedTask.customerName}</p></div><PriorityBadge priority={selectedTask.priority} /></div><div className={styles.taskFacts}><div><CalendarClock size={15} /><span>截止时间<strong className={isTaskOverdue(selectedTask, referenceDate) ? styles.overdueText : ""}>{selectedTask.dueLabel}</strong></span></div><div><Tag size={15} /><span>任务类型<strong>{selectedTask.type}</strong></span></div></div><div className={styles.taskDescription}><span>任务说明</span><p>{selectedTask.description}</p></div><div className={styles.scriptBlock}><div className={styles.scriptHeader}><div><span className={styles.sectionKicker}>AI follow-up script</span><h3>建议跟进话术</h3></div><button className={styles.iconButton} aria-label="重新生成跟进话术" onClick={() => setScript(buildFollowupMessage(selectedTask, getCustomerById(selectedTask.customerId, customers)))}><RefreshCw size={15} /></button></div><textarea value={script} onChange={(event) => setScript(event.target.value)} aria-label="可编辑跟进话术" /><div className={styles.draftActions}><button className={styles.secondaryButton} onClick={() => copyText(script, onToast, "跟进话术已复制")}><Copy size={15} /> 复制话术</button><button className={styles.secondaryButton} onClick={() => onOpenCustomer?.(selectedTask.customerId)}><UsersRound size={15} /> 打开客户档案</button></div></div><div className={styles.taskDetailFooter}><button className={styles.secondaryButton} onClick={() => changeStatus(selectedTask, selectedTask.status === "completed")}><X size={15} /> {selectedTask.status === "completed" ? "重新打开" : "暂不处理"}</button><button className={styles.primaryButton} onClick={completeSelected}>{selectedTask.status === "completed" ? <RefreshCw size={15} /> : <CheckCircle2 size={15} />} {selectedTask.status === "completed" ? "标记为未完成" : "完成任务"}</button></div></section> : <section className={cx(styles.card, styles.taskDetail)}><EmptyPanel icon={Clock3} title="选择一条任务" detail="从任务队列选择后，这里会生成下一步话术。" /></section>}
      </div>
    </div>
  );
}

function TaskRow({ task, selected, overdue, onSelect, onToggle }: { task: FollowupTask; selected: boolean; overdue: boolean; onSelect: () => void; onToggle: (completed: boolean) => void }) {
  const completed = task.status === "completed";
  return <div className={cx(styles.taskRow, selected && styles.taskRowSelected, completed && styles.taskRowCompleted, overdue && styles.taskRowOverdue)}><button className={cx(styles.taskCheck, completed && styles.taskCheckDone)} onClick={() => onToggle(!completed)} aria-label={completed ? `重新打开 ${task.title}` : `完成 ${task.title}`} aria-pressed={completed}>{completed && <Check size={13} />}</button><button className={styles.taskRowMain} onClick={onSelect}><div className={styles.taskRowTop}><PriorityBadge priority={task.priority} /><span className={styles.taskType}>{task.type}</span><time className={overdue ? styles.overdueText : ""}>{task.dueLabel}</time></div><strong>{task.title}</strong><p>{task.company} · {task.customerName}</p></button><ChevronRight size={15} className={styles.taskArrow} /></div>;
}
