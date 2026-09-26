"use client";

/* eslint-disable @next/next/no-img-element -- CowAgent avatars use authenticated runtime URLs and local blob previews. */

import { Bot, CheckCircle2, FileText, FolderOpen, MessageCircle, Plus, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AgentRoleId } from "@/config/agent-roles";
import type { CowAgentProfile, CowAgentRoster } from "@/lib/contracts/cowagent-agent";
import { WorkspaceFolderField } from "./workspace-folder-field";
import { WechatAgentCard } from "./wechat-agent-workspace";
import styles from "./agent-management.module.css";

const endpoint = "/api/v1/cowagent/agents";
type AgentKind = "local" | "wechat";
type AgentPermissions = NonNullable<CowAgentProfile["permissions"]>;

const permissionModes: Array<{ id: "request" | "assist" | "full"; label: string; summary: string; permissions: AgentPermissions }> = [
  { id: "request", label: "请求批准", summary: "只读授权文件；写入和本机工具会被拦截。", permissions: { read: true, create: false, modify: false, delete: false, tools: false } },
  { id: "assist", label: "帮我批准", summary: "可在授权目录创建、修改文件；删除和本机工具会被拦截。", permissions: { read: true, create: true, modify: true, delete: false, tools: false } },
  { id: "full", label: "完全访问权限", summary: "可读写、删除授权文件，并用当前 Windows 账户运行本机工具。", permissions: { read: true, create: true, modify: true, delete: true, tools: true } },
];
type PermissionModeId = (typeof permissionModes)[number]["id"];


async function readRoster(signal?: AbortSignal) {
  const response = await fetch(endpoint, { cache: "no-store", headers: { Accept: "application/json" }, signal });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || "无法读取智能体列表");
  return payload.data as CowAgentRoster;
}

function initials(agent: CowAgentProfile) {
  return agent.name.trim().slice(0, 2).toUpperCase() || "AI";
}

function generatedId(name: string) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "agent-" + Date.now().toString(36);
}

function agentKind(agent: CowAgentProfile): AgentKind {
  if (agent.type === "wechat") return "wechat";
  if (agent.type === "local") return "local";
  // Old rosters used the channel subtype as their only discriminator.
  return agent.agentType === "weixin_personal" || agent.agentType === "wecom_group" ? "wechat" : "local";
}


function parseKnowledgeIds(value: string) {
  return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))];
}

function parseLines(value: string) {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}


function knowledgeSummary(agent: CowAgentProfile) {
  if (agent.knowledgeBaseIds?.length) return agent.knowledgeBaseIds.join("、");
  return agent.knowledgeMode === "own" ? "独立知识库" : "共享团队知识库";
}

const permissionLabels: Array<[keyof AgentPermissions, string]> = [
  ["read", "读取文件"],
  ["create", "创建文件"],
  ["modify", "修改文件"],
  ["delete", "删除文件"],
  ["tools", "本地工具（PowerShell）"],
];

function permissionModeFor(permissions?: AgentPermissions) {
  const effective = permissions ?? permissionModes[0].permissions;
  return permissionModes.find((mode) => permissionLabels.every(([key]) => mode.permissions[key] === effective[key]));
}

export function AgentManagement({ onToast, onWork, onWechatWork }: { onToast?: (message: string) => void; onWork?: (agentId: string) => void; onWechatWork?: () => void }) {
  const [roster, setRoster] = useState<CowAgentRoster>({ agents: [], defaultAgentId: "", revision: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createKind, setCreateKind] = useState<"local" | null>(null);
  const [editingId, setEditingId] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<{ title: string; url: string; content: string }>>([]);
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [cloneFrom, setCloneFrom] = useState("");
  const [knowledgeMode, setKnowledgeMode] = useState<"shared" | "own">("shared");
  const [knowledgeBaseText, setKnowledgeBaseText] = useState("");
  const [knowledgeOptions, setKnowledgeOptions] = useState<Array<{ id: string; title: string; originalName: string }>>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState("");
  const [knowledgeMenu, setKnowledgeMenu] = useState(false);
  const [showKnowledgeFiles, setShowKnowledgeFiles] = useState(false);
  const [showKnowledgeText, setShowKnowledgeText] = useState(false);
  const [knowledgeTextTitle, setKnowledgeTextTitle] = useState("");
  const [knowledgeTextBody, setKnowledgeTextBody] = useState("");
  const [uploadingKnowledge, setUploadingKnowledge] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [allowedPathsText, setAllowedPathsText] = useState("");
  const [roleIds, setRoleIds] = useState<AgentRoleId[]>(["sales-consultant"]);
  const [permissionMode, setPermissionMode] = useState<PermissionModeId>("request");
  const [avatar, setAvatar] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState<AgentKind>("local");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const knowledgeFileInput = useRef<HTMLInputElement>(null);
  const knowledgePickerRef = useRef<HTMLDivElement>(null);
  const knowledgeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!createKind) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      if (knowledgeMenu) { setKnowledgeMenu(false); return; }
      if (searchOpen) { setSearchOpen(false); return; }
      if (showKnowledgeFiles || showKnowledgeText) { setShowKnowledgeFiles(false); setShowKnowledgeText(false); return; }
      setCreateKind(null);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [createKind, saving, knowledgeMenu, searchOpen, showKnowledgeFiles, showKnowledgeText]);

  useEffect(() => {
    if (!knowledgeMenu) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !knowledgePickerRef.current?.contains(event.target) && !knowledgeButtonRef.current?.contains(event.target)) setKnowledgeMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setKnowledgeMenu(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [knowledgeMenu]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try { setRoster(await readRoster(signal)); }
    catch (issue) { if (!signal?.aborted) setError(issue instanceof Error ? issue.message : "本地智能体服务未连接"); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    readRoster(controller.signal).then((next) => {
      if (!controller.signal.aborted) { setRoster(next); setError(""); }
    }).catch((issue) => {
      if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : "本地智能体服务未连接");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => () => { if (avatarPreview) URL.revokeObjectURL(avatarPreview); }, [avatarPreview]);

  useEffect(() => {
    if (!createKind) return;
    const controller = new AbortController();
    const readFiles = async () => {
      const entries: unknown[] = [];
      for (let offset = 0; offset < 5_000; offset += 200) {
        const response = await fetch(`/api/v1/knowledge?limit=200&offset=${offset}`, { cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error?.message || "知识库列表读取失败");
        const page = Array.isArray(payload?.data) ? payload.data : [];
        entries.push(...page);
        if (page.length < 200 || (typeof payload?.summary?.total === "number" && entries.length >= payload.summary.total)) break;
      }
      if (!controller.signal.aborted) setKnowledgeOptions((current) => {
        const fetched = entries.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const item = entry as Record<string, unknown>;
        if (typeof item.id !== "string" || !item.id) return [];
        return [{ id: item.id, title: typeof item.title === "string" && item.title ? item.title : "未命名知识文件", originalName: typeof item.originalName === "string" ? item.originalName : "" }];
        });
        return [...new Map([...current, ...fetched].map((option) => [option.id, option])).values()];
      });
    };
    void readFiles().catch((issue) => {
      if (!controller.signal.aborted) setKnowledgeError(issue instanceof Error ? issue.message : "知识库列表读取失败");
    }).finally(() => {
      if (!controller.signal.aborted) setKnowledgeLoading(false);
    });
    return () => controller.abort();
  }, [createKind]);

  function resetForm() {
    setEditingId(""); setPreviewing(false); setSearchOpen(false); setSearchQuery(""); setSearchResults([]);
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    setName(""); setAgentId(""); setIdEdited(false); setDescription(""); setSystemPrompt(""); setCloneFrom("");
    setKnowledgeMode("shared"); setKnowledgeBaseText(""); setKnowledgeOptions([]); setKnowledgeError(""); setKnowledgeMenu(false); setShowKnowledgeFiles(false); setShowKnowledgeText(false); setKnowledgeTextTitle(""); setKnowledgeTextBody(""); setWorkspace(""); setAllowedPathsText("");
    setRoleIds(["sales-consultant"]); setPermissionMode("request"); setAvatar(null); setAvatarPreview(""); setError("");
  }

  function startCreate(kind: "local") {
    resetForm();
    setKnowledgeLoading(true); setKnowledgeError("");
    setCreateKind(kind);
  }

  function changeName(value: string) {
    setName(value);
    if (!idEdited) setAgentId(generatedId(value));
  }

  function startEdit(agent: CowAgentProfile) {
    resetForm();
    setEditingId(agent.id); setName(agent.name); setAgentId(agent.id); setIdEdited(true);
    setDescription(agent.description || ""); setSystemPrompt(agent.systemPrompt || "");
    setKnowledgeMode(agent.knowledgeMode); setKnowledgeBaseText((agent.knowledgeBaseIds || []).join("\n"));
    setWorkspace(agent.workspace); setAllowedPathsText((agent.allowedPaths || []).join("\n"));
    setRoleIds(agent.roleIds?.length ? agent.roleIds : ["sales-consultant"]);
    setPermissionMode(permissionModeFor(agent.permissions)?.id || "request");
    setKnowledgeLoading(true); setCreateKind("local");
  }

  async function runSearch() {
    if (!searchQuery.trim() || searching) return;
    setSearching(true); setKnowledgeError(""); setSearchResults([]);
    try {
      const response = await fetch("/api/v1/knowledge/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: searchQuery.trim() }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "搜索失败");
      setSearchResults(payload.results || []);
      if (!payload.results?.length) setKnowledgeError("没有找到结果，请调整搜索内容。");
    } catch (issue) { setKnowledgeError(issue instanceof Error ? issue.message : "搜索失败"); }
    finally { setSearching(false); }
  }

  async function uploadKnowledgeFiles(files: FileList | File[] | null): Promise<boolean> {
    if (!files?.length) return false;
    setUploadingKnowledge(true); setKnowledgeError("");
    try {
      const nextIds = parseKnowledgeIds(knowledgeBaseText);
      const nextOptions = [...knowledgeOptions];
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch("/api/v1/knowledge", { method: "POST", body: form });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error?.message || `“${file.name}”上传失败`);
        const entry = payload?.data;
        if (typeof entry?.id !== "string" || !entry.id) throw new Error(`“${file.name}”上传后未返回文件 ID`);
        if (!nextIds.includes(entry.id)) nextIds.push(entry.id);
        if (!nextOptions.some((option) => option.id === entry.id)) nextOptions.unshift({ id: entry.id, title: entry.title || file.name, originalName: entry.originalName || file.name });
        setKnowledgeBaseText(nextIds.join("\n"));
        setKnowledgeOptions((current) => [...new Map([...current, ...nextOptions].map((option) => [option.id, option])).values()]);
      }
      setShowKnowledgeFiles(true);
      onToast?.(`${files.length} 个文件已添加到知识库`);
      return true;
    } catch (issue) {
      setKnowledgeError(issue instanceof Error ? issue.message : "知识文件上传失败");
      return false;
    } finally {
      setUploadingKnowledge(false);
      if (knowledgeFileInput.current) knowledgeFileInput.current.value = "";
    }
  }

  async function saveKnowledgeText() {
    const title = knowledgeTextTitle.trim();
    const content = knowledgeTextBody.trim();
    if (!title || !content) { setKnowledgeError("请填写标题和正文。"); return; }
    const safeName = title.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 120) || "知识笔记";
    const saved = await uploadKnowledgeFiles([new File([content], `${safeName}.txt`, { type: "text/plain" })]);
    if (saved) { setShowKnowledgeText(false); setKnowledgeTextTitle(""); setKnowledgeTextBody(""); }
  }

  async function submit() {
    if (!createKind) return;
    const cleanName = name.trim();
    const cleanId = agentId.trim();
    if (!cleanName) { setError("请先填写智能体名称。"); return; }
    if (createKind === "local" && !description.trim()) { setError("请填写这个本地 Agent 的主要任务。"); return; }
    if (uploadingKnowledge) { setError("请等待知识文件上传完成。"); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(cleanId)) { setError("ID 只能包含英文字母、数字、下划线或短横线，并以字母或数字开头。"); return; }
    setSaving(true); setError("");
    try {
      const body: Record<string, unknown> = {
        id: cleanId,
        name: cleanName,
        description: description.trim(),
        cloneFrom: cloneFrom || null,
        knowledgeMode,
        type: createKind,
        systemPrompt: systemPrompt.trim(),
        knowledgeBaseIds: parseKnowledgeIds(knowledgeBaseText),
        roleIds,
        revision: roster.revision || undefined,
      };
      if (createKind === "local") {
        body.workspace = workspace.trim() || undefined;
        body.allowedPaths = parseLines(allowedPathsText);
        body.permissions = permissionModes.find((mode) => mode.id === permissionMode)?.permissions;
      }
      const response = await fetch(endpoint, {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "智能体创建失败");
      let avatarWarning = "";
      if (avatar) {
        const form = new FormData(); form.append("avatar", avatar, avatar.name);
        const avatarResponse = await fetch(endpoint + "/" + encodeURIComponent(cleanId) + "/avatar", { method: "POST", body: form });
        if (!avatarResponse.ok) avatarWarning = "，但头像暂未保存";
      }
      let savedRoster = payload.data as CowAgentRoster;
      setRoster(savedRoster);
      setView(createKind);
      setSelectedAgentId(cleanId);
      setCreateKind(null); resetForm();
      onToast?.(editingId ? "Agent 设置已保存" + avatarWarning : "本地 Agent“" + cleanName + "”已创建" + avatarWarning);
      if (avatar) {
        try { savedRoster = await readRoster(); setRoster(savedRoster); }
        catch { /* The save response remains usable if the avatar refresh fails. */ }
      }
      window.dispatchEvent(new CustomEvent("lumaflow-agents-updated", { detail: { agentId: cleanId, roster: savedRoster } }));
    } catch (issue) { setError(issue instanceof Error ? issue.message : "智能体创建失败"); }
    finally { setSaving(false); }
  }

  async function removeAgent(agent: CowAgentProfile) {
    if (agent.id === roster.defaultAgentId) { setError("当前被设为默认的 Agent 无法删除，请先更换默认设置。"); return; }
    const kind = agentKind(agent);
    const message = "确定删除智能体“" + agent.name + "”吗？\n\n" + (kind === "local" ? "将移除它的管理记录；仅自动创建的专属工作间会被清理。若它正在执行任务，请先等待完成。" : "将同时解除对应微信通道绑定。") + "\n此操作无法撤销。";
    if (!window.confirm(message)) return;
    setDeleting(true); setError("");
    try {
      const response = await fetch(endpoint, {
        method: "DELETE",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ id: agent.id, revision: roster.revision || undefined }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "智能体删除失败");
      const next = payload.data as CowAgentRoster;
      setRoster(next);
      setSelectedAgentId(next.defaultAgentId || next.agents[0]?.id || "");
      onToast?.("智能体“" + agent.name + "”已删除");
    } catch (issue) { setError(issue instanceof Error ? issue.message : "智能体删除失败"); }
    finally { setDeleting(false); }
  }

  const localAgents = useMemo(() => roster.agents.filter((agent) => agent.id !== "default" && agentKind(agent) === "local"), [roster.agents]);
  const visibleAgents = localAgents;
  const selectedAgent = visibleAgents.find((agent) => agent.id === selectedAgentId) ?? visibleAgents[0];
  const selectedPermissionMode = selectedAgent ? permissionModeFor(selectedAgent.permissions) : undefined;
  const enabledCount = visibleAgents.filter((agent) => agent.enabled).length;
  const selectedKnowledgeIds = parseKnowledgeIds(knowledgeBaseText);

  return <div className={styles.root} data-testid="agent-management">
    <section className={styles.hero}>
      <div><small>LumaFlow 控制台 · Agent 管理</small><h2>管理你的智能体</h2><p>本地 Agent 处理电脑任务，微信 Agent 连接微信并使用自己的工作与对话记录。</p></div>
      {view === "local" && <div className={styles.heroActions}><button type="button" className={styles.secondary} onClick={() => startCreate("local")}><Plus size={15} /> 创建本地 Agent</button></div>}
    </section>

    <div className={styles.viewBar}>
      <div className={styles.viewTabs} role="tablist" aria-label="Agent 类型">
        <button type="button" role="tab" aria-selected={view === "local"} onClick={() => setView("local")}><Bot size={14} /> 本地 Agent <em>{localAgents.length}</em></button>
        <button type="button" role="tab" aria-selected={view === "wechat"} onClick={() => setView("wechat")}><MessageCircle size={14} /> 微信 Agent</button>
      </div>
      <button type="button" className={styles.secondary} disabled={loading} onClick={() => void load()}><RefreshCw size={13} /> 刷新后端</button>
    </div>

    {view === "wechat" && <WechatAgentCard onWork={onWechatWork} onToast={onToast} />}

    {view === "local" && <>
    <div className={styles.toolbar}><div><h3>{view === "local" ? "本地 Agent" : "微信 Agent"}</h3><span>{view === "local" ? "在当前电脑执行你设定的任务，使用授权的工作间与文件。" : "部署到微信；每个微信 Agent 对应一个 WeixinClawBot，私人微信最多绑定 1 个。"}</span></div><strong className={styles.countLabel}>{enabledCount} 个运行中 · {visibleAgents.length} 个 Agent</strong></div>
    {error && !createKind && <p className={styles.error} role="alert">{error}</p>}
    {loading ? <div className={styles.empty}>正在读取智能体列表…</div> : visibleAgents.length && selectedAgent ? <section className={styles.workspace} aria-label={(view === "local" ? "本地" : "微信") + " Agent 列表"}>
      <aside className={styles.roster}><header><strong>本地 Agent</strong><button type="button" onClick={() => startCreate("local")}><Plus size={13} /> 新建</button></header>{visibleAgents.map((agent) => <button type="button" className={styles.rosterItem} aria-pressed={selectedAgent.id === agent.id} key={agent.id} onClick={() => setSelectedAgentId(agent.id)}><span className={styles.avatar}>{agent.avatar === "image" ? <img src={endpoint + "/" + encodeURIComponent(agent.id) + "/avatar?v=" + encodeURIComponent(agent.avatarRev || "0")} alt="" /> : initials(agent)}</span><span><strong>{agent.name}</strong><small>{agent.description || "本机文件与工具 Agent"}</small></span></button>)}</aside>
      <article className={styles.detail}>
        <div className={styles.detailHeading}><div className={styles.detailAvatar}>{selectedAgent.avatar === "image" ? <img src={endpoint + "/" + encodeURIComponent(selectedAgent.id) + "/avatar?v=" + encodeURIComponent(selectedAgent.avatarRev || "0")} alt="" /> : initials(selectedAgent)}</div><div><h3>{selectedAgent.name}</h3><p>Agent ID · {selectedAgent.id}</p></div><span className={styles.runState} data-active={selectedAgent.enabled}><i />{selectedAgent.enabled ? "运行中" : "已停用"}</span></div>
        <>
          <div className={styles.detailTabs}><strong>本地 Agent 概况</strong><span>本机执行权限只对这个 Agent 生效</span></div>
          <dl className={styles.profileFields}><div><dt>类型</dt><dd>本地 Agent · 当前电脑执行</dd></div><div><dt>自定义 · 主要任务</dt><dd className={styles.preWrap}>{selectedAgent.description || "尚未设定主要任务"}</dd></div><div><dt>补充设定</dt><dd className={styles.preWrap}>{selectedAgent.systemPrompt || "无"}</dd></div><div><dt>知识库</dt><dd>{knowledgeSummary(selectedAgent)}</dd></div><div><dt>工作间（文件夹）</dt><dd className={styles.monospace}>{selectedAgent.workspace}</dd></div><div><dt>权限</dt><dd>{selectedPermissionMode ? <><strong>{selectedPermissionMode.label}</strong><br /><small>{selectedPermissionMode.summary}{selectedPermissionMode.id !== "full" ? " 超范围操作直接拦截，不会弹出批准窗口。" : ""}</small></> : <div className={styles.capabilityList}>{permissionLabels.map(([key, label]) => <span key={key} className={styles.capability} data-enabled={selectedAgent.permissions?.[key] === true}>{selectedAgent.permissions?.[key] ? "✓" : "×"} {label}</span>)}</div>}</dd></div></dl>
          <div className={styles.detailActions} role="group" aria-label="本地 Agent 操作">{onWork && <button type="button" className={styles.primary} disabled={!selectedAgent.enabled} onClick={() => onWork(selectedAgent.id)}>开始 Work</button>}<button type="button" className={styles.secondary} onClick={() => startEdit(selectedAgent)}>修改 Agent</button><button type="button" className={styles.danger} disabled={deleting} onClick={() => void removeAgent(selectedAgent)}><Trash2 size={14} /> {deleting ? "正在删除…" : "删除 Agent"}</button></div>
        </>
      </article>
    </section> : <div className={styles.empty}>暂无本地 Agent。创建一个 Agent，让它帮助你处理本机文件和任务。</div>}
    </>}

    {createKind && <div className={styles.modal} role="dialog" aria-modal="true" aria-label={(editingId ? "修改" : "创建") + (createKind === "local" ? "本地" : "微信") + " Agent"}><button type="button" className={styles.scrim} aria-label="关闭创建 Agent" onClick={() => !saving && setCreateKind(null)} /><section className={styles.panel}>
      <header className={styles.modalHeader}><div><small>{createKind === "local" ? "LOCAL AGENT" : "WECHAT AGENT"}</small><h2>{previewing ? "预览" : editingId ? "修改" : "创建"}{createKind === "local" ? "本地" : "微信"} Agent</h2><p>{createKind === "local" ? "设定主要任务、工作间和可用文件。" : "部署到微信中的对话 Agent；创建后可绑定对应的 WeixinClawBot。"}</p></div><button type="button" className={styles.iconButton} aria-label="关闭" disabled={saving} onClick={() => setCreateKind(null)}><X size={18} /></button></header>
      <div className={styles.form}>
        {previewing && <section className={styles.previewSummary} aria-label="Agent 预览"><h3>{name || "未命名 Agent"}</h3><p className={styles.preWrap}>{description || systemPrompt || "尚未填写任务"}</p><p>知识库：{selectedKnowledgeIds.length} 个文件</p>{createKind === "local" && <><p>工作间：{workspace || "自动创建"}</p><p>权限：{permissionModes.find((mode) => mode.id === permissionMode)?.label}</p></>}</section>}
        <label className={styles.field}>名称<input aria-label="名称" autoFocus required value={name} maxLength={80} placeholder={createKind === "local" ? "例如：销售资料助手" : "例如：微信销售助手"} onChange={(event) => changeName(event.target.value)} /></label>
        <div className={styles.twoColumns}><label className={styles.field}>Agent ID<input aria-label="Agent ID" disabled={Boolean(editingId)} required value={agentId} maxLength={64} placeholder="local-sales" onChange={(event) => { setIdEdited(true); setAgentId(event.target.value); }} /><small>创建后保持稳定。</small></label><label className={styles.field}>从已有 Agent 复制<select disabled={Boolean(editingId)} value={cloneFrom} onChange={(event) => setCloneFrom(event.target.value)}><option value="">不复制，只使用基础设置</option>{localAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><small>只复制角色设定，不复制聊天记录和秘密。</small></label></div>
        <label className={styles.field}>自定义 · 主要任务<textarea aria-label="主要任务" required value={description} maxLength={1_000} placeholder="例如：整理工作间里的资料，按我的要求生成可核对的总结。" onChange={(event) => setDescription(event.target.value)} /></label>
        {createKind === "local" ? <details className={styles.advanced}><summary>补充设定（可选）</summary><label className={styles.field}>回答方式与边界<textarea aria-label="补充设定" value={systemPrompt} maxLength={12_000} placeholder="例如：先列依据，遇到不确定的信息请标明。" onChange={(event) => setSystemPrompt(event.target.value)} /></label></details> : <label className={styles.field}>System Prompt<textarea aria-label="System Prompt" value={systemPrompt} maxLength={12_000} placeholder="描述它在微信对话中的身份、语气和工作边界…" onChange={(event) => setSystemPrompt(event.target.value)} /></label>}
        <div className={styles.field}><span>知识库</span><div className={styles.knowledgeActions}><button type="button" ref={knowledgeButtonRef} className={styles.addKnowledge} aria-expanded={knowledgeMenu} onClick={() => setKnowledgeMenu((current) => !current)}><Plus size={15} /> 添加文件</button><span>{selectedKnowledgeIds.length ? `已选择 ${selectedKnowledgeIds.length} 个文件` : "可留空，使用共享知识库"}</span></div>{knowledgeMenu && <div ref={knowledgePickerRef} className={styles.knowledgeMenu}><strong>添加</strong><button type="button" disabled={uploadingKnowledge} onClick={() => { setKnowledgeMenu(false); knowledgeFileInput.current?.click(); }}><Upload size={16} /> 上传新文件</button><button type="button" onClick={() => { setKnowledgeMenu(false); setShowKnowledgeFiles(true); }}><FolderOpen size={16} /> 选择知识库现有文件</button><button type="button" onClick={() => { setKnowledgeMenu(false); setShowKnowledgeText(true); }}><FileText size={16} /> 输入文字</button><button type="button" onClick={() => { setKnowledgeMenu(false); setSearchOpen(true); setSearchQuery(description.slice(0, 1000)); }}><Search size={16} /> 网上搜索</button></div>}<input className={styles.hiddenFile} ref={knowledgeFileInput} aria-label="知识库文件上传" type="file" multiple onChange={(event) => void uploadKnowledgeFiles(event.target.files)} />{uploadingKnowledge && <small role="status">正在上传知识文件…</small>}{knowledgeError && <small className={styles.knowledgeError} role="alert">{knowledgeError}</small>}</div>
        {searchOpen && <div className={styles.knowledgeTextForm} role="region" aria-label="网上搜索"><div className={styles.knowledgePickerHead}><strong>网上搜索</strong><button type="button" aria-label="关闭网上搜索" onClick={() => setSearchOpen(false)}><X size={14} /></button></div><label className={styles.field}>搜索内容<input aria-label="搜索内容" value={searchQuery} maxLength={1000} placeholder="查找符合主要任务的资料" onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void runSearch(); } }} /></label><button type="button" className={styles.secondary} disabled={searching || !searchQuery.trim()} onClick={() => void runSearch()}>{searching ? "正在搜索…" : "搜索"}</button>{searchResults.map((result) => <div className={styles.searchResult} key={result.url}><a href={result.url} target="_blank" rel="noreferrer">{result.title}</a><p>{result.content}</p><button type="button" className={styles.secondary} disabled={uploadingKnowledge} onClick={() => void uploadKnowledgeFiles([new File([`${result.title}\n来源：${result.url}\n检索时间：${new Date().toISOString()}\n\n${result.content}`], `${result.title.replace(/[<>:"/\\|?*]/g, "_").slice(0, 100)}.txt`, { type: "text/plain" })])}>保存并选用</button></div>)}</div>}
        {showKnowledgeText && <div className={styles.knowledgeTextForm} role="region" aria-label="文字知识输入"><strong>输入文字</strong><label className={styles.field}>标题<input aria-label="知识文字标题" value={knowledgeTextTitle} maxLength={120} placeholder="例如：常用工作说明" onChange={(event) => setKnowledgeTextTitle(event.target.value)} /></label><label className={styles.field}>正文<textarea aria-label="知识文字正文" value={knowledgeTextBody} maxLength={100_000} placeholder="输入要加入知识库的文字…" onChange={(event) => setKnowledgeTextBody(event.target.value)} /></label><div><button type="button" className={styles.secondary} disabled={uploadingKnowledge} onClick={() => { setShowKnowledgeText(false); setKnowledgeTextTitle(""); setKnowledgeTextBody(""); setKnowledgeError(""); }}>取消</button><button type="button" className={styles.primary} disabled={uploadingKnowledge} onClick={() => void saveKnowledgeText()}>{uploadingKnowledge ? "正在保存…" : "保存并选用"}</button></div></div>}
        {showKnowledgeFiles && <div className={styles.knowledgePicker} aria-label="现有知识库列表"><div className={styles.knowledgePickerHead}><strong>现有知识库文件</strong><span><small>{knowledgeLoading ? "正在读取…" : `${selectedKnowledgeIds.length} 个已选`}</small><button type="button" aria-label="关闭知识库文件列表" onClick={() => setShowKnowledgeFiles(false)}><X size={14} /></button></span></div>{knowledgeOptions.length ? <div className={styles.knowledgeOptions}>{knowledgeOptions.map((option) => <label key={option.id}><input type="checkbox" checked={selectedKnowledgeIds.includes(option.id)} onChange={(event) => { const next = event.target.checked ? [...selectedKnowledgeIds, option.id] : selectedKnowledgeIds.filter((id) => id !== option.id); setKnowledgeBaseText(next.join("\n")); }} /><span><FileText size={15} /><strong>{option.title}</strong><small>{option.originalName || option.id}</small></span></label>)}</div> : <p>{knowledgeError || "知识库里暂无文件，请先上传。"}</p>}</div>}
        <>
          <WorkspaceFolderField value={workspace} onChange={setWorkspace} disabled={saving} />
          <label className={styles.field}>额外授权目录<textarea aria-label="额外授权目录" value={allowedPathsText} maxLength={10_000} placeholder={"每行一个绝对路径，例如 C:\\Users\\你的名字\\Downloads"} onChange={(event) => setAllowedPathsText(event.target.value)} /><small>这些目录会加入本地 Agent 的文件授权范围；Workspace 内文件默认可用。额外目录不会改变命令权限。</small></label>
          <fieldset className={styles.permissionField}><legend>权限</legend><div className={styles.permissionModes}>{permissionModes.map((mode) => <label key={mode.id} className={styles.permissionModeCard}><input type="radio" name="local-permission-mode" value={mode.id} checked={permissionMode === mode.id} onChange={() => setPermissionMode(mode.id)} /><span><strong>{mode.label}</strong><small>{mode.summary}</small></span></label>)}</div><small>前两档的超范围操作会直接拦截；当前版本没有逐次批准弹窗。</small></fieldset>
        </>
        <div className={styles.field}><span>头像（可选）</span><div className={styles.avatarRow}><button type="button" className={styles.avatarPick} onClick={() => fileInput.current?.click()}>{avatarPreview ? <img src={avatarPreview} alt="头像预览" /> : <Upload size={19} />}</button><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (avatarPreview) URL.revokeObjectURL(avatarPreview); setAvatar(file); setAvatarPreview(URL.createObjectURL(file)); }} /><span>PNG、JPG、WebP 或 GIF<br />最大 2 MB</span></div></div>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>

      <footer className={styles.footer}><button type="button" className={styles.secondary} disabled={saving} onClick={() => setCreateKind(null)}>取消</button><button type="button" className={styles.secondary} onClick={() => setPreviewing((value) => !value)}>{previewing ? "返回设定" : "预览"}</button><button type="button" className={styles.primary} disabled={saving} onClick={() => void submit()}>{saving ? "正在保存…" : previewing ? "确定" : editingId ? "确定保存" : <><CheckCircle2 size={15} /> {createKind === "local" ? "创建本地 Agent" : "创建并绑定微信"}</>}</button></footer>
    </section></div>}
  </div>;
}
