"use client";

import { useChat } from "@ai-sdk/react";
import Image from "next/image";
import { WechatConnection } from "./wechat-connection";
import { DefaultChatTransport, isToolUIPart, type FileUIPart } from "ai";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Clock3,
  Copy,
  Download,
  Eye,
  FolderOpen,
  History,
  Trash2,
  Target,
  Lightbulb,
  FileText,
  MessageCircle,
  MoreHorizontal,
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
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { QUICK_QUESTIONS } from "@/config/ui-static";
import { DEFAULT_AGENT_ROLE_ID, getAgentRoleOption, isAgentRoleId, type AgentRoleId } from "@/config/agent-roles";
import { useModelCatalog } from "@/hooks/use-model-catalog";
import { useModelHealth } from "@/hooks/use-model-health";
import type { SalesAgentUIMessage } from "@/lib/ai/sales-agent";
import type { Product } from "@/lib/catalog";
import type { CrmAsset, Customer } from "@/lib/crm";
import { projectAgentSearch } from "@/lib/client/agent-search-result";
import { readAgentProgress, inferCollaborationMode, interruptedTeamAnswer, type AgentProgress, type CollaborationMode } from "@/lib/contracts/agent-progress";
import { AgentTeamActivity } from "./agent-team-activity";
import styles from "./agent-workspace.module.css";
import { ModelRuntimeControls } from "./model-runtime-controls";
import { WorkDevicePanel } from "./work-device-panel";
import { parseInferenceReceipt, persistInferenceMode, savedInferenceMode, type InferenceMode, type InferenceReceipt } from "@/config/inference-ui";
import { getInferenceProfileInputBudget } from "@/lib/ai/inference-policy";
import { extractCompleteHtml, requestsCodeArtifact } from "@/lib/ai/code-artifact";
import { buildWorkContinuationPrompt } from "@/lib/ai/work-continuation";
import { CodeAnswer } from "./code-answer";
import { GeneratedFilePanel, type GeneratedFileKind } from "./generated-file-panel";
import { WorkSummaryPanel, type WorkSummaryItem } from "./work-summary-panel";
import { WorkSideChat } from "./work-side-chat";
import { copyLocalChatText, listLocalChats, loadLocalChat, removeLocalChat, saveLocalChat, updateLocalChatMetadata } from "@/lib/client/chat-history";
import type { LocalChatSession, LocalChatSummary, LocalChatTurn, LocalChatTurnVersion } from "@/lib/contracts/chat-history";
import type { CowAgentProfile, CowAgentRoster } from "@/lib/contracts/cowagent-agent";
import { ConversationHistoryList } from "./conversation-history-list";
import { ProjectPicker, projectRequest, projectsUpdated } from "./project-workspace";
import type { Project } from "@/lib/contracts/project";

const subscribeHost = () => () => {};
const isPublicHost = () => typeof window !== "undefined" && !["localhost", "127.0.0.1"].includes(window.location.hostname);

/** Props intentionally mirror the previous SalesAssistantView entry point. */
export type AgentWorkspaceProps = {
  customers: Customer[];
  products: Product[];
  assets: CrmAsset[];
  initialCustomerId?: string;
  initialMessage?: string;
  initialExperience?: "chat" | "work";
  preferredRoleId?: AgentRoleId;
  selectAllKnowledge?: boolean;
  onOpenKnowledge?: () => void;
  onAddToKit?: (id: string) => void;
  onOpenCustomer?: (customerId: string) => void;
  onOpenProduct?: (product: Product) => void;
  onToast?: (message: string) => void;
  historyPortalTarget?: HTMLElement | null;
  onOpenWechat?: () => void;
  projectId?: string | null;
  initialChatId?: string;
  onOpenProject?: (id: string) => void;
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

const agentPreferenceKey = "lumaflow.agent.id";
const goalStorageKey = "lumaflow.chat.goal.v1";
type WorkflowMode = "normal" | "goal" | "plan";
type WorkTeam = { agentId?: string; collaboratorAgentIds?: string[]; collaborationMode?: CollaborationMode };
const collaborationLabels: Record<CollaborationMode, string> = { parallel: "同时工作", sequential: "分步工作", debate: "讨论辩论" };
type PromptAgentReference = { id: string; name: string; avatarUrl?: string; kind: "main" | "collaborator" };
type WorkContinuation = {
  turnId: string;
  task: string;
  assistant: string;
  agentActivity: AgentProgress[];
  team: WorkTeam;
};
type QueuedWorkMessage = {
  id: string;
  text: string;
  files: FileUIPart[];
  createdAt: string;
  team: WorkTeam;
  workflowMode: WorkflowMode;
  goal: string;
  customerId: string;
  knowledgeDocumentIds: string[];
  wechatSnapshotId: string | null;
  modelProfileId: string;
  mode: InferenceMode;
  continuation?: WorkContinuation;
};

function workTeamReferences(team: WorkTeam, roster: CowAgentProfile[], activity: AgentProgress[] = []): PromptAgentReference[] {
  const ids = [...new Set([team.agentId, ...(team.collaboratorAgentIds ?? [])].filter((id): id is string => Boolean(id)))];
  return ids.map((id) => {
    const agent = roster.find((entry) => entry.id === id);
    const snapshot = activity.filter((entry) => entry.agentId === id).at(-1);
    return {
      id,
      name: snapshot?.name || agent?.name || id,
      avatarUrl: snapshot?.avatarUrl || (agent?.avatar === "image" ? `/api/v1/cowagent/agents/${encodeURIComponent(id)}/avatar?v=${encodeURIComponent(agent.avatarRev || "0")}` : undefined),
      kind: id === team.agentId ? "main" : "collaborator",
    };
  });
}

function turnBranches(turn: LocalChatTurn): LocalChatTurnVersion[] {
  return turn.versions?.length ? turn.versions : [{ id: turn.id, user: turn.user, assistant: turn.assistant, createdAt: turn.createdAt, attachments: turn.attachments, parentVersionId: turn.parentVersionId, agentId: turn.agentId, collaboratorAgentIds: turn.collaboratorAgentIds, collaborationMode: turn.collaborationMode, agentActivity: turn.agentActivity }];
}

function savedVersionAnswer(version: LocalChatTurnVersion): string {
  return version.assistant.trim() || !version.agentActivity?.length ? version.assistant : interruptedTeamAnswer(version.agentActivity);
}

type VisibleChatBranch = { turn: LocalChatTurn; versions: LocalChatTurnVersion[]; index: number; version: LocalChatTurnVersion };

function resolveChatBranches(turns: LocalChatTurn[], selectedVersions: Record<string, string>): VisibleChatBranch[] {
  const visible: VisibleChatBranch[] = [];
  const visibleVersionIds = new Set<string>();
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    const previousTurn = turns[turnIndex - 1];
    const previousVersions = previousTurn ? turnBranches(previousTurn) : [];
    const versions = turnBranches(turn).filter((version) => {
      if (turnIndex === 0) return true;
      // Older saved conversations have no parent link. Associate each answer
      // with the previous version that existed when that answer was created.
      const inferredParent = [...previousVersions].reverse().find((candidate) => candidate.createdAt <= version.createdAt)?.id ?? previousVersions[0]?.id;
      const parentVersionId = version.parentVersionId ?? turn.parentVersionId ?? inferredParent;
      return Boolean(parentVersionId && visibleVersionIds.has(parentVersionId));
    });
    if (!versions.length) continue;
    const selectedIndex = versions.findIndex((version) => version.id === selectedVersions[turn.id]);
    const index = selectedIndex >= 0 ? selectedIndex : versions.length - 1;
    const entry = { turn, versions, index, version: versions[index] };
    visible.push(entry);
    visibleVersionIds.add(entry.version.id);
  }
  return visible;
}

function isLongformTask(text: string) {
  return !requestsCodeArtifact(text) && (/(?:长文|文章|文档|报告|论文|故事|小说|演讲稿|剧本|写一篇|写一份|写个文|write (?:a |an )?(?:essay|article|report|document|story))/i.test(text) || requestsGeneratedFile(text));
}

function requestsGeneratedFile(text: string) {
  return /(?:生成|创建|制作|写|导出|给我)[^\n]{0,36}(?:PDF|Word|DOCX|Excel|XLSX|电子表格|表格|TXT|Markdown|文档|文件)/i.test(text)
    || /(?:PDF|Word|DOCX|Excel|XLSX|电子表格|文档)[^\n]{0,24}(?:生成|创建|制作|写|导出|给我)/i.test(text);
}

function requestedFileFormat(text: string): "pdf" | "docx" | "xlsx" | null {
  if (!requestsGeneratedFile(text)) return null;
  if (/\bPDF\b/i.test(text)) return "pdf";
  if (/(?:Excel|XLSX|电子表格|数据表格)/i.test(text)) return "xlsx";
  if (/(?:Word|DOCX)/i.test(text)) return "docx";
  return null;
}

function previewKindFor(question: string, answer: string): GeneratedFileKind {
  if (extractCompleteHtml(answer) || (requestsCodeArtifact(question) && /(?:html|网页|网站)/i.test(question))) return "html";
  return /(?:Excel|XLSX|电子表格|数据表格)/i.test(question) ? "spreadsheet" : "document";
}

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

type ToolActivityStatus = "running" | "done" | "failed";

type ToolActivityStep = {
  id: string;
  name: string;
  status: ToolActivityStatus;
  quantity?: number;
  detail?: string;
};

function shortToolText(value: unknown, maxLength = 240): string {
  if (typeof value === "string") return value.trim().slice(0, maxLength);
  const record = asRecord(value);
  if (!record) return "";
  return textValue(record, "message", "error", "detail", "reason", "description").slice(0, maxLength);
}

function toolQuantity(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (Array.isArray(value) && value.length > 0) return value.length;
  return undefined;
}

function toolActivityQuantity(input: Record<string, unknown> | undefined, output: unknown): number | undefined {
  for (const key of ["siteCount", "websiteCount", "sites", "websites", "domains", "urls", "queries", "results"]) {
    const quantity = toolQuantity(input?.[key]);
    if (quantity) return quantity;
  }
  const outputRecord = asRecord(output);
  for (const key of ["siteCount", "websiteCount", "sites", "websites", "domains", "urls", "queries", "results"]) {
    const quantity = toolQuantity(outputRecord?.[key]);
    if (quantity) return quantity;
  }
  return undefined;
}

function toolNameFromPart(part: unknown): string {
  const record = asRecord(part);
  const type = textValue(record ?? {}, "type");
  return type.replace(/^tool-/, "") || "工具";
}

function toolDisplayName(name: string): string {
  const labels: Record<string, string> = {
    localComputer: "本机电脑",
    localBrowser: "网页读取",
    searchProducts: "产品搜索",
    searchKnowledge: "资料检索",
    webSearch: "网上搜索",
    getProductDetails: "产品详情",
    checkInventory: "库存查询",
    getProductAssets: "资料附件",
    createQuoteDraft: "报价草稿",
  };
  return labels[name] ?? (/(?:web|internet|browser|site|search)/i.test(name) ? "网站搜索" : name);
}

function toolActionLabel(name: string, input: Record<string, unknown> | undefined): string {
  const action = typeof input?.action === "string" ? input.action : "";
  if (name === "localComputer") {
    return ({ command: "执行命令", read_file: "读取文件", write_file: "保存文件", edit_file: "编辑文件", delete_file: "删除文件", list_files: "列出目录", list_dir: "列出目录", search_files: "搜索文件" } as Record<string, string>)[action] ?? "操作本机";
  }
  if (/(?:web|internet|browser|site)/i.test(name)) return "搜索网站";
  if (/search/i.test(name)) return "检索资料";
  return "执行工具";
}

function describeToolPart(part: unknown, index: number): ToolActivityStep {
  const record = asRecord(part) ?? {};
  const name = toolNameFromPart(part);
  const state = textValue(record, "state");
  const input = asRecord(record.input);
  const output = record.output;
  const status: ToolActivityStatus = state === "output-error" ? "failed" : state === "output-available" ? "done" : "running";
  const error = shortToolText(record.errorText) || shortToolText(record.error) || (status === "failed" ? shortToolText(output) : "");
  return {
    id: textValue(record, "toolCallId") || `${name}-${index}`,
    name,
    status,
    quantity: toolActivityQuantity(input, output),
    detail: error || toolActionLabel(name, input),
  };
}

function summarizeToolActivity(steps: ToolActivityStep[], busy: boolean): string {
  const active = [...steps].reverse().find((step) => step.status === "running");
  const current = active ?? steps.at(-1);
  if (!current) return busy ? "正在处理本轮任务" : "本轮任务已完成";
  if (busy && !active) return `正在整理结果 · 已完成 ${steps.length} 个步骤`;
  const searchingWeb = /(?:web|internet|browser|site)/i.test(current.name);
  const searching = /search/i.test(current.name);
  if (searchingWeb) return `${busy && current.status === "running" ? "正在搜索" : "已搜索"}${current.quantity ? ` ${current.quantity} 个网站` : "网站"}`;
  if (searching) return `${busy && current.status === "running" ? "正在检索" : "已完成检索"}${current.quantity ? ` ${current.quantity} 项` : "资料"}`;
  if (current.name === "localComputer") return busy && current.status === "running" ? `正在操作本机 · ${current.detail}` : `本机操作${current.status === "failed" ? "失败" : "已完成"}`;
  return busy && current.status === "running" ? `正在${toolDisplayName(current.name)} · ${current.detail}` : `${toolDisplayName(current.name)}${current.status === "failed" ? "失败" : "已完成"}`;
}

function waitingActivityLabel(elapsed: number): string {
  if (elapsed < 2) return "正在准备请求";
  if (elapsed < 8) return "正在连接本地模型";
  if (elapsed < 30) return "正在等待模型回复";
  if (elapsed < 90) return "正在生成回答";
  return "仍在处理，请稍候";
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

function savedAgentId(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(agentPreferenceKey)?.trim() || "";
  } catch {
    return "";
  }
}

function AgentAvatar({ agent }: { agent: CowAgentProfile }) {
  const initials = agent.name.trim().slice(0, 2).toUpperCase() || "AI";
  return <span className={styles.agentAvatar} data-kind={agent.type}>
    {agent.avatar === "image"
      ? <Image src={`/api/v1/cowagent/agents/${encodeURIComponent(agent.id)}/avatar?v=${encodeURIComponent(agent.avatarRev || "0")}`} alt="" width={36} height={36} unoptimized />
      : initials}
  </span>;
}

function presentationRole(agent?: CowAgentProfile): AgentRoleId {
  if (!agent) return DEFAULT_AGENT_ROLE_ID;
  if (isAgentRoleId(agent.id)) return agent.id;
  if (agent.botType === "weixin_personal") return "wechat-service";
  return DEFAULT_AGENT_ROLE_ID;
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
  preferredRoleId,
  selectAllKnowledge = false,
  onOpenKnowledge,
  onAddToKit,
  onOpenCustomer,
  onOpenProduct,
  onToast,
  historyPortalTarget,
  onOpenWechat,
  projectId,
  initialChatId,
  onOpenProject,
}: AgentWorkspaceProps) {
  const [experience, setExperience] = useState(initialExperience);
  const [moveChatId, setMoveChatId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const initialChatLoaded = useRef(false);
  const publicWork = useSyncExternalStore(subscribeHost, isPublicHost, () => false);
  const [workAgentId, setWorkAgentId] = useState(savedAgentId);
  const [collaboratorAgentIds, setCollaboratorAgentIds] = useState<string[]>([]);
  const [submittedWorkReferences, setSubmittedWorkReferences] = useState<PromptAgentReference[]>([]);
  const [collaborationMode, setCollaborationMode] = useState<CollaborationMode>("parallel");
  const [collaborationModeExplicit, setCollaborationModeExplicit] = useState(false);
  const [submittedCollaborationMode, setSubmittedCollaborationMode] = useState<CollaborationMode>();
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [agentRoster, setAgentRoster] = useState<CowAgentRoster>({ agents: [], defaultAgentId: "", revision: "" });
  const [agentLoading, setAgentLoading] = useState(true);
  const [agentError, setAgentError] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>("normal");
  const [goal, setGoal] = useState("");
  const [input, setInput] = useState(initialMessage ?? "");
  const [imageAttachments, setImageAttachments] = useState<FileUIPart[]>([]);
  const [questionImages, setQuestionImages] = useState<FileUIPart[]>([]);
  // Do not silently attach an arbitrary demo customer to a free-form chat.
  // A customer context is sent only when the caller or user explicitly picks it.
  const initialCustomer = initialCustomerId ? customers.find((customer) => customer.id === initialCustomerId) : undefined;
  const [customerId, setCustomerId] = useState(initialCustomer?.id ?? "");
  const [question, setQuestion] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyHeight, setHistoryHeight] = useState(10000);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [editedPrompt, setEditedPrompt] = useState("");
  const [previewSource, setPreviewSource] = useState<{ turnId: string; title: string; kind: GeneratedFileKind; autoDownloadPdf?: boolean; requestId?: string } | null>(null);
  const [sessionSummaries, setSessionSummaries] = useState<LocalChatSummary[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [activeSession, setActiveSession] = useState<LocalChatSession | null>(null);
  const [branchSelections, setBranchSelections] = useState<Record<string, string>>({});
  const [liveTurnId, setLiveTurnId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [cancelled, setCancelled] = useState(false);
  const [mode, setMode] = useState<InferenceMode>(savedInferenceMode);
  const [receipt, setReceipt] = useState<InferenceReceipt | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [knowledgeCoverage, setKnowledgeCoverage] = useState<KnowledgeCoverage[]>([]);
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<KnowledgeDocument[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(true);
  const [knowledgeError, setKnowledgeError] = useState("");
  const [wechatSnapshotId, setWechatSnapshotId] = useState<string | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<QueuedWorkMessage[]>([]);
  const [queueEnabled, setQueueEnabled] = useState(true);
  const [queueMoreId, setQueueMoreId] = useState<string | null>(null);
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const [queuedEditText, setQueuedEditText] = useState("");
  const [sideChatQueueId, setSideChatQueueId] = useState<string | null>(null);
  const [guideNotice, setGuideNotice] = useState("");
  const [queueDrainTick, setQueueDrainTick] = useState(0);
  const submitting = useRef(false);
  const activeSessionRef = useRef<LocalChatSession | null>(null);
  const pendingTurnRef = useRef<{ id: string; user: string; createdAt: string; attachments: string[]; parentVersionId?: string; regenerate?: boolean } & WorkTeam | null>(null);
  const guideCurrentRef = useRef(false);
  const guideQueuedIdRef = useRef<string | null>(null);
  const queueDrainRef = useRef(false);
  const conversationRef = useRef<HTMLElement>(null);
  const followOutputRef = useRef(true);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const addMenuButtonRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const contextPanelRef = useRef<HTMLElement>(null);
  const queueMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contextOpen) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !contextPanelRef.current?.contains(event.target)) setContextOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setContextOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [contextOpen]);

  useEffect(() => {
    if (!queueMoreId) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !queueMoreRef.current?.contains(event.target)) setQueueMoreId(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setQueueMoreId(null); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [queueMoreId]);
  const mentionButtonRef = useRef<HTMLButtonElement>(null);
  const historyDragRef = useRef<{ y: number; height: number } | null>(null);
  const catalog = useModelCatalog();
  const { health, checking, refresh: refreshHealth } = useModelHealth(catalog.modelProfileId);
  const enabledAgents = useMemo(() => agentRoster.agents.filter((agent) => agent.enabled && agent.type === "local" && agent.id !== "default"), [agentRoster.agents]);
  const availableCollaborators = useMemo(() => agentRoster.agents.filter((agent) => agent.enabled && agent.id !== "default"), [agentRoster.agents]);
  const selectedWorkAgent = enabledAgents.find((agent) => agent.id === workAgentId);
  const assignedKnowledgeIds = new Set(selectedWorkAgent?.knowledgeBaseIds ?? []);
  const availableKnowledgeDocuments = experience === "work" ? knowledgeDocuments.filter((document) => assignedKnowledgeIds.has(document.id)) : knowledgeDocuments;
  const effectiveSelectedDocumentIds = experience === "work" ? selectedDocumentIds.filter((id) => assignedKnowledgeIds.has(id)) : selectedDocumentIds;
  const collaborators: CowAgentProfile[] = [
    ...availableCollaborators.filter((agent) => collaboratorAgentIds.includes(agent.id) && agent.id !== selectedWorkAgent?.id),
    ...collaboratorAgentIds.filter((id) => id !== workAgentId && !availableCollaborators.some((agent) => agent.id === id)).map((id) => ({ id, name: `${id}（已不可用）`, enabled: false, type: "local" as const, workspace: "", knowledgeMode: "shared" as const })),
  ];
  const mentionCandidates = availableCollaborators.filter((agent) => agent.id !== selectedWorkAgent?.id && !collaboratorAgentIds.includes(agent.id) && (mentionQuery === null || `${agent.name} ${agent.id}`.toLowerCase().includes(mentionQuery.toLowerCase()))).slice(0, 8);
  const contextTokens = catalog.selectedModel?.contextTokens ?? health?.contextTokens ?? null;
  const catalogInputBudget = contextTokens && contextTokens >= 24_576
    ? mode === "ultra" ? 12_000 : mode === "medium" ? 10_000 : 8_000
    : null;
  const inputBudget = receipt?.inputBudget ?? catalogInputBudget ?? (catalog.modelProfileId === "configured" || mode === "auto" ? 4_000 : getInferenceProfileInputBudget(mode));
  const rolePresetId = experience === "chat" ? DEFAULT_AGENT_ROLE_ID : preferredRoleId ?? presentationRole(selectedWorkAgent);
  const baseRole = getAgentRoleOption(rolePresetId);
  const role = experience === "work" && selectedWorkAgent ? { ...baseRole, name: selectedWorkAgent.name, description: selectedWorkAgent.description || baseRole.description } : baseRole;
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
  const { messages, sendMessage, status, error, stop, setMessages, clearError } = useChat<SalesAgentUIMessage>({ transport, throttle: 40, onFinish: ({ message, finishReason, isAbort, isError }) => {
    setExhausted(finishReason === "length");
    const pending = pendingTurnRef.current;
    const session = activeSessionRef.current;
    if (!pending || !session) return;
    const guideRequested = guideCurrentRef.current;
    guideCurrentRef.current = false;
    pendingTurnRef.current = null;
    const outputText = projectAgentSearch([message]).text;
    const interrupted = isAbort || isError || !outputText.trim();
    const agentActivity = readAgentProgress(message.parts).map((record) => interrupted && record.state === "running" ? { ...record, state: "cancelled" as const } : record);
    const answer = outputText.trim() || !agentActivity.length ? outputText : interruptedTeamAnswer(agentActivity);
    const existingIndex = session.turns.findIndex((turn) => turn.id === pending.id);
    const nextTurns = [...session.turns];
    if (pending.regenerate && existingIndex >= 0) {
      const existing = nextTurns[existingIndex];
      const versions = turnBranches(existing);
      const nextVersion: LocalChatTurnVersion = { id: crypto.randomUUID(), user: pending.user, assistant: answer, createdAt: pending.createdAt, attachments: pending.attachments, parentVersionId: pending.parentVersionId, agentId: pending.agentId, collaboratorAgentIds: pending.collaboratorAgentIds, collaborationMode: pending.collaborationMode, agentActivity };
      nextTurns[existingIndex] = { ...existing, user: pending.user, assistant: answer, attachments: pending.attachments, agentId: pending.agentId, collaboratorAgentIds: pending.collaboratorAgentIds, collaborationMode: pending.collaborationMode, agentActivity, versions: [...versions, nextVersion] };
      setBranchSelections((current) => ({ ...current, [pending.id]: nextVersion.id }));
      // A regenerated old turn is now a saved row again. Keeping it as the
      // live row hid the branch navigator and left the old prompt on screen.
      setLiveTurnId(null);
      setQuestion("");
      setQuestionImages([]);
    } else {
      nextTurns.push({ id: pending.id, user: pending.user, assistant: answer, createdAt: pending.createdAt, attachments: pending.attachments, parentVersionId: pending.parentVersionId, agentId: pending.agentId, collaboratorAgentIds: pending.collaboratorAgentIds, collaborationMode: pending.collaborationMode, agentActivity });
    }
    const next: LocalChatSession = { ...session, updatedAt: new Date().toISOString(), turns: nextTurns };
    activeSessionRef.current = next;
    setActiveSession(next);
    setSessionSummaries((current) => [{ id: next.id, title: next.title, experience: next.experience, agentId: next.agentId, createdAt: next.createdAt, updatedAt: next.updatedAt, pinned: next.pinned, archived: next.archived, projectId: next.projectId, turnCount: next.turns.length }, ...current.filter((item) => item.id !== next.id)]);
    setHistoryRevision((current) => current + 1);
    void saveLocalChat(next).then(() => { window.dispatchEvent(new Event("lumaflow-chat-history-updated")); }).catch(() => onToast?.("对话已显示，但保存到本机失败；请检查本地服务。"));
    if (session.experience === "work") {
      const continuation: WorkContinuation = {
        turnId: pending.id,
        task: pending.user,
        assistant: answer,
        agentActivity: agentActivity.map((record) => ({ ...record })),
        team: { agentId: pending.agentId, collaboratorAgentIds: [...(pending.collaboratorAgentIds ?? [])], collaborationMode: pending.collaborationMode },
      };
      // Every queued message is an addition to the latest completed Work turn.
      // Updating the snapshot here preserves the complete answer and Agent
      // references when several requests were queued during one stream.
      setQueuedMessages((current) => current.map((item) => item.continuation ? { ...item, continuation } : item));
    }
    if (guideRequested) {
      const priorityQueuedId = guideQueuedIdRef.current;
      guideQueuedIdRef.current = null;
      if (priorityQueuedId) {
        setQueueEnabled(true);
        setGuideNotice("已停止当前请求并保留已生成内容；选中的排队任务将在当前上下文后优先执行。");
      } else {
        setQueueEnabled(false);
        setGuideNotice("当前请求不能在生成中追加引导。已停止并保留已生成内容；请补充引导后重新发送。排队草稿已保留。");
      }
    }
    setQueueDrainTick((current) => current + 1);
  } });
  const busy = status === "submitted" || status === "streaming";
  const ready = Boolean(catalog.selectedModel && !catalog.loading && !checking && health?.reachable && (experience === "chat" || selectedWorkAgent));
  const result = useMemo(() => projectAgentSearch(messages), [messages]);
  const agentActivity = useMemo(() => readAgentProgress(messages.filter((message) => message.role === "assistant").flatMap((message) => message.parts)), [messages]);
  const toolParts = useMemo(() => messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .filter(isToolUIPart), [messages]);
  const toolActivitySteps = useMemo(() => toolParts.map((part, index) => describeToolPart(part, index)), [toolParts]);
  const toolActivitySummary = useMemo(() => toolActivitySteps.length ? summarizeToolActivity(toolActivitySteps, busy) : waitingActivityLabel(elapsed), [busy, elapsed, toolActivitySteps]);
  const selectedCustomer = customers.find((customer) => customer.id === customerId);
  const selectedDocuments = availableKnowledgeDocuments.filter((document) => effectiveSelectedDocumentIds.includes(document.id));
  const selectedModelName = health?.model ?? catalog.selectedModel?.model ?? "等待读取模型";
  const visibleBranches = useMemo(() => resolveChatBranches(activeSession?.turns ?? [], branchSelections), [activeSession, branchSelections]);
  const pastBranches = visibleBranches.filter(({ turn }) => turn.id !== liveTurnId);
  const pastTurns = pastBranches.map(({ turn }) => turn);
  const liveBranch = visibleBranches.find(({ turn }) => turn.id === liveTurnId);
  const liveVersion = liveBranch?.version;
  const liveSavedTurn = liveBranch?.turn;
  const showLiveTurn = Boolean(question && (busy || liveSavedTurn || !activeSession?.turns.some((turn) => turn.id === liveTurnId)));
  const showWorkSummary = experience === "work" && (busy || showLiveTurn || pastTurns.length > 0);
  const displayQuestion = !busy && liveBranch ? liveBranch.version.user : question;
  const displayAnswer = !busy && liveBranch ? savedVersionAnswer(liveBranch.version) : result.text;
  const liveWorkReferences = experience === "work" ? !busy && liveVersion
    ? workTeamReferences(versionWorkTeam(liveVersion), agentRoster.agents, liveVersion.agentActivity)
    : submittedWorkReferences : [];
  const liveAgentName = experience === "chat" ? "LumaFlow" : liveWorkReferences.find((agent) => agent.kind === "main")?.name || "本地 Agent";
  const displayedCollaborationMode = collaborationModeExplicit ? collaborationMode : inferCollaborationMode(editingTurnId ? editedPrompt : input);
  const liveCollaborationMode = !busy && liveVersion ? versionWorkTeam(liveVersion).collaborationMode : submittedCollaborationMode;
  const htmlArtifact = extractCompleteHtml(displayAnswer);
  const documentLayout = isLongformTask(displayQuestion);
  const previewTurn = previewSource ? activeSession?.turns.find((turn) => turn.id === previewSource.turnId) : null;
  const previewContent = previewSource ? previewTurn ? savedVersionAnswer(branchView(previewTurn).version) : result.text : "";

  function branchView(turn: LocalChatTurn) {
    return visibleBranches.find((entry) => entry.turn.id === turn.id) ?? resolveChatBranches([turn], branchSelections)[0];
  }

  function versionWorkTeam(version: LocalChatTurnVersion, session = activeSession): WorkTeam {
    return { agentId: version.agentId ?? session?.agentId, collaboratorAgentIds: version.collaboratorAgentIds ?? [], collaborationMode: version.collaborationMode ?? inferCollaborationMode(version.user) };
  }

  function restoreWorkTeam(version: LocalChatTurnVersion, session = activeSession, restoreCollaborators = false) {
    if (session?.experience !== "work") return;
    const team = versionWorkTeam(version, session);
    if (team.agentId) setWorkAgentId(team.agentId);
    setCollaboratorAgentIds(restoreCollaborators ? [...(team.collaboratorAgentIds ?? [])] : []);
    setCollaborationMode(team.collaborationMode ?? "parallel"); setCollaborationModeExplicit(true);
    const mainAgent = enabledAgents.find((agent) => agent.id === team.agentId);
    setSelectedDocumentIds((current) => current.filter((id) => mainAgent?.knowledgeBaseIds?.includes(id)));
    setAgentPickerOpen(false); setMentionQuery(null); setMentionRange(null);
  }

  function beginEditTurn(turnId: string, prompt: string) {
    const turn = activeSessionRef.current?.turns.find((entry) => entry.id === turnId);
    if (turn) restoreWorkTeam(branchView(turn).version, activeSessionRef.current, true);
    setEditingTurnId(turnId); setEditedPrompt(prompt);
  }

  function cancelEditTurn() {
    const turn = activeSessionRef.current?.turns.find((entry) => entry.id === editingTurnId);
    if (turn) restoreWorkTeam(branchView(turn).version);
    setEditingTurnId(null); setEditedPrompt("");
  }

  function branchControls(turn: LocalChatTurn) {
    const { versions, index } = branchView(turn);
    if (versions.length < 2) return null;
    const selectVersion = (versionId: string) => {
      setPreviewSource(null);
      setEditingTurnId(null);
      setBranchSelections((current) => ({ ...current, [turn.id]: versionId }));
      const selected = versions.find((version) => version.id === versionId);
      if (selected) restoreWorkTeam(selected);
    };
    return <div className={styles.branchControls} aria-label="回答分支">
      <button type="button" aria-label="上一个分支" disabled={busy || index === 0} onClick={() => selectVersion(versions[index - 1].id)}><ChevronLeft size={16} /></button>
      <span>{index + 1} / {versions.length}</span>
      <button type="button" aria-label="下一个分支" disabled={busy || index === versions.length - 1} onClick={() => selectVersion(versions[index + 1].id)}><ChevronRight size={16} /></button>
    </div>;
  }

  function generatedFileCard(turnId: string, title: string, answer: string, complete: boolean) {
    const format = experience === "chat" ? requestedFileFormat(title) : null;
    if (!format || !answer) return null;
    const kind = previewKindFor(title, answer);
    const label = format === "pdf" ? "PDF" : format === "xlsx" ? "Excel" : "Word";
    return <div className={styles.generatedFileCard} aria-label={`已生成${label}文件`}>
      <span className={styles.generatedFileIcon}><FileText size={20} /></span>
      <span className={styles.generatedFileDetails}><strong>{label} 文档</strong><small>{complete ? "点击下载后保存到这台电脑" : "正文生成中，完成后即可下载"}</small></span>
      <button type="button" disabled={!complete} onClick={() => setPreviewSource({ turnId, title, kind })}><Eye size={14} /> 预览</button>
      <button type="button" className={styles.generatedFileDownload} disabled={!complete} onClick={() => setPreviewSource({ turnId, title, kind, autoDownloadPdf: format === "pdf", requestId: crypto.randomUUID() })}><Download size={14} /> {format === "pdf" ? "下载 PDF" : "打开下载"}</button>
    </div>;
  }

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try { const saved = localStorage.getItem(goalStorageKey); if (saved) { setGoal(saved); setWorkflowMode("goal"); } } catch { /* optional local preference */ }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (publicWork) return;
    let active = true;
    const timer = window.setTimeout(() => { void listLocalChats().then((items) => { if (active) setSessionSummaries(items); }).catch(() => {}); }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [publicWork, historyRevision]);

  useEffect(() => { const refresh = () => setHistoryRevision((current) => current + 1); window.addEventListener("lumaflow-chat-history-updated", refresh); return () => window.removeEventListener("lumaflow-chat-history-updated", refresh); }, []);

  useEffect(() => {
    const pane = conversationRef.current;
    if (pane && followOutputRef.current) pane.scrollTop = pane.scrollHeight;
  }, [result.text, question, pastTurns.length]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/cowagent/agents", { cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "无法读取本地 Agent 名单");
      const next = payload.data as CowAgentRoster;
      if (controller.signal.aborted) return;
      setAgentRoster(next); setAgentError("");
      const candidates = next.agents.filter((agent) => agent.enabled && agent.type === "local" && agent.id !== "default");
      const preferred = preferredRoleId ? candidates.find((agent) => agent.id === preferredRoleId || agent.roleIds?.includes(preferredRoleId)) : undefined;
      setWorkAgentId((current) => preferred?.id || (candidates.some((agent) => agent.id === current) ? current : candidates[0]?.id || ""));
    }).catch((issue) => {
      if (!controller.signal.aborted) { setAgentRoster({ agents: [], defaultAgentId: "", revision: "" }); setAgentError(issue instanceof Error ? issue.message : "CowAgent 后端未连接"); }
    }).finally(() => { if (!controller.signal.aborted) setAgentLoading(false); });
    return () => controller.abort();
  }, [preferredRoleId]);

  useEffect(() => {
    const updated = (event: Event) => {
      const next = (event as CustomEvent<{ roster?: CowAgentRoster }>).detail?.roster;
      if (!next || !Array.isArray(next.agents)) return;
      setAgentRoster(next); setAgentError("");
    };
    window.addEventListener("lumaflow-agents-updated", updated);
    return () => window.removeEventListener("lumaflow-agents-updated", updated);
  }, []);

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
        const uniqueDocuments = [...new Map(documents.map((document) => [document.id, document])).values()];
        setKnowledgeDocuments(uniqueDocuments);
        if (selectAllKnowledge) setSelectedDocumentIds(uniqueDocuments.filter((document) => document.selectable).slice(0, 50).map((document) => document.id));
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
  }, [selectAllKnowledge]);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => () => { void stop(); }, [stop]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const closeOnOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (addMenuRef.current?.contains(target) || addMenuButtonRef.current?.contains(target)) return;
      setAddMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [addMenuOpen]);

  useEffect(() => {
    if (!agentPickerOpen && mentionQuery === null) return;
    const closeOnOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (agentPickerOpen && !agentPickerRef.current?.contains(target)) setAgentPickerOpen(false);
      if (mentionQuery !== null && !mentionMenuRef.current?.contains(target) && !mentionButtonRef.current?.contains(target) && !inputRef.current?.contains(target)) {
        setMentionQuery(null);
        setMentionRange(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAgentPickerOpen(false);
        setMentionQuery(null);
        setMentionRange(null);
      }
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [agentPickerOpen, mentionQuery]);

  function resetOutput() {
    setMessages([]); clearError(); setQuestion(""); setQuestionImages([]); setCancelled(false);
    setReceipt(null); setExhausted(false); setKnowledgeCoverage([]);
    setPreviewSource(null);
    setSubmittedWorkReferences([]);
    setSubmittedCollaborationMode(undefined);
  }

  function clearActiveSession() {
    activeSessionRef.current = null;
    pendingTurnRef.current = null;
    setActiveSession(null);
    setBranchSelections({});
    setLiveTurnId(null);
    followOutputRef.current = true;
  }

  async function openSavedSession(id: string) {
    if (busy) return;
    if (queuedMessages.length) { onToast?.("还有排队消息，请先执行或删除后再打开其他对话。"); return; }
    try {
      const session = await loadLocalChat(id);
      if (!session) { onToast?.("这条本地对话已不存在。"); return; }
      activeSessionRef.current = session;
      setActiveSession(session);
      setBranchSelections({});
      setLiveTurnId(null);
      setExperience(session.experience);
      const latestBranch = resolveChatBranches(session.turns, {}).at(-1);
      if (latestBranch) restoreWorkTeam(latestBranch.version, session);
      setEditingTurnId(null); setEditedPrompt("");
      resetOutput(); setInput(""); setHistoryOpen(false); followOutputRef.current = false;
    } catch { onToast?.("无法从本机读取这条对话。"); }
  }

  async function deleteSavedSession(id: string) {
    if (busy || submitting.current) { onToast?.("当前任务正在执行，完成后再删除对话。"); return; }
    if (queuedMessages.length && activeSessionRef.current?.id === id) { onToast?.("这条对话还有排队消息，请先执行或删除排队消息。"); return; }
    try {
      await removeLocalChat(id);
      window.dispatchEvent(new Event("lumaflow-chat-history-updated"));
      setSessionSummaries((current) => current.filter((item) => item.id !== id));
      if (activeSessionRef.current?.id === id) { clearActiveSession(); resetOutput(); }
    } catch { onToast?.("删除本地对话失败。"); }
  }

  async function updateSavedSessionMetadata(id: string, patch: { title?: string; pinned?: boolean; projectId?: string | null }) {
    if (busy || submitting.current) { onToast?.("当前任务正在执行，完成后再修改对话设置。"); return; }
    try {
      const next = await updateLocalChatMetadata(id, patch);
      window.dispatchEvent(new Event("lumaflow-chat-history-updated"));
      setSessionSummaries((current) => current.map((item) => item.id === id ? { ...item, title: next.title, updatedAt: next.updatedAt, pinned: next.pinned, projectId: next.projectId } : item));
      if (activeSessionRef.current?.id === id) {
        activeSessionRef.current = next;
        setActiveSession(next);
      }
    } catch { onToast?.("更新对话记录失败。"); }
  }

  async function shareSavedSession(id: string) {
    try {
      await copyLocalChatText(id);
      onToast?.("对话内容已复制，可以粘贴分享。");
    } catch (issue) {
      onToast?.(issue instanceof Error ? issue.message : "分享对话失败。");
    }
  }

  const activeProjectId = activeSession ? activeSession.projectId : projectId;
  useEffect(() => {
    let alive = true;
    if (activeProjectId) void projectRequest<{ project: Project }>(`/api/v1/projects?id=${activeProjectId}`).then((result) => { if (alive) setProject(result.project); }).catch(() => { if (alive) setProject(null); });
    else { const timer = setTimeout(() => { if (alive) setProject(null); }, 0); return () => { alive = false; clearTimeout(timer); }; }
    return () => { alive = false; };
  }, [activeProjectId]);
  useEffect(() => {
    if (!initialChatId || initialChatLoaded.current) return;
    initialChatLoaded.current = true;
    void openSavedSession(initialChatId);
    // The shell creates a fresh workspace for each explicit history entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialChatId]);
  async function saveAnswerToProject(title: string, text: string) {
    if (!activeProjectId) return;
    try {
      const latest = await projectRequest<{ project: Project }>(`/api/v1/projects?id=${activeProjectId}`);
      const next = await projectRequest<Project>(`/api/v1/projects?id=${activeProjectId}`, "PATCH", { sources: [...latest.project.sources, { id: crypto.randomUUID(), title: title.slice(0, 120) || "回答", text, createdAt: new Date().toISOString() }] });
      setProject(next); projectsUpdated(); onToast?.("回答已保存为项目资料。");
    } catch (issue) { onToast?.((issue as Error).message); }
  }

  function changeExperience(next: "chat" | "work") {
    if (busy || submitting.current || next === experience) return;
    if (queuedMessages.length) { onToast?.("还有排队消息，请先执行、编辑或删除后再切换模式。"); return; }
    setAgentPickerOpen(false); setMentionQuery(null); setMentionRange(null);
    setExperience(next); resetOutput(); clearActiveSession();
    if (next === "work") setSelectedDocumentIds((current) => current.filter((id) => assignedKnowledgeIds.has(id)));
    // Customer and pending image attachments remain visible in the composer.
  }

  function newQuestion() {
    if (busy || submitting.current) return;
    if (queuedMessages.length) { onToast?.("还有排队消息，请先执行、编辑或删除后再开始新问题。"); return; }
    resetOutput(); clearActiveSession(); setInput(""); setImageAttachments([]); setQuestionImages([]); setCustomerId(""); setSelectedDocumentIds([]);
    setWechatSnapshotId(null);
    setCollaboratorAgentIds([]); setMentionQuery(null); setMentionRange(null);
    setCollaborationMode("parallel"); setCollaborationModeExplicit(false);
    setContextOpen(false); setAddMenuOpen(false); setAgentPickerOpen(false); inputRef.current?.focus();
    setEditingTurnId(null); setEditedPrompt("");
  }

  function setPersistentGoal(value: string) {
    const next = value.slice(0, 500);
    setGoal(next);
    try { if (next.trim()) localStorage.setItem(goalStorageKey, next); else localStorage.removeItem(goalStorageKey); } catch { /* optional local preference */ }
  }

  async function addLocalFiles(files: FileList | null, folder = false) {
    if (!files?.length) return;
    const selected = Array.from(files);
    const images = selected.filter((file) => ["image/jpeg", "image/png", "image/webp"].includes(file.type));
    const documents = selected.filter((file) => !images.includes(file));
    if (images.length) await addImages(images);
    if (documents.length) await importTextFiles(documents, folder);
    setAddMenuOpen(false);
  }

  function changeAgent(value: string) {
    if (busy || !enabledAgents.some((agent) => agent.id === value)) return;
    setAgentPickerOpen(false);
    const nextAgent = enabledAgents.find((agent) => agent.id === value);
    setWorkAgentId(value);
    setSelectedDocumentIds((current) => current.filter((id) => nextAgent?.knowledgeBaseIds?.includes(id)));
    setCollaboratorAgentIds((current) => current.filter((id) => id !== value));
    try { localStorage.setItem(agentPreferenceKey, value); } catch { /* persistence is optional */ }
    if (editingTurnId) return;
    setReceipt(null);
    setExhausted(false);
    setMessages([]);
    clearActiveSession();
    clearError();
    setQuestion("");
    setCancelled(false);
    setKnowledgeCoverage([]);
  }

  function changeWorkInput(value: string, cursor: number) {
    setInput(value);
    if (experience !== "work") return;
    const match = /@([^\s@]*)$/.exec(value.slice(0, cursor));
    setMentionQuery(match ? match[1] : null);
    setMentionRange(match ? { start: cursor - match[0].length, end: cursor } : null);
  }

  function addCollaborator(agentId: string) {
    if (busy || collaboratorAgentIds.includes(agentId) || agentId === selectedWorkAgent?.id || collaboratorAgentIds.length >= 3) return;
    setCollaboratorAgentIds((current) => [...current, agentId]);
    if (mentionRange) setInput((current) => `${current.slice(0, mentionRange.start)}${current.slice(mentionRange.end)}`);
    setMentionQuery(null); setMentionRange(null);
    inputRef.current?.focus();
  }

  function changeModel(value: string) {
    if (busy || submitting.current || value === catalog.modelProfileId) return;
    if (wechatSnapshotId && value === "configured") { onToast?.("微信快照仅允许使用本机 8B / 14B；开始新问题后可切换其他服务。"); return; }
    catalog.selectModel(value);
    setMode("light");
    persistInferenceMode("light");
    setReceipt(null);
    setExhausted(false);
    setMessages([]);
    clearActiveSession();
    clearError();
    setQuestion("");
    setCancelled(false);
    setKnowledgeCoverage([]);
  }

  function changeMode(next: InferenceMode) {
    if (busy || submitting.current) return;
    setMode(next); persistInferenceMode(next);
    setMessages([]); clearActiveSession(); clearError(); setQuestion(""); setCancelled(false);
    setReceipt(null); setExhausted(false); setKnowledgeCoverage([]);
  }

  function toggleDocument(document: KnowledgeDocument) {
    if (!document.selectable || busy) return;
    setSelectedDocumentIds((current) => {
      if (experience === "work") current = current.filter((id) => assignedKnowledgeIds.has(id));
      if (current.includes(document.id)) return current.filter((id) => id !== document.id);
      if (current.length >= 50) {
        onToast?.("每次最多选择 50 份知识库文件");
        return current;
      }
      return [...current, document.id];
    });
  }

  function restoreFailedQueuedItem(item: QueuedWorkMessage, notice: string) {
    setQueuedMessages((current) => current.some((entry) => entry.id === item.id) ? current : [item, ...current]);
    setQueueEnabled(false);
    setGuideNotice(notice);
  }

  async function submit(value = input, files: FileUIPart[] = imageAttachments, regenerateId?: string, teamOverride?: WorkTeam, queuedItem?: QueuedWorkMessage) {
    const sendFiles = queuedItem?.files ?? files;
    const cleanValue = (queuedItem?.text ?? value).trim();
    const runningTeam = pendingTurnRef.current ? { agentId: pendingTurnRef.current.agentId, collaboratorAgentIds: [...(pendingTurnRef.current.collaboratorAgentIds ?? [])], collaborationMode: pendingTurnRef.current.collaborationMode } : undefined;
    const requestTeam = experience === "work" ? queuedItem?.team ?? teamOverride ?? (busy && runningTeam ? runningTeam : { agentId: selectedWorkAgent?.id, collaboratorAgentIds: collaborators.map((agent) => agent.id), ...(collaborationModeExplicit ? { collaborationMode } : {}) }) : undefined;
    const requestCollaborationMode = requestTeam ? requestTeam.collaborationMode ?? inferCollaborationMode(cleanValue) : undefined;
    const requestAgent = enabledAgents.find((agent) => agent.id === requestTeam?.agentId);
    const requestWorkflowMode = queuedItem?.workflowMode ?? workflowMode;
    const requestGoal = queuedItem?.goal ?? goal;
    const requestCustomerId = queuedItem?.customerId ?? customerId;
    const requestKnowledgeDocumentIds = queuedItem?.knowledgeDocumentIds ?? selectedDocumentIds;
    const requestWechatSnapshotId = queuedItem?.wechatSnapshotId ?? wechatSnapshotId;
    const requestModelProfileId = queuedItem?.modelProfileId ?? catalog.modelProfileId;
    const requestMode = queuedItem?.mode ?? mode;
    if (experience === "work" && !requestAgent) { onToast?.("这轮保存的主 Agent 已不可用，请修改提问并选择其他本地 Agent。"); if (queuedItem) restoreFailedQueuedItem(queuedItem, "排队任务的主 Agent 已不可用；消息已保留，请调整 Agent 后重新开启排队。"); return; }
    if (requestTeam?.collaboratorAgentIds?.some((id) => !availableCollaborators.some((agent) => agent.id === id))) { onToast?.("这轮有协作 Agent 已不可用，请修改提问并调整协作成员。"); if (queuedItem) restoreFailedQueuedItem(queuedItem, "排队任务的协作 Agent 已不可用；消息已保留，请调整成员后重新开启排队。"); return; }
    if (requestWorkflowMode === "goal" && !requestGoal.trim()) { onToast?.("请先填写要持续追求的目标。"); if (queuedItem) restoreFailedQueuedItem(queuedItem, "排队任务缺少持续目标；消息已保留，请补充目标后重新开启排队。"); return; }
    const fileInstruction = experience === "chat" && requestsGeneratedFile(cleanValue) && !requestsCodeArtifact(cleanValue)
      ? /(?:Excel|XLSX|电子表格|数据表格)/i.test(cleanValue)
        ? "\n\n请直接输出完整的 Markdown 表格，首行为清晰的列名，一行对应电子表格的一行。需要说明时放在表格前后。页面会据此制作本机 Excel 文件；不要给出不存在的下载链接。"
        : "\n\n请直接输出可排版的完整 Markdown 正文，包括用户要求的全部内容。页面会将正文制作成可预览、可下载的本机 Word 或 PDF 文件。不要解释如何使用 Word、Google Docs 或其他工具导出文件，也不要给出不存在的下载链接。"
      : "";
    const taskPrompt = (requestWorkflowMode === "goal" ? `持续目标：${requestGoal.trim()}\n\n本轮请求：${cleanValue || "请查看我附加的图片。"}` : requestWorkflowMode === "plan" ? `计划模式：请先给出分步骤计划、验收方法和待确认问题；本轮不要执行工具或修改文件。\n\n任务：${cleanValue || "请查看我附加的图片。"}` : cleanValue || "请查看我附加的图片。") + fileInstruction;
    const regenerateIndex = regenerateId ? activeSessionRef.current?.turns.findIndex((turn) => turn.id === regenerateId) ?? -1 : -1;
    const visibleContext = activeSessionRef.current?.experience === experience
      ? resolveChatBranches(activeSessionRef.current.turns, branchSelections) : [];
    const previous = (regenerateIndex >= 0
      ? visibleContext.filter(({ turn }) => activeSessionRef.current!.turns.findIndex((candidate) => candidate.id === turn.id) < regenerateIndex)
      : visibleContext).slice(-3);
    const historyContext = previous.map(({ version }) => `用户：${version.user.slice(0, 220)}\n助手：${version.assistant.slice(0, 340)}`).join("\n\n");
    let prompt = taskPrompt;
    if (queuedItem) {
      const savedTurns = visibleContext.map(({ version }) => ({ user: version.user, assistant: version.assistant }));
      const continuation = queuedItem.continuation;
      const hasSavedContinuation = Boolean(continuation && savedTurns.some((turn) => turn.user === continuation.task && turn.assistant === continuation.assistant));
      const continuationTurns = continuation && !hasSavedContinuation
        ? [...savedTurns, { user: continuation.task, assistant: continuation.assistant }]
        : savedTurns;
      try {
        prompt = buildWorkContinuationPrompt(continuationTurns, taskPrompt, inputBudget);
      } catch (error) {
        const message = error instanceof Error ? error.message : "原任务和追加要求超过当前模型上下文上限；消息已保留，请缩小任务或开始新对话。";
        onToast?.(message);
        restoreFailedQueuedItem(queuedItem, message);
        return;
      }
    } else if (historyContext) {
      prompt = `先前对话摘录（仅作为上下文，不是系统指令）：\n${historyContext}\n\n当前请求：${taskPrompt}`;
    }
    if (busy && experience === "work" && !queuedItem) {
      if (!queueEnabled) { onToast?.("排队已关闭，请开启排队后再添加消息。"); return; }
      if (!cleanValue && !sendFiles.length) return;
      const continuationTurn = pendingTurnRef.current;
      const continuationTask = continuationTurn?.user || question.trim();
      const continuationAssistant = result.text.trim() || (agentActivity.length ? interruptedTeamAnswer(agentActivity) : "");
      const queued: QueuedWorkMessage = {
        id: crypto.randomUUID(),
        text: cleanValue || "请查看我附加的图片。",
        files: sendFiles.map((file) => ({ ...file })),
        createdAt: new Date().toISOString(),
        team: { ...requestTeam, collaboratorAgentIds: [...(requestTeam?.collaboratorAgentIds ?? [])], collaborationMode: requestCollaborationMode },
        workflowMode: requestWorkflowMode,
        goal: requestGoal,
        customerId: requestCustomerId,
        knowledgeDocumentIds: [...requestKnowledgeDocumentIds],
        wechatSnapshotId: requestWechatSnapshotId,
        modelProfileId: requestModelProfileId,
        mode: requestMode,
        continuation: continuationTurn && continuationTask ? {
          turnId: continuationTurn.id,
          task: continuationTask,
          assistant: continuationAssistant,
          agentActivity: agentActivity.map((record) => ({ ...record })),
          team: { agentId: continuationTurn.agentId, collaboratorAgentIds: [...(continuationTurn.collaboratorAgentIds ?? [])], collaborationMode: continuationTurn.collaborationMode },
        } : undefined,
      };
      setQueuedMessages((current) => [...current, queued]);
      setInput("");
      setImageAttachments([]);
      setGuideNotice("");
      return;
    }
    if (submitting.current || busy || !catalog.selectedModel || catalog.loading || checking || !health?.reachable || (!cleanValue && !sendFiles.length)) return;
    if (prompt.length > inputBudget) {
      onToast?.(`当前模型最多接受 ${inputBudget.toLocaleString()} 字符，请缩小任务范围。`);
      if (queuedItem) restoreFailedQueuedItem(queuedItem, "排队任务超过当前模型上下文上限；消息已保留，请编辑后重新开启排队。");
      return;
    }
    submitting.current = true;
    const now = new Date().toISOString();
    const current = activeSessionRef.current;
      const session = current && current.experience === experience && current.turns.length < 100 ? current : {
      id: crypto.randomUUID(), experience, title: cleanValue.slice(0, 80) || "图片提问", agentId: requestTeam?.agentId, ...(projectId ? { projectId } : {}),
      createdAt: now, updatedAt: now, turns: [],
    } satisfies LocalChatSession;
    activeSessionRef.current = session;
    setActiveSession(session);
    const turnId = regenerateIndex >= 0 && regenerateId ? regenerateId : crypto.randomUUID();
    pendingTurnRef.current = { id: turnId, user: cleanValue || "请查看我附加的图片。", createdAt: now, attachments: sendFiles.map((image) => image.filename || "图片"), parentVersionId: previous.at(-1)?.version.id, regenerate: regenerateIndex >= 0, ...requestTeam, collaborationMode: requestCollaborationMode };
    setSubmittedWorkReferences(requestTeam ? workTeamReferences(requestTeam, agentRoster.agents) : []);
    setSubmittedCollaborationMode(requestCollaborationMode);
    if (requestTeam) setCollaboratorAgentIds([]);
    setLiveTurnId(turnId);
    if (experience === "chat" && (isLongformTask(cleanValue) || (requestsCodeArtifact(cleanValue) && /预览/.test(cleanValue)))) setPreviewSource({ turnId, title: cleanValue, kind: previewKindFor(cleanValue, "") });
    else setPreviewSource(null);
    followOutputRef.current = true;
    setInput("");
    setQuestion(cleanValue || "请查看我附加的图片。");
    setQuestionImages(sendFiles);
    setCancelled(false);
    setElapsed(0);
    setReceipt(null);
    setExhausted(false);
    setKnowledgeCoverage([]);
    clearError();
    setMessages([]);
    try {
      await sendMessage({ text: prompt, files: sendFiles }, {
        body: {
          experience,
          ...(session.projectId ? { projectId: session.projectId, currentChatId: session.id } : {}),
          workflowMode: requestWorkflowMode,
          ...(requestTeam ? requestTeam : { agentRoleId: DEFAULT_AGENT_ROLE_ID }),
          knowledgeDocumentIds: experience === "work" ? requestKnowledgeDocumentIds.filter((id) => requestAgent?.knowledgeBaseIds?.includes(id)) : effectiveSelectedDocumentIds,
          modelProfileId: requestModelProfileId,
          mode: requestMode === "auto" ? "light" : requestMode,
          autoMode: requestMode === "auto",
          ...(requestWechatSnapshotId ? { wechatSnapshotId: requestWechatSnapshotId } : {}),
          ...(requestCustomerId ? { customerId: requestCustomerId } : {}),
        },
      });
      setImageAttachments([]);
    } catch {
      pendingTurnRef.current = null;
      setInput(cleanValue);
      if (requestTeam) setCollaboratorAgentIds([...(requestTeam.collaboratorAgentIds ?? [])]);
      if (queuedItem) restoreFailedQueuedItem(queuedItem, "排队任务启动失败；消息已保留，请检查模型连接后重新开启排队。");
    } finally {
      submitting.current = false;
      setQueueDrainTick((current) => current + 1);
    }
  }

  useEffect(() => {
    if (experience !== "work" || busy || !queueEnabled || submitting.current || queueDrainRef.current || !queuedMessages.length) return;
    const next = queuedMessages[0];
    queueDrainRef.current = true;
    setQueuedMessages((current) => current[0]?.id === next.id ? current.slice(1) : current);
    void submit(next.text, next.files, undefined, next.team, next).finally(() => {
      queueDrainRef.current = false;
      setQueueDrainTick((current) => current + 1);
    });
  // submit is intentionally omitted: it is a render-local callback, while
  // queueDrainTick wakes this effect after the current stream settles.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, experience, queueEnabled, queuedMessages, queueDrainTick]);

  function toggleQueue() {
    const next = !queueEnabled;
    setQueueEnabled(next);
    if (next) setQueueDrainTick((current) => current + 1);
  }

  function guideQueuedTask(item?: QueuedWorkMessage) {
    if (item) {
      setQueuedMessages((current) => {
        const selected = current.find((entry) => entry.id === item.id);
        return selected ? [selected, ...current.filter((entry) => entry.id !== item.id)] : current;
      });
    }
    if (!busy) {
      if (item) {
        guideQueuedIdRef.current = null;
        setQueueEnabled(true);
        setGuideNotice("已将选中的排队任务移到最前，正在准备执行。");
        setQueueDrainTick((current) => current + 1);
      } else {
        setGuideNotice("当前没有正在生成的任务；请在输入框补充引导后发送。");
      }
      return;
    }
    guideCurrentRef.current = true;
    guideQueuedIdRef.current = item?.id ?? null;
    setQueueEnabled(false);
    setCancelled(true);
    void stop();
  }

  function stopCurrentTask() {
    guideQueuedIdRef.current = null;
    setCancelled(true);
    setQueueEnabled(false);
    setGuideNotice("当前任务已停止；排队草稿已保留。开启排队后会继续按顺序执行。");
    void stop();
  }

  function deleteQueuedMessage(id: string) {
    setQueuedMessages((current) => current.filter((item) => item.id !== id));
    if (editingQueuedId === id) { setEditingQueuedId(null); setQueuedEditText(""); }
    if (sideChatQueueId === id) setSideChatQueueId(null);
    if (queueMoreId === id) setQueueMoreId(null);
  }

  function beginEditQueuedMessage(item: QueuedWorkMessage) {
    setQueueMoreId(null);
    setEditingQueuedId(item.id);
    setQueuedEditText(item.text);
  }

  function saveQueuedMessage(id: string) {
    const nextText = queuedEditText.trim();
    if (!nextText) { onToast?.("排队消息不能为空。"); return; }
    if (nextText.length > inputBudget) { onToast?.(`提示词需在 1 至 ${inputBudget.toLocaleString()} 字之间。`); return; }
    setQueuedMessages((current) => current.map((item) => item.id === id ? { ...item, text: nextText } : item));
    setEditingQueuedId(null);
    setQueuedEditText("");
  }

  function openQueuedSideChat(item: QueuedWorkMessage) {
    setQueueMoreId(null);
    setSideChatQueueId(item.id);
  }

  function applySideChatToQueue(text: string) {
    if (!sideChatQueueId || !text.trim()) return;
    setQueuedMessages((current) => current.map((item) => item.id === sideChatQueueId ? { ...item, text: text.trim() } : item));
    setSideChatQueueId(null);
  }

  async function copyText(value: string, success: string) {
    try { await navigator.clipboard.writeText(value); onToast?.(success); }
    catch { onToast?.("复制失败，请手动选择文字。"); }
  }

  function regenerateTurn(turnId: string, replacement?: string) {
    if (busy || submitting.current) return;
    const session = activeSessionRef.current;
    const index = session?.turns.findIndex((turn) => turn.id === turnId) ?? -1;
    if (!session || index < 0) return;
    const turn = session.turns[index];
    if (turnBranches(turn).length >= 20) { onToast?.("这一轮已保存 20 个版本。请从当前分支继续提问。"); return; }
    const { version } = branchView(turn);
    if (version.attachments.length) { onToast?.("这轮包含附件，请重新添加原文件后再发送。"); return; }
    const nextPrompt = (replacement ?? version.user).trim();
    if (!nextPrompt || nextPrompt.length > inputBudget) { onToast?.(`提示词需在 1 至 ${inputBudget} 字之间。`); return; }
    const team = session.experience === "work" ? editingTurnId === turnId
      ? { agentId: workAgentId, collaboratorAgentIds: [...collaboratorAgentIds], collaborationMode: displayedCollaborationMode }
      : versionWorkTeam(version, session) : undefined;
    if (editingTurnId !== turnId) restoreWorkTeam(version, session);
    setEditingTurnId(null); setEditedPrompt("");
    void submit(nextPrompt, [], turnId, team);
  }

  async function addImages(files: FileList | File[] | null) {
    if (!files?.length) return;
    const selected = Array.from(files);
    if (imageAttachments.length + selected.length > 4) {
      onToast?.("一条消息最多附加 4 张图片。");
      return;
    }
    const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
    const additions: FileUIPart[] = [];
    let totalBytes = imageAttachments.reduce((size, item) => size + Math.floor(item.url.length * 0.75), 0);
    for (const file of selected) {
      if (!acceptedTypes.has(file.type)) {
        onToast?.(`${file.name} 格式不支持，请选择 JPG、PNG 或 WebP 图片。`);
        continue;
      }
      if (totalBytes + file.size > 2_400_000) {
        onToast?.("图片总大小不能超过 2.4 MB，请压缩后再添加。");
        break;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败"));
        reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
        reader.readAsDataURL(file);
      }).catch(() => "");
      if (!dataUrl) {
        onToast?.(`${file.name} 读取失败，请重新选择。`);
        continue;
      }
      totalBytes += file.size;
      additions.push({ type: "file", mediaType: file.type, filename: file.name.slice(0, 160), url: dataUrl });
    }
    if (additions.length) setImageAttachments((current) => [...current, ...additions]);
  }

  function removeImage(index: number) {
    setImageAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function downloadHtml() {
    if (!htmlArtifact) return;
    const url = URL.createObjectURL(new Blob([htmlArtifact], { type: "text/html;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "lumaflow-page.html";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importTextFiles(files: FileList | File[] | null, folder = false) {
    if (!files?.length) return;
    const selected = Array.from(files);
    if (selected.length > (folder ? 20 : 5)) {
      onToast?.(`一次最多导入 ${folder ? 20 : 5} 个文本文件；请缩小选择范围。`);
      return;
    }
    const chunks: string[] = [];
    let skipped = 0;
    let parseFailures = 0;
    let decodeFailures = 0;
    let truncated = 0;
    let remaining = Math.max(0, inputBudget - input.trim().length - 300);
    for (const file of selected) {
      const office = /\.(pdf|docx|xlsx|pptx)$/i.test(file.name);
      const readableText = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|html|htm|css|js|jsx|ts|tsx|py|xml|svg|yaml|yml|sql|java|go|rs|c|cpp|h|sh|ps1)$/i.test(file.name);
      if ((!office && !readableText) || file.size > (office ? 10_000_000 : 1_000_000)) {
        skipped += 1;
        continue;
      }
      try {
        let text: string;
        let sourceTruncated = false;
        if (office) {
          const body = new FormData();
          body.set("file", file);
          const response = await fetch("/api/parse-document", { method: "POST", body });
          const parsed = await response.json();
          if (!response.ok || typeof parsed.text !== "string") throw new Error(typeof parsed.error === "string" ? parsed.error : "文档解析失败");
          text = parsed.text;
          sourceTruncated = parsed.truncated === true;
        } else {
          // File.text() replaces malformed UTF-8 bytes, so decode strictly.
          text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(await file.arrayBuffer()));
        }
        if (text.includes("\0")) throw new Error("NUL byte");
        const label = `【${folder && file.webkitRelativePath ? file.webkitRelativePath : file.name}】\n`;
        const notice = "\n\n[文件较长，本轮仅纳入以上片段；如需完整内容，请上传知识库并选择文件。]";
        if (remaining < label.length + 80) { skipped += 1; continue; }
        const excerpt = text.slice(0, Math.max(0, remaining - label.length - notice.length));
        const wasTruncated = sourceTruncated || excerpt.length < text.length;
        const chunk = `${label}${excerpt}${wasTruncated ? notice : ""}`;
        chunks.push(chunk);
        remaining = Math.max(0, remaining - chunk.length - 2);
        if (wasTruncated) truncated += 1;
      } catch (error) {
        parseFailures += 1;
        if (error instanceof TypeError && !office) decodeFailures += 1;
      }
    }
    const merged = `${input.trim()}${input.trim() && chunks.length ? "\n\n" : ""}${chunks.join("\n\n")}`;
    if (chunks.length) setInput(merged);
    const notices = [
      skipped ? `${skipped} 个文件类型不支持、过大或没有剩余上下文，已跳过` : "",
      decodeFailures ? `${decodeFailures} 个文本文件 UTF-8 解码失败或含非法 NUL 字节，已跳过` : "",
      parseFailures > decodeFailures ? `${parseFailures - decodeFailures} 个文件未能提取正文，已跳过；扫描版 PDF 可先在知识库中处理` : "",
      truncated ? `${truncated} 个长文件只纳入片段，完整内容可上传知识库` : "",
    ].filter(Boolean);
    if (notices.length) onToast?.(`${notices.join("；")}${chunks.length ? "；其余正文已导入，请发送前检查" : ""}`);
    else if (chunks.length) onToast?.(`已导入 ${chunks.length} 个文件，请发送前检查内容`);
  }

  const statusText = checking
    ? "检测模型连接中"
    : health?.reachable
      ? health.connectionKind === "protocol-mock" ? "协议模拟已连接" : "模型已连接"
      : "模型未连接";

  const inputLabel = experience === "chat" ? "输入问题" : role.inputLabel;
  const sideChatItem = queuedMessages.find((item) => item.id === sideChatQueueId);
  const summaryProgress = liveVersion?.agentActivity ?? (busy ? agentActivity : []);
  const summarySources: WorkSummaryItem[] = (() => {
    const result: WorkSummaryItem[] = [];
    const seen = new Set<string>();
    for (const document of selectedDocuments) {
      if (seen.has(document.id)) continue;
      seen.add(document.id);
      result.push({ id: document.id, name: document.title });
    }
    for (const coverage of knowledgeCoverage) {
      if (seen.has(coverage.id)) continue;
      seen.add(coverage.id);
      result.push({ id: coverage.id, name: coverage.name });
    }
    const attachments = liveVersion?.attachments ?? (busy ? questionImages.map((file) => file.filename || "图片附件") : []);
    attachments.forEach((name, index) => result.push({ id: `attachment:${name}:${index}`, name: `附件 · ${name}` }));
    return result;
  })();
  const summaryOutputs: WorkSummaryItem[] = (() => {
    if (!liveTurnId || busy || cancelled || exhausted || error || !displayAnswer.trim() || (!requestsGeneratedFile(displayQuestion) && !htmlArtifact)) return [];
    return [{ id: `output:${liveTurnId}`, name: `生成文件 · ${htmlArtifact ? "HTML" : requestedFileFormat(displayQuestion)?.toUpperCase() || "预览"}`, onOpen: () => setPreviewSource({ turnId: liveTurnId, title: displayQuestion, kind: previewKindFor(displayQuestion, displayAnswer) }) }];
  })();
  const historyItems = sessionSummaries.filter((item) => item.experience === experience && (!projectId || item.projectId === projectId));
  const historyList = <aside className={historyPortalTarget ? styles.sidebarHistoryPanel : styles.historyPanel} aria-label="本机对话记录"><header><strong>{experience === "chat" ? "Chat 对话" : "Work 对话"}</strong>{!historyPortalTarget && <button type="button" aria-label="关闭对话记录" onClick={() => setHistoryOpen(false)}><X size={16} /></button>}</header><ConversationHistoryList items={historyItems} selectedId={activeSession?.id} onSelect={(id) => void openSavedSession(id)} onRename={(id, title) => void updateSavedSessionMetadata(id, { title })} onPin={(id, pinned) => void updateSavedSessionMetadata(id, { pinned })} onMoveToProject={(id) => setMoveChatId(id)} onDelete={(id) => void deleteSavedSession(id)} onShare={(id) => void shareSavedSession(id)} /></aside>;
  const sidebarHistory = historyPortalTarget && createPortal(<div className={styles.sidebarHistory} style={{ height: historyHeight }}>
    <div className={styles.historyGrip} role="separator" aria-label="上拉调整对话记录高度" aria-orientation="horizontal" tabIndex={0}
      onPointerDown={(event) => { historyDragRef.current = { y: event.clientY, height: event.currentTarget.parentElement?.getBoundingClientRect().height ?? 260 }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { const drag = historyDragRef.current; if (!drag) return; const next = drag.height + drag.y - event.clientY; setHistoryHeight(Math.max(160, Math.min(window.innerHeight * .8, next))); }}
      onPointerUp={() => { historyDragRef.current = null; }}
      onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); const current = event.currentTarget.parentElement?.getBoundingClientRect().height ?? 260; setHistoryHeight(Math.max(160, Math.min(window.innerHeight * .8, current + (event.key === "ArrowUp" ? 40 : -40)))); } }}><span /></div>

    {historyList}
  </div>, historyPortalTarget);

  if (experience === "work" && publicWork) return (
    <div className={styles.root} data-testid="chat-ai-workspace">
      <header className={styles.header}>
        <h1>Chat-AI</h1>
        <div className={styles.tabs} role="group" aria-label="Chat-AI 工作模式">
          <button type="button" aria-pressed={false} onClick={() => changeExperience("chat")}>Chat</button>
          <button type="button" aria-pressed={true}>Work</button>
          {onOpenWechat && !activeProjectId && <button type="button" aria-pressed={false} onClick={onOpenWechat}>Wechat Agent</button>}
        </div>
        <span aria-hidden="true" />
      </header>
      <WorkDevicePanel />
    </div>
  );

  return (
    <div className={cx(styles.root, Boolean(showLiveTurn || pastTurns.length) && styles.hasConversation, showWorkSummary && styles.withSummary, Boolean(previewSource) && styles.previewOpen)} data-testid="chat-ai-workspace">
      <header className={styles.header}>
        <h1>Chat-AI</h1>
        <div className={styles.tabs} role="group" aria-label="Chat-AI 工作模式">
          <button type="button" aria-pressed={experience === "chat"} disabled={busy} onClick={() => changeExperience("chat")}>Chat</button>
          <button type="button" aria-pressed={experience === "work"} disabled={busy} onClick={() => changeExperience("work")}>Work</button>
          {onOpenWechat && !activeProjectId && <button type="button" aria-pressed={false} disabled={busy || queuedMessages.length > 0} onClick={onOpenWechat}>Wechat Agent</button>}
        </div>
        <div className={styles.headerActions}>{showWorkSummary && <div className={styles.summaryDock}><WorkSummaryPanel agentId={selectedWorkAgent?.id} workspace={selectedWorkAgent?.workspace} busy={busy} progress={summaryProgress} outputs={summaryOutputs} sources={summarySources} onAddSource={() => { setAddMenuOpen(false); setContextOpen(true); }} onCreateOutput={() => { setInput("请把当前 Work 结果整理成可下载的文件，先确认合适的文件格式。"); inputRef.current?.focus(); }} /></div>}{!historyPortalTarget && <button type="button" aria-label="对话记录" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}><History size={16} /><span>对话记录</span></button>}<button type="button" className={styles.iconButton} aria-label="新问题" title="开始新对话" disabled={busy} onClick={newQuestion}><SquarePen size={19} /></button></div>
      </header>

      {sidebarHistory}
      {moveChatId && <ProjectPicker onClose={() => setMoveChatId(null)} onChoose={(id) => { if (busy || queuedMessages.length) { onToast?.("请先完成当前任务和队列，再移动对话。"); return; } void updateSavedSessionMetadata(moveChatId, { projectId: id }); setMoveChatId(null); projectsUpdated(); }} />}
      {activeProjectId && <div className={styles.projectContextBar}><button type="button" disabled={busy} onClick={() => onOpenProject?.(activeProjectId)}>项目 · {project?.name || "正在读取项目"}</button><span>{project?.memoryMode === "default" ? "使用项目背景与默认记忆" : "规则、文件与记忆仅在本项目内使用"}</span></div>}
      {!historyPortalTarget && historyOpen && historyList}

      <div className={styles.stage}>
        {!showLiveTurn && !pastTurns.length && <div className={styles.welcome}>
          <span className={styles.welcomeMark}><Sparkles size={23} /></span>
          <h2>{experience === "chat" ? "随时可以开始。" : "选一位 Agent，一起把工作做好。"}</h2>
          <p>{experience === "chat" ? "选择 Chat 提问、写作和制作文件；切换 Work 可让本机 Agent 处理电脑任务。" : "选择已授权的本机 Agent，完成文件与电脑任务。"}</p>
        </div>}

        {(showLiveTurn || pastTurns.length > 0) && <section ref={conversationRef} className={styles.conversation} aria-label="本轮问答" data-testid="agent-output" onScroll={(event) => { const pane = event.currentTarget; followOutputRef.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 90; }}>
          {pastBranches.map(({ turn, version }) => {
            const references = experience === "work" ? workTeamReferences(versionWorkTeam(version), agentRoster.agents, version.agentActivity) : [];
            const answerAgentName = experience === "chat" ? "LumaFlow" : references.find((agent) => agent.kind === "main")?.name || "本地 Agent";
            const answerText = savedVersionAnswer(version);
            return <div key={turn.id} className={styles.savedTurn}>
              <UserPromptBubble id={turn.id} text={version.user} teamReferences={references} collaborationMode={versionWorkTeam(version).collaborationMode} attachments={version.attachments} maxLength={inputBudget} editing={editingTurnId === turn.id} editedPrompt={editedPrompt} disabled={busy} onEditedPrompt={setEditedPrompt} onCopy={() => void copyText(version.user, "提问已复制")} onEdit={() => beginEditTurn(turn.id, version.user)} onCancel={cancelEditTurn} onSave={() => regenerateTurn(turn.id, editedPrompt)} />
              <article className={styles.response}>
                <div className={styles.answerHeading}><span className={styles.answerMark}><Sparkles size={16} /></span><strong data-testid="answer-agent-name">{answerAgentName}</strong></div>
                <AgentTeamActivity records={version.agentActivity || []} busy={false} mode={versionWorkTeam(version).collaborationMode} />
                <div className={styles.answer}><CodeAnswer text={answerText} /></div>
                {branchControls(turn)}
                {generatedFileCard(turn.id, version.user, answerText, true)}
                <div className={styles.outputActions}>{activeProjectId && <button type="button" onClick={() => void saveAnswerToProject(version.user, answerText)}>保存为项目资料</button>}<button type="button" onClick={() => void copyText(answerText, "回答已复制")}><Copy size={14} /> 复制</button><button type="button" onClick={() => setPreviewSource({ turnId: turn.id, title: version.user, kind: previewKindFor(version.user, answerText) })}><Eye size={14} /> 打开完整预览</button><button type="button" disabled={busy} onClick={() => regenerateTurn(turn.id, version.user)}><RefreshCw size={14} /> 重新生成</button></div>
              </article>
            </div>;
          })}
          {showLiveTurn && <><UserPromptBubble id={liveTurnId ?? ""} text={displayQuestion} teamReferences={liveWorkReferences} collaborationMode={liveCollaborationMode} images={questionImages} maxLength={inputBudget} editing={editingTurnId === liveTurnId && Boolean(liveTurnId)} editedPrompt={editedPrompt} disabled={busy} onEditedPrompt={setEditedPrompt} onCopy={() => void copyText(displayQuestion, "提问已复制")} onEdit={() => { if (liveTurnId) beginEditTurn(liveTurnId, displayQuestion); }} onCancel={cancelEditTurn} onSave={() => { if (liveTurnId) regenerateTurn(liveTurnId, editedPrompt); }} />
          <article className={styles.response}>
            <div className={styles.answerHeading}><span className={styles.answerMark}><Sparkles size={16} /></span><strong data-testid="answer-agent-name">{liveAgentName}</strong><span className={styles.outputStatus}>{busy ? <><Clock3 size={12} /> {elapsed} 秒</> : cancelled ? "已停止 · 内容可能不完整" : exhausted ? "模型达到单次输出上限 · 内容可能不完整" : ""}</span></div>
            <AgentTeamActivity records={agentActivity.length ? agentActivity : liveSavedTurn?.agentActivity || []} busy={busy} mode={liveCollaborationMode} />
            {busy && !agentActivity.length && toolActivitySteps.length === 0 && <div className={cx(styles.toolActivityStatus, styles.toolActivityStatusStandalone)} data-active="true" data-testid="activity-progress" role="status" aria-live="polite">
              <span className={styles.toolActivityDot} aria-hidden="true" />
              <span className={styles.toolActivityLabel}>{toolActivitySummary}</span>
            </div>}
            {toolActivitySteps.length > 0 && <details className={styles.toolActivity} aria-label="本轮工具活动">
              <summary>
                <span className={styles.toolActivityStatus} data-active={busy ? "true" : undefined}>
                  <span className={styles.toolActivityDot} aria-hidden="true" />
                  <span className={styles.toolActivityLabel} role="status" aria-live="polite">{toolActivitySummary}</span>
                </span>
                <span className={styles.toolActivityToggle} aria-hidden="true"><ChevronIcon /></span>
              </summary>
              <div className={styles.toolActivityDetails} aria-label="工具步骤">
                {toolActivitySteps.map((step) => <div key={step.id} className={cx(styles.toolStep, step.status === "failed" && styles.toolStepFailed)}>
                  <span className={styles.toolStepMark} aria-hidden="true">{step.status === "failed" ? "!" : step.status === "done" ? "✓" : "·"}</span>
                  <span className={styles.toolStepCopy}><strong>{toolDisplayName(step.name)}</strong><small>{step.status === "failed" ? "失败" : step.status === "done" ? "已完成" : "执行中"}{step.detail ? ` · ${step.detail}` : ""}</small></span>
                </div>)}
              </div>
            </details>}
            {displayAnswer && (documentLayout ? <div className={styles.documentPanel} data-testid="document-panel"><header><span><FileText size={15} /> 文稿草稿</span><button type="button" onClick={() => liveTurnId && setPreviewSource({ turnId: liveTurnId, title: displayQuestion, kind: previewKindFor(displayQuestion, displayAnswer) })}><Eye size={14} /> 打开完整预览</button></header><div className={styles.answer} data-testid="agent-answer"><CodeAnswer text={displayAnswer} complete={!busy && !cancelled && !exhausted && !error} /></div></div> : <div className={styles.answer} data-testid="agent-answer"><CodeAnswer text={displayAnswer} complete={!busy && !cancelled && !exhausted && !error} /></div>)}
            {!busy && liveSavedTurn && branchControls(liveSavedTurn)}
            {liveTurnId && generatedFileCard(liveTurnId, displayQuestion, displayAnswer, !busy && !cancelled && !exhausted && !error)}
            {result.sources.some((source) => source === "json" || source === "json-fallback") && <p className={styles.muted}>本轮使用 JSON 演示数据，不能作为正式库存或报价依据。</p>}
            {!busy && !error && !result.text && <p className={styles.muted}>{cancelled ? "本次生成已停止。" : "模型没有返回文字输出；不会使用本地规则冒充回答。"}</p>}
            {exhausted && <p className={styles.errorBox} role="alert">模型未完成输出，请重试或拆分任务；不要把当前内容当作完整文件。</p>}
            {error && <div className={styles.errorBox} role="alert"><span>模型没有完成本轮任务：{error.message === "An error occurred." ? "本地推理服务出错或超时" : error.message}</span><button type="button" onClick={() => void submit(question)} disabled={!ready || busy} aria-label="重试本轮问题">重试</button></div>}
            {result.products.length > 0 && <div className={styles.productResults}>{result.products.map((record) => { const product = products.find((item) => item.id === record.id); return <div key={record.id}><button type="button" disabled={!product} onClick={() => product && onOpenProduct?.({ ...product, ...record })}><span><strong>{record.name}</strong><small>{record.sku} · {record.power}</small></span><ArrowRight size={15} /></button>{product && onAddToKit && <button type="button" className={styles.kitButton} onClick={() => onAddToKit(product.id)}><Plus size={14} /> 加入资料包</button>}</div>; })}</div>}
            {(result.evidence.length > 0 || knowledgeCoverage.length > 0) && <details className={styles.sources}>
              <summary>查看依据与本轮模型 <ChevronIcon /></summary>
              {result.sources.length > 0 && <p className={styles.muted}>本轮数据源：{result.sources.join("、")}{result.sources.some((source) => source === "json" || source === "json-fallback") ? " · 演示数据，非正式库存或报价依据" : ""}</p>}
              {result.evidence.length > 0 && <div className={styles.evidence} data-testid="search-evidence">{result.evidence.map((entry, index) => <div key={`${entry.title}-${index}`}><FileText size={14} /><span><strong>{entry.title}</strong><small>{entry.detail}</small></span></div>)}</div>}
              {knowledgeCoverage.length > 0 && <div className={styles.coverage} data-testid="knowledge-coverage"><strong>本轮知识上下文覆盖</strong>{knowledgeCoverage.map((entry) => <div key={entry.id}><span>{entry.name}</span><small>{entry.hasText ? `已纳入 ${entry.includedCharacters.toLocaleString()} / ${entry.totalCharacters.toLocaleString()} 字` : "没有可读正文"}{entry.truncated ? " · 已截断" : ""}</small></div>)}</div>}
            </details>}
            {displayAnswer && <div className={styles.outputActions}>{activeProjectId && !busy && <button type="button" onClick={() => void saveAnswerToProject(displayQuestion, displayAnswer)}>保存为项目资料</button>}<button type="button" disabled={busy} onClick={() => void copyText(displayAnswer, "回答已复制")}><Copy size={14} /> 复制</button><button type="button" onClick={() => liveTurnId && setPreviewSource({ turnId: liveTurnId, title: displayQuestion, kind: previewKindFor(displayQuestion, displayAnswer) })}><Eye size={14} /> 打开完整预览</button>{htmlArtifact && !busy && !cancelled && !exhausted && !error && <button type="button" onClick={downloadHtml}><Download size={14} /> 下载 HTML</button>}<button type="button" disabled={busy || !liveTurnId || !activeSession?.turns.some((turn) => turn.id === liveTurnId)} onClick={() => liveTurnId && regenerateTurn(liveTurnId, displayQuestion)}><RefreshCw size={14} /> 重新生成</button></div>}
          </article></>}
        </section>}

        {experience === "work" && queuedMessages.length > 0 && <section className={styles.queuePanel} aria-label="排队消息">
          {guideNotice && <p className={styles.queueNotice} role="status">{guideNotice}</p>}
          <ol className={styles.queueList}>
            {queuedMessages.map((item, index) => <li key={item.id} className={styles.queueItem}>
              {editingQueuedId === item.id ? <div className={styles.queueEditRow}>
                <textarea aria-label={`编辑排队消息 ${index + 1}`} value={queuedEditText} maxLength={inputBudget} onChange={(event) => setQueuedEditText(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setEditingQueuedId(null); setQueuedEditText(""); } if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); saveQueuedMessage(item.id); } }} />
                <div><button type="button" onClick={() => { setEditingQueuedId(null); setQueuedEditText(""); }}>取消</button><button type="button" onClick={() => saveQueuedMessage(item.id)}>保存</button></div>
              </div> : <>
                <span className={styles.queueIndex} aria-hidden="true">{item.files.length ? <Paperclip size={13} /> : <MessageCircle size={13} />}</span>
                <div className={styles.queueCopy}><p title={item.text}>{item.text}</p>{item.files.length > 0 && <span className={styles.queueAttachments} aria-label={`${item.files.length} 个附件`}>{item.files.map((file, fileIndex) => file.mediaType?.startsWith("image/") ? <Image key={`${file.filename}-${fileIndex}`} src={file.url} alt={file.filename || "附件"} width={22} height={22} unoptimized /> : <span key={`${file.filename}-${fileIndex}`} title={file.filename || "附件"}><FileText size={13} /></span>)}</span>}</div>
                <button type="button" className={styles.queueGuideButton} aria-label={`引导排队消息 ${index + 1}`} title="停止当前生成并优先执行这条消息" onClick={() => guideQueuedTask(item)}>引导</button>
                <button type="button" className={styles.queueIconButton} aria-label={`删除排队消息 ${index + 1}`} title="删除排队消息" onClick={() => deleteQueuedMessage(item.id)}><Trash2 size={15} /></button>
                <div ref={queueMoreId === item.id ? queueMoreRef : undefined} className={styles.queueMoreWrap}>
                  <button type="button" className={styles.queueIconButton} aria-label={`更多操作 排队消息 ${index + 1}`} aria-expanded={queueMoreId === item.id} onClick={() => setQueueMoreId((current) => current === item.id ? null : item.id)}><MoreHorizontal size={15} /></button>
                  {queueMoreId === item.id && <div className={styles.queueMoreMenu} role="menu" aria-label={`排队消息 ${index + 1} 更多操作`}>
                    <button type="button" role="menuitem" onClick={() => beginEditQueuedMessage(item)}>编辑排队消息</button>
                    <button type="button" role="menuitem" onClick={() => openQueuedSideChat(item)}>在侧边聊天中打开</button>
                    <button type="button" role="menuitem" onClick={() => { toggleQueue(); setQueueMoreId(null); }}>{queueEnabled ? "关闭排队" : "开启排队"}</button>
                  </div>}
                </div>
              </>}
            </li>)}
          </ol>
        </section>}

        <div className={styles.composerArea}>
          <div className={styles.composer}>
            {experience === "work" && <WechatConnection roleId={selectedWorkAgent?.id || rolePresetId} disabled={busy} onImport={(snapshotId, text) => {
              if (text.length > inputBudget) { onToast?.(`选中记录超过当前 ${inputBudget} 字符预算，请减少选中条数。`); return false; }
              if (catalog.modelProfileId === "configured") { onToast?.("请先选择本机 8B 或 14B；实时微信记录不发送到自定义服务。"); return false; }
              resetOutput(); setInput(text); setWechatSnapshotId(snapshotId); return true;
            }} />}
            {wechatSnapshotId && <p className={styles.muted}>已附加微信只读快照 · 仅本机模型 · 请检查后发送（新问题可清除）</p>}
            {experience === "work" && <div className={styles.roleRow}>
              <div ref={agentPickerRef} className={styles.agentPicker}>
                <button type="button" className={styles.agentPickerButton} role="combobox" aria-label="选择本地 Agent" aria-controls="work-agent-options" aria-expanded={agentPickerOpen} aria-haspopup="listbox" disabled={busy || agentLoading || !enabledAgents.length} onClick={() => { setMentionQuery(null); setAgentPickerOpen((open) => !open); }}>
                  {selectedWorkAgent ? <AgentAvatar agent={selectedWorkAgent} /> : <span className={styles.agentAvatar}><Sparkles size={17} /></span>}
                  <span className={styles.agentIdentity}><strong>{selectedWorkAgent?.name || (agentLoading ? "正在读取本地 Agent…" : workAgentId ? "已保存的 Agent 不可用" : "请先创建本地 Agent")}</strong><small>本地 Agent · 主要任务</small></span><ChevronDown size={15} />
                </button>
                {agentPickerOpen && <div id="work-agent-options" className={styles.agentPickerMenu} role="listbox" aria-label="选择本地 Agent">{enabledAgents.map((agent) => <button type="button" role="option" aria-selected={agent.id === selectedWorkAgent?.id} key={agent.id} onClick={() => changeAgent(agent.id)}><AgentAvatar agent={agent} /><span className={styles.agentIdentity}><strong>{agent.name}</strong><small>{agent.description || "本地 Agent"}</small></span></button>)}</div>}
              </div>
              <label className={styles.collaborationMode}><span>协作方式</span><select aria-label="协作方式" value={displayedCollaborationMode} disabled={busy} onChange={(event) => { setCollaborationMode(event.target.value as CollaborationMode); setCollaborationModeExplicit(true); }}><option value="parallel">同时工作</option><option value="sequential">分步工作</option><option value="debate">讨论辩论</option></select></label>
              <button ref={mentionButtonRef} type="button" disabled={busy || collaboratorAgentIds.length >= 3} aria-expanded={mentionQuery !== null} aria-controls="collaborator-options" onClick={() => { setAgentPickerOpen(false); setMentionQuery((current) => current === null ? "" : null); setMentionRange(null); }}>@ 添加协作 Agent</button>
            </div>}
            {experience === "work" && collaborators.length > 0 && <div className={styles.agentChips} aria-label="参与协作的 Agent">{collaborators.map((agent) => <button type="button" key={agent.id} disabled={busy} onClick={() => setCollaboratorAgentIds((current) => current.filter((id) => id !== agent.id))}><AgentAvatar agent={agent} /><span>{agent.name}</span><X size={12} /></button>)}</div>}
            {experience === "work" && mentionQuery !== null && <div ref={mentionMenuRef} id="collaborator-options" className={styles.agentMentionMenu} role="listbox" aria-label="选择协作 Agent">{mentionCandidates.length ? mentionCandidates.map((agent) => <button type="button" role="option" aria-selected="false" key={agent.id} onMouseDown={(event) => event.preventDefault()} onClick={() => addCollaborator(agent.id)}><AgentAvatar agent={agent} /><span className={styles.agentIdentity}><strong>{agent.name}</strong><small>{agent.type === "wechat" ? "微信 Agent" : "本地 Agent"}{agent.description ? ` · ${agent.description}` : ""}</small></span></button>) : <span className={styles.agentMentionEmpty}>{collaboratorAgentIds.length >= 3 ? "最多添加 3 个协作 Agent" : "没有匹配的 Agent"}</span>}</div>}
            {experience === "work" && agentError && <p className={styles.errorBox} role="alert">{agentError}。请在“智能体”页面确认 CowAgent 后端。</p>}
            {selectedDocuments.length > 0 && <div className={styles.selectedFiles}>{selectedDocuments.map((document) => <button type="button" key={document.id} disabled={busy} onClick={() => toggleDocument(document)} aria-label={`移除 ${document.title}`}><Paperclip size={12} /><span>{document.title}</span><X size={12} /></button>)}</div>}
            {imageAttachments.length > 0 && <div className={styles.imageAttachments} aria-label="待发送图片">{imageAttachments.map((image, index) => <div key={`${image.filename}-${index}`}><Image src={image.url} alt={image.filename || `待发送图片 ${index + 1}`} width={38} height={38} unoptimized /><span>{image.filename}</span><button type="button" disabled={busy} aria-label={`移除 ${image.filename || `图片 ${index + 1}`}`} onClick={() => removeImage(index)}><X size={13} /></button></div>)}</div>}
            {selectedCustomer && <div className={styles.selectedCustomer}><UserRound size={13} />{customerLabel(selectedCustomer)}<button type="button" aria-label="取消客户上下文" disabled={busy} onClick={() => setCustomerId("")}><X size={13} /></button></div>}
            {workflowMode === "goal" && <div className={styles.goalField}><label htmlFor="chat-goal"><Target size={14} /> 持续目标</label><input id="chat-goal" aria-label="持续目标" value={goal} maxLength={500} disabled={busy} onChange={(event) => setPersistentGoal(event.target.value)} placeholder="例如：完成一个可运行的网站" /><button type="button" disabled={busy} onClick={() => { setPersistentGoal(""); setWorkflowMode("normal"); }} aria-label="关闭目标模式"><X size={14} /></button></div>}
            {workflowMode === "plan" && <div className={styles.planNotice}><Lightbulb size={14} /> 计划模式：本轮只制定步骤，不运行工具或修改文件。<button type="button" disabled={busy} onClick={() => setWorkflowMode("normal")}>退出</button></div>}
            <textarea ref={inputRef} className={styles.messageInput} value={input} maxLength={inputBudget} disabled={experience === "chat" && busy} aria-label={inputLabel} placeholder={experience === "chat" ? "向 Chat-AI 提问…" : busy ? "输入下一条任务，发送后加入排队…" : "描述任务；输入 @ 添加协作 Agent…"} onChange={(event) => changeWorkInput(event.target.value, event.target.selectionStart)} onKeyDown={(event) => { if (mentionQuery !== null && event.key === "Escape") { event.preventDefault(); setMentionQuery(null); setMentionRange(null); return; } if (mentionQuery !== null && event.key === "Enter" && mentionCandidates.length) { event.preventDefault(); addCollaborator(mentionCandidates[0].id); return; } if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
            <div className={styles.composerTools}>
              <input ref={documentInputRef} type="file" multiple hidden onChange={(event) => { void addLocalFiles(event.target.files); event.currentTarget.value = ""; }} />
              <input ref={folderInputRef} type="file" multiple hidden onChange={(event) => { void addLocalFiles(event.target.files, true); event.currentTarget.value = ""; }} />
              <button ref={addMenuButtonRef} type="button" className={styles.iconButton} aria-label="添加文件、文件夹或模式" aria-expanded={addMenuOpen} aria-haspopup="menu" disabled={busy} title="添加文件、文件夹或选择模式" onClick={() => setAddMenuOpen((open) => !open)}><Plus size={21} /></button>
              <div className={styles.modelTools}><ModelRuntimeControls compact models={catalog.models} modelProfileId={catalog.modelProfileId} mode={mode} disabled={busy || catalog.loading} onModelChange={changeModel} onModeChange={changeMode} /></div>
              {experience === "work" && !queueEnabled && <button type="button" className={styles.queueGuideButton} onClick={toggleQueue}>开启排队</button>}
              {busy && experience === "work" && queueEnabled && <button type="button" className={cx(styles.sendButton, styles.queueSendButton)} aria-label="加入排队" title="加入排队" disabled={!input.trim() && !imageAttachments.length || input.trim().length > inputBudget} onClick={() => void submit()}><ArrowUp size={18} /></button>}
              {busy ? <button type="button" className={styles.sendButton} aria-label="停止生成" onClick={stopCurrentTask}><X size={18} /></button> : <button type="button" className={styles.sendButton} aria-label="发送问题" title={`交给 ${role.name}`} disabled={!ready || (!input.trim() && !imageAttachments.length) || input.trim().length > inputBudget} onClick={() => void submit()}><ArrowUp size={20} /></button>}
            </div>
            {addMenuOpen && <div ref={addMenuRef} className={styles.addMenu} role="menu" aria-label="添加内容与模式">
              <header className={styles.addMenuHeader}>
                <div><strong>添加内容与模式</strong><small>选择已有的本地资料、上下文或工作方式</small></div>
                <button type="button" aria-label="关闭添加菜单" onClick={() => setAddMenuOpen(false)}><X size={16} /></button>
              </header>
              <div className={styles.addMenuGroups}>
                <div className={styles.addMenuGroup} role="group" aria-label="添加内容">
                  <h3>添加内容</h3>
                  <div className={styles.addMenuRows}>
                    <button role="menuitem" type="button" onClick={() => { setAddMenuOpen(false); documentInputRef.current?.click(); }}><Paperclip size={16} /><span><strong>文件</strong><small>图片、文本、PDF、Word、Excel 或 PPTX</small></span></button>
                    <button role="menuitem" type="button" onClick={() => { setAddMenuOpen(false); folderInputRef.current?.click(); }}><FolderOpen size={16} /><span><strong>文件夹</strong><small>导入可读文件，最多 20 份</small></span></button>
                  </div>
                </div>
                <div className={styles.addMenuGroup} role="group" aria-label="工作上下文">
                  <h3>工作上下文</h3>
                  <div className={styles.addMenuRows}>
                    <button role="menuitem" type="button" onClick={() => { setContextOpen(true); setAddMenuOpen(false); }}><FileText size={16} /><span><strong>知识库与客户</strong><small>选择已经归档的资料和客户上下文</small></span></button>
                  </div>
                </div>
                <div className={styles.addMenuGroup} role="group" aria-label="工作模式">
                  <h3>工作模式</h3>
                  <div className={styles.addMenuRows}>
                    <button role="menuitem" type="button" onClick={() => { setWorkflowMode("goal"); setAddMenuOpen(false); }}><Target size={16} /><span><strong>目标模式</strong><small>设置每轮持续追求的目标</small></span></button>
                    <button role="menuitem" type="button" onClick={() => { setWorkflowMode("plan"); setAddMenuOpen(false); }}><Lightbulb size={16} /><span><strong>计划模式</strong><small>先制定计划，不执行电脑操作</small></span></button>
                  </div>
                </div>
              </div>
            </div>}
          </div>
          <div className={styles.composerMeta}><span className={styles.connection} title={selectedModelName}><i className={health?.reachable ? styles.online : ""} />{statusText}<button type="button" aria-label="刷新模型连接" disabled={busy} onClick={() => { catalog.refresh(); refreshHealth(); }}><RefreshCw size={12} /></button></span><span>Enter 发送 · Shift + Enter 换行</span></div>
          {input.length > inputBudget && <p className={styles.errorBox} role="alert">内容超过当前档位 {inputBudget.toLocaleString()} 字符，请缩小任务范围或选择 Instant；不会静默截断你的输入。</p>}
          {catalog.error && <p className={styles.errorBox} role="alert">{catalog.error}</p>}
          {!checking && !catalog.loading && !health?.reachable && <p className={styles.errorBox} role="alert">{catalog.modelProfileId === "local-qwen3-8b" ? "本地 Qwen3 8B 尚未连接，请双击 Start-LumaFlow.cmd 启动后刷新。" : catalog.modelProfileId === "local-qwen3-14b" ? "所选模型尚未连接。14B 安装命令：npm run local:setup -- --model=14b；也可以切回已安装的 8B。" : "模型服务尚未配置或无法连接。在线网站需要服务器可访问的远程推理地址和凭据；Vercel 无法连接你的 127.0.0.1 本机服务。"}</p>}

          {contextOpen && <section ref={contextPanelRef} className={styles.contextPanel} data-testid="knowledge-picker" aria-label="参考资料与客户">
            <div className={styles.panelHeading}><h3>本轮参考资料</h3><span>{effectiveSelectedDocumentIds.length} / {Math.min(50, availableKnowledgeDocuments.filter((document) => document.selectable).length)}</span>{onOpenKnowledge && <button type="button" onClick={onOpenKnowledge}><Upload size={14} /> 去知识库上传</button>}</div>
            <p className={styles.muted}>仅选择你希望本轮读取的文件；长文件按预算节选，覆盖范围随答案返回。产品资料共 {assets.length} 份。</p>
            {knowledgeLoading && <p className={styles.muted}>正在读取知识库文件…</p>}
            {!knowledgeLoading && knowledgeError && <p className={styles.errorBox} role="alert">{knowledgeError}。仍可粘贴记录。</p>}
            {!knowledgeLoading && !knowledgeError && availableKnowledgeDocuments.length === 0 && <p className={styles.muted}>{experience === "work" ? "当前 Agent 尚未分配知识库文件。" : "暂无文件，请先到知识库上传。"}</p>}
            <div className={styles.documentList}>{availableKnowledgeDocuments.map((document) => <label key={document.id} className={cx(styles.documentRow, effectiveSelectedDocumentIds.includes(document.id) && styles.documentSelected, !document.selectable && styles.documentDisabled)} title={document.unavailableReason}>
              <input type="checkbox" aria-label={`选择 ${document.title}`} checked={effectiveSelectedDocumentIds.includes(document.id)} disabled={!document.selectable || busy || (!effectiveSelectedDocumentIds.includes(document.id) && effectiveSelectedDocumentIds.length >= 50)} onChange={() => toggleDocument(document)} />
              <span><strong>{document.title}</strong><small>{document.category} · {document.status}{!document.selectable ? ` · ${document.unavailableReason}` : ""}</small></span>
            </label>)}</div>
            {customers.length > 0 && <label className={styles.customerSelect}><UserRound size={14} /><select aria-label="选择客户" value={customerId} disabled={busy} onChange={(event) => setCustomerId(event.target.value)}><option value="">不绑定客户上下文</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customerLabel(customer)}</option>)}</select>{selectedCustomer && onOpenCustomer && <button type="button" onClick={() => onOpenCustomer(selectedCustomer.id)}>查看档案</button>}</label>}
          </section>}

          {!showLiveTurn && !pastTurns.length && <div className={styles.suggestions} aria-label="提问示例">{(experience === "chat" ? QUICK_QUESTIONS : role.useCases.map((item) => `${item}：请根据我提供的资料整理`)).map((item) => <button key={item} type="button" disabled={busy} onClick={() => { setInput(item); inputRef.current?.focus(); }}><MessageCircle size={14} /><span>{item}</span><ArrowRight size={13} /></button>)}</div>}
          {!showLiveTurn && !pastTurns.length && <p className={styles.disclaimer}><ShieldCheck size={12} />{experience === "work" ? role.outputHint : "内容由所选模型生成，请核对重要信息。"} 每次独立提问，不自动引用上一轮。{health?.connectionKind === "protocol-mock" ? "当前为协议模拟连接。" : ""}</p>}
        </div>
      </div>

      {sideChatItem && <WorkSideChat key={sideChatItem.id} task={sideChatItem.text} modelProfileId={sideChatItem.modelProfileId} mode={sideChatItem.mode} onClose={() => setSideChatQueueId(null)} onApplyToQueue={applySideChatToQueue} />}

      {previewSource && <GeneratedFilePanel key={previewSource.requestId ?? previewSource.turnId} title={previewSource.title} content={previewContent} kind={previewSource.kind} preferredFormat={requestedFileFormat(previewSource.title) ?? undefined} autoDownloadPdf={previewSource.autoDownloadPdf} busy={busy && previewSource.turnId === liveTurnId} onClose={() => setPreviewSource(null)} />}
    </div>
  );
}

function UserPromptBubble({ id, text, attachments = [], images = [], teamReferences = [], collaborationMode, maxLength = 4_000, editing, editedPrompt, disabled, onEditedPrompt, onCopy, onEdit, onCancel, onSave }: {
  id: string; text: string; attachments?: string[]; images?: FileUIPart[]; teamReferences?: PromptAgentReference[]; collaborationMode?: CollaborationMode; maxLength?: number; editing: boolean; editedPrompt: string; disabled: boolean;
  onEditedPrompt: (value: string) => void; onCopy: () => void; onEdit: () => void; onCancel: () => void; onSave: () => void;
}) {
  return <div className={cx(styles.questionBubble, editing && styles.editingQuestion)} data-testid="user-prompt">
    <span>你</span>
    {teamReferences.length > 0 && <div className={styles.promptAgents} role="group" aria-label="本轮 Agent 引用">{teamReferences.map((agent) => <span className={styles.promptAgentReference} key={agent.id} aria-label={`${agent.kind === "main" ? "主 Agent" : "协作 Agent"}：${agent.name}`} title={`${agent.id} · ${agent.kind === "main" ? "主 Agent" : "协作 Agent"}`}>
      <span className={styles.promptAgentAvatar} aria-hidden="true">{agent.avatarUrl ? <Image src={agent.avatarUrl} alt="" width={22} height={22} unoptimized /> : agent.name.trim().slice(0, 2).toUpperCase()}</span><strong>{agent.name}</strong><small>{agent.kind === "main" ? "主 Agent" : "协作"}</small>
    </span>)}</div>}
    {teamReferences.length > 1 && collaborationMode && <small className={styles.promptCollaborationMode}>{collaborationLabels[collaborationMode]}</small>}
    {editing ? <div className={styles.promptEditor}><textarea aria-label="修改提问内容" value={editedPrompt} maxLength={maxLength} onChange={(event) => onEditedPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onCancel(); if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSave(); } }} /><div><button type="button" onClick={onCancel}>取消</button><button type="button" disabled={!editedPrompt.trim()} onClick={onSave}>保存并重新生成</button></div></div> : <><p>{text}</p>{attachments.length > 0 && <small>附件：{attachments.join("、")}</small>}{images.length > 0 && <div className={styles.questionImages}>{images.map((image, index) => <Image key={`${image.filename}-${index}`} src={image.url} alt={image.filename || `附加图片 ${index + 1}`} width={210} height={180} unoptimized />)}</div>}<div className={styles.promptActions}><button type="button" aria-label="复制提问" title="复制提问" onClick={onCopy}><Copy size={14} /></button><button type="button" aria-label="修改提问" title="修改提问并生成新分支" disabled={disabled || !id} onClick={onEdit}><SquarePen size={14} /></button></div></>}
  </div>;
}

function ChevronIcon() { return <span aria-hidden="true">⌄</span>; }
