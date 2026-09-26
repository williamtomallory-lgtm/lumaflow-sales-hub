"use client";

/* eslint-disable @next/next/no-img-element -- Local authenticated Agent avatars and QR images. */
import { MessageCircle, Plus, RefreshCw, Settings, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  wechatAgentStateSchema, wechatAgentConfigPatchSchema, wechatConversationPageSchema, wechatMessagePageSchema,
  type WechatAgentState, type WechatAgentConfig, type WechatAgentAction, type WechatConversation, type WechatMessage, type WechatMessagePage,
} from "@/lib/contracts/wechat-conversation";
import { WorkspaceFolderField } from "./workspace-folder-field";
import { AgentKnowledgePicker } from "./agent-knowledge-picker";
import styles from "./wechat-agent-workspace.module.css";
import { ConversationHistoryList, type ConversationHistoryItem } from "./conversation-history-list";

const endpoint = "/api/v1/wechat-agent";
const connectionLabels = { connected: "已连接", waiting: "等待连接", disconnected: "未连接" };
const WECHAT_AGENT_DISPLAY_NAME = "WeixinClawBot";
const configSavedMessage = "Agent设置已保存";
const permissionModes = [
  { id: "request", label: "请求批准", summary: "读取、创建和修改都需要确认。", permissions: { read: "confirm", create: "confirm", modify: "confirm", tools: "confirm", delete: "confirm", send: "confirm", moments: "confirm" } },
  { id: "assist", label: "帮我批准", summary: "读取、创建和工作目录内工具自动执行，修改需要确认。", permissions: { read: "auto", create: "auto", modify: "confirm", tools: "auto", delete: "confirm", send: "auto", moments: "confirm" } },
  { id: "collaborate", label: "自动执行", summary: "已授权任务直接执行，文件、工具和微信操作无需重复确认。", permissions: { read: "auto", create: "auto", modify: "auto", tools: "auto", delete: "auto", send: "auto", moments: "auto" } },
] as const;
type WechatPermissionMode = (typeof permissionModes)[number]["id"];

function permissionModeFor(permissions: WechatAgentConfig["permissions"]): WechatPermissionMode {
  const match = permissionModes.find((mode) => (["read", "create", "modify"] as const).every((key) => permissions[key] === mode.permissions[key]));
  return match?.id || "request";
}

/**
 * Only hand a real image source to the QR img element. A malformed backend
 * value must stay visible as an error instead of looking like a valid QR.
 */
function imageSource(value?: string) {
  const candidate = value?.trim();
  if (!candidate || candidate === "image") return "";
  if (candidate.startsWith("data:")) return candidate.startsWith("data:image/") ? candidate : "";
  if (candidate.startsWith("blob:")) return candidate;
  if (candidate.startsWith("/") || candidate.startsWith("./") || candidate.startsWith("../")) return candidate;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? candidate : "";
  } catch {
    return "";
  }
}

function retryImageSource(source: string, attempt: number) {
  if (!attempt || source.startsWith("data:") || source.startsWith("blob:")) return source;
  const hashIndex = source.indexOf("#");
  const beforeHash = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  const hash = hashIndex >= 0 ? source.slice(hashIndex) : "";
  return `${beforeHash}${beforeHash.includes("?") ? "&" : "?"}lumaflow_retry=${attempt}${hash}`;
}

async function request<T>(url: string, schema: { parse: (value: unknown) => T }, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { Accept: "application/json", ...init?.headers } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || "微信 Agent 服务暂不可用");
  try { return schema.parse(payload?.data); }
  catch { throw new Error("微信 Agent 服务返回的数据不完整，请刷新后重试。"); }
}

function notifyUpdated() { window.dispatchEvent(new CustomEvent("lumaflow-wechat-agent-updated")); }

function useWechatAgentState() {
  const [state, setState] = useState<WechatAgentState | null>(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState(false);
  const epoch = useRef(0);
  const mutationInFlight = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const requestedEpoch = epoch.current;
    try {
      const next = await request(endpoint, wechatAgentStateSchema, { signal });
      if (!signal?.aborted && requestedEpoch === epoch.current && !mutationInFlight.current) { setState(next); setError(""); }
      return next;
    } catch (issue) {
      if (!signal?.aborted && requestedEpoch === epoch.current && !mutationInFlight.current) setError(issue instanceof Error ? issue.message : "无法读取微信 Agent");
      return null;
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(controller.signal); if (!controller.signal.aborted) timer = setTimeout(poll, 4_000); };
    void poll();
    const onUpdate = () => { epoch.current += 1; void refresh(controller.signal); };
    window.addEventListener("lumaflow-wechat-agent-updated", onUpdate);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener("lumaflow-wechat-agent-updated", onUpdate); };
  }, [refresh]);
  const action = useCallback(async (body: WechatAgentAction) => {
    epoch.current += 1; mutationInFlight.current = true;
    setActing(true); setError("");
    try {
      const next = await request(endpoint, wechatAgentStateSchema, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setState(next); return next;
    } catch (issue) { setError(issue instanceof Error ? issue.message : "操作失败"); return null; }
    finally { mutationInFlight.current = false; setActing(false); }
  }, []);
  return { state, error, acting, refresh, action, setState };
}

function ClawBotAvatar() {
  return <span className={styles.clawBotAvatar}><img src="/wechat-clawbot.svg" alt="WeixinClawBot 头像" /></span>;
}

function ConnectionStatus({ state }: { state: WechatAgentState }) {
  return <span className={styles.status} data-connected={state.connection.status === "connected"}><i />{connectionLabels[state.connection.status]}</span>;
}

function QrCode({ source, onRetry }: { source: string; onRetry: () => void }) {
  const [failedSource, setFailedSource] = useState("");
  const [retry, setRetry] = useState<{ source: string; attempt: number }>({ source, attempt: 0 });
  const failed = failedSource === source;
  const attempt = retry.source === source ? retry.attempt : 0;
  const renderedSource = retryImageSource(source, attempt);
  if (failed) return <div className={styles.qrError} role="alert"><p>二维码图片加载失败，当前没有可扫描的二维码。</p><button type="button" className={styles.secondary} onClick={() => { setFailedSource(""); setRetry({ source, attempt: attempt + 1 }); onRetry(); }}>重试二维码</button></div>;
  return <div className={styles.qr}><img src={renderedSource} alt="微信连接二维码" onError={() => setFailedSource(source)} /><p className={styles.muted}>仅显示本机连接服务返回的真实二维码；扫描后以服务返回的连接状态为准。</p></div>;
}

function ConnectionGuide({ state, acting, onConnect, onRefresh }: { state: WechatAgentState; acting: boolean; onConnect: () => void; onRefresh: () => void }) {
  const rawQr = state.connection.qrCodeDataUrl || state.connection.qrCodeUrl || "";
  const qr = imageSource(rawQr);
  const waiting = state.connection.status === "waiting";
  return <section className={styles.connectionGuide} aria-label="微信连接引导">
    <h3>{waiting ? "等待连接" : "连接微信"}</h3>
    <p>用手机微信扫码并确认，页面会显示实际连接状态。</p>
    {waiting && qr ? <QrCode source={qr} onRetry={onRefresh} /> : waiting ? <div className={styles.qrError} role="alert"><p>{rawQr ? "二维码地址无效，暂时无法显示可扫描二维码。" : "还没有收到可扫描二维码。"}</p><button type="button" className={styles.secondary} onClick={onRefresh}>重试读取二维码</button></div> : <p className={styles.muted}>点击“连接微信”生成二维码。</p>}
    <details className={styles.setupDetails}><summary>首次使用？查看设置</summary><p>点击本页连接微信；手机微信扫码并按提示启用微信ClawBot；回到本页自动完成连接。</p></details>
    <div className={styles.guideActions}><button type="button" className={styles.primary} disabled={acting} onClick={onConnect}><MessageCircle size={14} />{waiting ? "重新生成二维码" : "连接微信"}</button></div>
  </section>;
}

export function WechatAgentCard({ onWork, onToast }: { onWork?: () => void; onToast?: (message: string) => void }) {
  const { state, error, acting, refresh, action, setState } = useWechatAgentState();
  const [configOpen, setConfigOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  useEffect(() => {
    if (!disconnectOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !acting) setDisconnectOpen(false); };
    document.addEventListener("keydown", close); return () => document.removeEventListener("keydown", close);
  }, [disconnectOpen, acting]);
  if (!state) return <section className={styles.card} aria-label="我的微信 Agent">{error ? <p className={styles.error} role="alert">{error}</p> : <p className={styles.empty}>正在读取微信 Agent…</p>}<button type="button" className={styles.secondary} onClick={() => void refresh()}><RefreshCw size={14} /> 重新读取</button></section>;
  const active = state.conversations.items.find((item) => item.id === state.currentConversationId);
  const connected = state.connection.status === "connected";
  return <section className={styles.card} aria-label="我的微信 Agent">
    <div className={styles.cardHeading}><ClawBotAvatar /><div><h3>{WECHAT_AGENT_DISPLAY_NAME}</h3><p>本产品微信 Agent</p></div><ConnectionStatus state={state} /></div>
    {(error || state.connection.error) && <p className={styles.error} role="alert">{error || state.connection.error}</p>}
    {connected ? <>
      <dl className={styles.fields}><div><dt>连接状态</dt><dd>{connectionLabels[state.connection.status]}{state.connection.accountName ? ` · ${state.connection.accountName}` : ""}</dd></div><div><dt>当前会话</dt><dd>{active?.title || (state.currentConversationId ? "当前微信工作会话" : "尚未开始对话")}</dd></div><div><dt>消息同步</dt><dd>{state.agent.syncEnabled ? "同步已开启" : "同步已关闭"}</dd></div><div><dt>消息接收</dt><dd>{state.agent.receiveEnabled ? "已开启" : "已关闭"}{state.agent.dndEnabled ? " · 免打扰" : ""}</dd></div></dl>
      <div className={styles.cardActions} role="group" aria-label="微信 Agent 操作"><button type="button" className={styles.primary} onClick={onWork} disabled={!onWork}>开始工作</button><button type="button" className={styles.secondary} onClick={() => setConfigOpen(true)}><Settings size={14} /> 配置</button><button type="button" className={styles.danger} disabled={acting} onClick={() => setDisconnectOpen(true)}>解绑微信</button><button type="button" className={styles.icon} aria-label="刷新微信状态" onClick={() => void refresh()}><RefreshCw size={14} /></button></div>
      <div className={styles.activity}><h4>最近活动</h4>{state.recentActivity.length ? <ul>{state.recentActivity.map((entry, index) => <li key={`${entry.createdAt}-${index}`}>{entry.text} <small className={styles.muted}>{new Date(entry.createdAt).toLocaleTimeString("zh-CN")}</small></li>)}</ul> : <p>暂无已记录的活动。</p>}</div>
      {disconnectOpen && <div className={styles.modal} role="dialog" aria-modal="true" aria-label="解绑微信确认"><section className={styles.config}><div className={styles.configBody}><h3>解绑微信</h3><p className={styles.muted}>停止当前微信连接。已有工作会话和消息记录会保留。</p></div><footer className={styles.configFooter}><button type="button" className={styles.secondary} onClick={() => setDisconnectOpen(false)}>取消</button><button type="button" className={styles.danger} disabled={acting} onClick={async () => { if (await action({ action: "disconnect" })) { setDisconnectOpen(false); onToast?.("微信已解绑，历史记录已保留"); } }}>确认解绑</button></footer></section></div>}
      {configOpen && <WechatConfigDialog agent={state.agent} onClose={() => setConfigOpen(false)} onSaved={(next) => { setState(next); setConfigOpen(false); onToast?.(configSavedMessage); }} />}
    </> : <ConnectionGuide state={state} acting={acting} onConnect={() => void action({ action: "connect" })} onRefresh={() => void refresh()} />}
  </section>;
}

function WechatConfigDialog({ agent, onClose, onSaved }: { agent: WechatAgentConfig; onClose: () => void; onSaved: (next: WechatAgentState) => void }) {
  const [config, setConfig] = useState(agent);
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onClose(); };
    document.addEventListener("keydown", close); return () => document.removeEventListener("keydown", close);
  }, [onClose, saving]);
  async function save() {
    if (knowledgeBusy) return;
    setSaving(true); setError("");
    try {
      const { id: _id, avatarUrl: _avatarUrl, name: _name, ...fields } = config;
      void _id; void _avatarUrl; void _name;
      const body = wechatAgentConfigPatchSchema.parse({ ...fields, permissions: { ...permissionModes.find((mode) => mode.id === permissionModeFor(config.permissions))!.permissions } });
      const next = await request(endpoint, wechatAgentStateSchema, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      notifyUpdated(); onSaved(next);
    } catch (issue) { setError(issue instanceof Error ? issue.message : "配置保存失败"); }
    finally { setSaving(false); }
  }
  return <div className={styles.modal} role="dialog" aria-modal="true" aria-label="配置微信 Agent" onPointerDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}><section className={styles.config}>
    <header className={styles.configHeader}><h3>配置微信 Agent</h3><button type="button" className={styles.icon} aria-label="关闭微信配置" disabled={saving} onClick={onClose}><X size={17} /></button></header>
    <div className={styles.configBody}><p className={styles.boundary}>WeixinClawBot 的名称和头像由微信连接固定显示。</p>
      <label className={styles.field}>任务与回答方式<textarea aria-label="微信 Agent Prompt" value={config.systemPrompt} maxLength={12_000} onChange={(event) => setConfig({ ...config, systemPrompt: event.target.value })} /></label>
      <AgentKnowledgePicker value={config.knowledgeBaseIds} onChange={(ids) => setConfig((old) => ({ ...old, knowledgeBaseIds: ids }))} disabled={saving} onBusyChange={setKnowledgeBusy} />
      <WorkspaceFolderField inputLabel="微信 Agent 工作间" value={config.workspace} onChange={(workspace) => setConfig((old) => ({ ...old, workspace }))} disabled={saving} />
      {(["syncEnabled", "receiveEnabled", "dndEnabled"] as const).map((key) => <label className={styles.toggle} key={key}><input type="checkbox" checked={config[key]} onChange={(event) => setConfig({ ...config, [key]: event.target.checked })} />{{ syncEnabled: "同步微信消息", receiveEnabled: "接收微信消息", dndEnabled: "免打扰" }[key]}</label>)}
      <fieldset className={styles.permissions}><legend>操作权限</legend><p className={styles.permissionNote}>权限在后台生效。选择“自动执行”后，已授权任务直接执行，不再弹出逐项确认；普通回复会自动同步微信。</p><div className={styles.permissionModes}>{permissionModes.map((mode) => <label className={styles.permissionMode} key={mode.id}><input type="radio" name="wechat-permission-mode" value={mode.id} checked={permissionModeFor(config.permissions) === mode.id} onChange={() => setConfig({ ...config, permissions: { ...config.permissions, ...mode.permissions } })} /><span><strong>{mode.label}</strong><small>{mode.summary}</small></span></label>)}</div></fieldset>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div><footer className={styles.configFooter}><button type="button" className={styles.secondary} disabled={saving} onClick={onClose}>取消</button><button type="button" className={styles.primary} disabled={saving || knowledgeBusy} onClick={() => void save()}>{saving ? "正在保存…" : "确定"}</button></footer>
  </section></div>;
}

function mergeItems<T extends { id: string }>(old: T[], next: T[]): T[] { return [...new Map([...old, ...next].map((item) => [item.id, item])).values()]; }

export type WechatAgentWorkspaceProps = {
  onBack?: () => void;
  onToast?: (message: string) => void;
  historyPortalTarget?: HTMLElement | null;
  onExperienceChange?: (next: "chat" | "work") => void;
};

function ExperienceTabs({ onChange }: { onChange?: (next: "chat" | "work") => void }) {
  return <div className={styles.experienceTabs} role="group" aria-label="工作模式"><button type="button" aria-pressed={false} disabled={!onChange} onClick={() => onChange?.("chat")}>Chat</button><button type="button" aria-pressed={false} disabled={!onChange} onClick={() => onChange?.("work")}>Work</button><button type="button" aria-pressed={true}>Wechat Agent</button></div>;
}

export function WechatAgentWorkspace({ onBack, onToast, historyPortalTarget, onExperienceChange }: WechatAgentWorkspaceProps) {
  const { state, error, acting, refresh, action, setState } = useWechatAgentState();
  const [extraConversations, setExtraConversations] = useState<{ items: WechatConversation[]; nextCursor?: string | null } | null>(null);
  const conversationId = state?.currentConversationId || "";
  const conversations = mergeItems(extraConversations?.items || [], state?.conversations.items || []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const conversationCursor = extraConversations ? extraConversations.nextCursor : state?.conversations.nextCursor;
  const [feed, setFeed] = useState<{ conversationId: string; page: WechatMessagePage; olderPagesStarted: boolean } | null>(null);
  const page = feed?.conversationId === conversationId ? feed.page : { items: [], pendingActions: [] };
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[conversationId] || "";
  const setDraft = (value: string) => setDrafts((old) => ({ ...old, [conversationId]: value }));
  const [feedIssue, setFeedIssue] = useState<{ conversationId: string; text: string } | null>(null);
  const feedError = feedIssue?.conversationId === conversationId ? feedIssue.text : "";
  const [configOpen, setConfigOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [paging, setPaging] = useState(false);
  const feedController = useRef<AbortController | null>(null);
  const connected = state?.connection.status === "connected";
  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController(); feedController.current = controller; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 5_000;
      if (document.visibilityState === "hidden") { timer = setTimeout(poll, delay); return; }
      try {
        const next = await request(`${endpoint}?action=messages&conversationId=${encodeURIComponent(conversationId)}`, wechatMessagePageSchema, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setFeed((old) => { const same = old?.conversationId === conversationId; return { conversationId, olderPagesStarted: same ? old.olderPagesStarted : false, page: { ...next, nextCursor: same && old.olderPagesStarted ? old.page.nextCursor : next.nextCursor, items: mergeItems(same ? old.page.items : [], next.items).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) } }; });
          setFeedIssue(null);
          delay = next.items.some((item) => item.status === "running" || item.status === "pending") ? 750 : 5_000;
        }
      } catch (issue) { if (!controller.signal.aborted) setFeedIssue({ conversationId, text: issue instanceof Error ? issue.message : "消息读取失败" }); }
      if (!controller.signal.aborted) timer = setTimeout(poll, delay);
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [conversationId, revision]);
  const newConversation = useCallback(async () => {
    if (!connected || acting) return;
    const next = await action({ action: "createConversation" });
    if (next?.currentConversationId) setDrafts((old) => ({ ...old, [next.currentConversationId!]: "" }));
  }, [action, acting, connected]);
  useEffect(() => {
    const onNewConversation = () => { void newConversation(); };
    window.addEventListener("lumaflow-wechat-new-conversation", onNewConversation);
    return () => window.removeEventListener("lumaflow-wechat-new-conversation", onNewConversation);
  }, [newConversation]);
  async function selectConversation(id: string) {
    await action({ action: "activate", conversationId: id });
  }
  async function updateConversation(id: string, patch: { title?: string; pinned?: boolean }) {
    const next = await action({ action: "updateConversation", conversationId: id, ...patch });
    if (next) onToast?.(patch.title ? "对话名称已更新" : patch.pinned ? "对话已置顶" : "对话已取消置顶");
  }
  async function deleteConversation(id: string) {
    const next = await action({ action: "deleteConversation", conversationId: id });
    if (next) onToast?.("对话已删除");
  }
  async function shareConversation(id: string) {
    const selected = conversations.find((item) => item.id === id);
    const loaded = feed?.conversationId === id ? feed.page.items : [];
    if (!selected || !loaded.length) { onToast?.("当前页面还没有可复制的已加载消息。"); return; }
    const text = [`${selected.title}（当前页面已加载内容）`, ...loaded.map((message) => `${message.source === "wechat" ? "微信" : "本机工作"} · ${message.senderName || (message.role === "user" ? "你" : message.role === "assistant" ? WECHAT_AGENT_DISPLAY_NAME : "系统")}：${message.text}`)].join("\n");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("当前浏览器不支持复制");
      await navigator.clipboard.writeText(text);
      onToast?.("当前页面已加载的对话内容已复制");
    } catch (issue) { onToast?.(issue instanceof Error ? issue.message : "复制对话失败"); }
  }
  async function send() {
    const text = draft.trim(); if (!text || !conversationId) return;
    const next = await action({ action: "send", conversationId, text, clientMessageId: crypto.randomUUID() });
    if (next) { setDraft(""); setRevision((value) => value + 1); }
  }
  async function loadConversations() {
    if (!conversationCursor) return; setPaging(true);
    try { const next = await request(`${endpoint}?action=conversations&cursor=${encodeURIComponent(conversationCursor)}`, wechatConversationPageSchema); setExtraConversations((old) => ({ items: mergeItems(next.items, old?.items || []), nextCursor: next.nextCursor ?? null })); }
    catch (issue) { setFeedIssue({ conversationId, text: issue instanceof Error ? issue.message : "会话读取失败" }); } finally { setPaging(false); }
  }
  async function loadOlder() {
    if (!page.nextCursor) return; setPaging(true);
    const requestedConversation = conversationId;
    const controller = feedController.current;
    setFeed((old) => old?.conversationId === requestedConversation ? { ...old, olderPagesStarted: true } : old);
    try {
      const next = await request(`${endpoint}?action=messages&conversationId=${encodeURIComponent(requestedConversation)}&cursor=${encodeURIComponent(page.nextCursor)}`, wechatMessagePageSchema, { signal: controller?.signal });
      if (!controller?.signal.aborted) setFeed((old) => old?.conversationId === requestedConversation ? { ...old, page: { ...old.page, nextCursor: next.nextCursor, items: mergeItems(next.items, old.page.items).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) } } : old);
    } catch (issue) { if (!controller?.signal.aborted) setFeedIssue({ conversationId: requestedConversation, text: issue instanceof Error ? issue.message : "消息读取失败" }); } finally { setPaging(false); }
  }
  const historyItems: ConversationHistoryItem[] = conversations.map((item) => ({ id: item.id, title: item.title, pinned: "pinned" in item ? Boolean(item.pinned) : false }));
  const conversationHistory = <aside className={styles.wechatHistory} aria-label="微信 Agent 对话记录"><header><strong>微信对话</strong><button type="button" className={styles.historyNew} disabled={acting} onClick={() => void newConversation()}><Plus size={13} /> 新对话</button></header><ConversationHistoryList items={historyItems} selectedId={conversationId} onSelect={(id) => void selectConversation(id)} onRename={(id, title) => void updateConversation(id, { title })} onPin={(id, pinned) => void updateConversation(id, { pinned })} onDelete={(id) => void deleteConversation(id)} onShare={(id) => void shareConversation(id)} />{conversationCursor && <button type="button" className={styles.historyMore} disabled={paging} onClick={() => void loadConversations()}>{paging ? "正在读取…" : "加载更多会话"}</button>}</aside>;
  const sidebarHistory = historyPortalTarget ? createPortal(conversationHistory, historyPortalTarget) : null;
  if (!state) return <section className={styles.card}>{error ? <p className={styles.error} role="alert">{error}</p> : <p className={styles.empty}>正在读取微信工作区…</p>}<button className={styles.secondary} onClick={() => void refresh()}>重新读取</button></section>;
  if (!connected) return <section className={styles.root} aria-label="微信 Agent 工作区">
    <header className={styles.header}><ClawBotAvatar /><div><h2>{WECHAT_AGENT_DISPLAY_NAME}</h2><p>本产品微信 Agent · 连接后开放工作区</p></div><ExperienceTabs onChange={onExperienceChange} /><ConnectionStatus state={state} />{onBack && <button className={styles.secondary} onClick={onBack}>返回智能体</button>}</header>
    {(error || state.connection.error) && <p className={styles.error} role="alert">{error || state.connection.error}</p>}
    <ConnectionGuide state={state} acting={acting} onConnect={() => void action({ action: "connect" })} onRefresh={() => void refresh()} />
  </section>;
  return <section className={styles.root} aria-label="微信 Agent 工作区">
    <header className={styles.header}><ClawBotAvatar /><div><h2>{WECHAT_AGENT_DISPLAY_NAME}</h2><p>本产品微信 Agent · 独立工作与消息记录</p></div><ExperienceTabs onChange={onExperienceChange} /><ConnectionStatus state={state} /><button type="button" className={styles.icon} aria-label="配置微信 Agent" onClick={() => setConfigOpen(true)}><Settings size={16} /></button>{onBack && <button className={styles.secondary} onClick={onBack}>返回智能体</button>}</header>
    {sidebarHistory}<div className={styles.body}>
      <div className={styles.chat}><div className={styles.chatHeading}>{conversations.find((item) => item.id === conversationId)?.title || "微信工作会话"}</div><div className={styles.feed} aria-label="微信工作与同步消息">{(error || feedError) && <p className={styles.error} role="alert">{error || feedError}</p>}{page.nextCursor && <button type="button" className={styles.secondary} disabled={paging} onClick={() => void loadOlder()}>查看更早消息</button>}{!conversationId ? <p className={styles.empty}>新建一个对话，开始微信 Agent 的工作。</p> : !page.items.length && !feedError ? <p className={styles.empty}>当前会话暂无已记录消息。</p> : page.items.filter((message) => message.conversationId === conversationId).map((message) => <CanonicalMessage key={message.id} message={message} agentName={WECHAT_AGENT_DISPLAY_NAME} />)}
        {page.pendingActions.filter((item) => item.conversationId === conversationId && item.state === "pending").map((item) => <section className={styles.pending} key={item.id} aria-label={`待确认：${item.title}`}><strong>待确认 · {item.title}</strong>{item.detail && <p>{item.detail}</p>}<div><button type="button" className={styles.primary} disabled={acting} onClick={async () => { if (await action({ action: "confirmAction", actionId: item.id, approved: true })) setRevision((value) => value + 1); }}>确认执行</button><button type="button" className={styles.secondary} disabled={acting} onClick={async () => { if (await action({ action: "confirmAction", actionId: item.id, approved: false })) setRevision((value) => value + 1); }}>拒绝</button></div></section>)}
      </div><div className={styles.composer}><textarea aria-label="微信 Agent 工作指令" placeholder="描述任务，或询问当前微信会话…" maxLength={12_000} value={draft} disabled={!conversationId || acting} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><footer><small>{state.connection.status === "connected" && state.agent.syncEnabled ? "微信同步已开启" : "微信未同步"} · 回复自动发送到绑定的微信会话</small><button type="button" className={styles.primary} disabled={!conversationId || !draft.trim() || acting} onClick={() => void send()}>{acting ? "正在提交…" : "提交任务"}</button></footer></div></div>
    </div>{configOpen && <WechatConfigDialog agent={state.agent} onClose={() => setConfigOpen(false)} onSaved={(next) => { setState(next); setConfigOpen(false); onToast?.(configSavedMessage); }} />}
  </section>;
}

function CanonicalMessage({ message, agentName }: { message: WechatMessage; agentName: string }) {
  const delivery = { none: "", pending: message.status === "awaiting_confirmation" ? "待确认发送" : "正在发送到微信", sent: "已发送到微信", failed: "微信发送失败" };
  return <article className={styles.message} data-role={message.role} aria-label={`${message.source === "wechat" ? "微信" : "工作"}消息`}><header><strong>{message.senderName || (message.role === "user" ? "你" : message.role === "assistant" ? agentName : "系统")}{message.recipientName ? ` → ${message.recipientName}` : ""}</strong><span>{message.source === "wechat" ? "微信同步" : "本机工作"}</span><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString("zh-CN")}</time>{message.status === "running" && <span>正在工作</span>}{message.status === "failed" && <span>失败</span>}</header><p>{message.text || (message.status === "running" ? "正在等待返回内容…" : "暂无正文")}</p>{message.deliveryStatus && delivery[message.deliveryStatus] && <span className={styles.delivery}>{delivery[message.deliveryStatus]}</span>}</article>;
}
