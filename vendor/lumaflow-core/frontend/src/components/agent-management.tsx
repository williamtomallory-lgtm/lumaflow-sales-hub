"use client";

/* eslint-disable @next/next/no-img-element -- CowAgent avatars use authenticated runtime URLs and local blob previews. */

import { Bot, CheckCircle2, MessageCircle, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_ROLES, type AgentRoleId } from "@/config/agent-roles";
import type { CowAgentProfile, CowAgentRoster } from "@/lib/contracts/cowagent-agent";
import { CowAgentWeixinDeployment } from "./cowagent-weixin-deployment";
import { CowAgentWecomDeployment } from "./cowagent-wecom-deployment";
import styles from "./agent-management.module.css";

const endpoint = "/api/v1/cowagent/agents";
type AgentKind = "local" | "wechat";
type WechatSubtype = "weixin_personal" | "wecom_group";
type AgentPermissions = NonNullable<CowAgentProfile["permissions"]>;

const defaultLocalPermissions: AgentPermissions = {
  read: true,
  create: true,
  modify: true,
  delete: true,
  tools: true,
};

const templates = [
  { label: "个人微信客服", id: "wechat-service", name: "个人微信客服 Agent", agentType: "weixin_personal" as const, roleIds: ["wechat-service", "sales-consultant"] as AgentRoleId[], description: "只处理个人微信私聊，负责客户咨询、需求提炼、资料查询与待确认回复草稿。" },
  { label: "群聊销售助手", id: "group-sales", name: "群聊销售 Agent", agentType: "wecom_group" as const, roleIds: ["sales-consultant"] as AgentRoleId[], description: "只处理企业微信群聊，被 @ 或命中已启用关键词时回复，并执行明确启用的定时任务。" },
  { label: "个人销售复盘", id: "sales-review", name: "个人销售复盘 Agent", agentType: "weixin_personal" as const, roleIds: ["sales-review"] as AgentRoleId[], description: "在个人微信场景总结聊天和跟进过程，识别问题并形成下一步行动清单。" },
  { label: "朋友圈运营", id: "moments-operator", name: "朋友圈运营 Agent", agentType: "weixin_personal" as const, roleIds: ["moments-operator"] as AgentRoleId[], description: "生成可编辑的朋友圈文案和配图方案；个人微信只交付草稿，企业微信配置官方权限后才允许确认发布。" },
] as const;

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

function wechatSubtype(agent: CowAgentProfile): WechatSubtype {
  if (agent.agentType === "wecom_group") return "wecom_group";
  if (agent.agentType === "weixin_personal") return "weixin_personal";
  return agent.wechat?.accountType === "other" ? "wecom_group" : "weixin_personal";
}

function parseKnowledgeIds(value: string) {
  return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))];
}

function parseLines(value: string) {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

function roleNames(agent: CowAgentProfile) {
  return (agent.roleIds ?? []).map((id) => AGENT_ROLES.find((role) => role.id === id)?.name || id).join("、") || "尚未指定角色";
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
  ["tools", "本地工具"],
];

export function AgentManagement({ onToast, onWork }: { onToast?: (message: string) => void; onWork?: (agentId: string) => void }) {
  const [roster, setRoster] = useState<CowAgentRoster>({ agents: [], defaultAgentId: "", revision: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createKind, setCreateKind] = useState<AgentKind | null>(null);
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
  const [workspace, setWorkspace] = useState("");
  const [allowedPathsText, setAllowedPathsText] = useState("");
  const [wechatSubtypeValue, setWechatSubtypeValue] = useState<WechatSubtype>("weixin_personal");
  const [roleIds, setRoleIds] = useState<AgentRoleId[]>(["sales-consultant"]);
  const [permissions, setPermissions] = useState<AgentPermissions>(defaultLocalPermissions);
  const [avatar, setAvatar] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState<AgentKind>("local");
  const [autoBindAgentId, setAutoBindAgentId] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try { setRoster(await readRoster(signal)); }
    catch (issue) { if (!signal?.aborted) setError(issue instanceof Error ? issue.message : "CowAgent 后端未连接"); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    readRoster(controller.signal).then((next) => {
      if (!controller.signal.aborted) { setRoster(next); setError(""); }
    }).catch((issue) => {
      if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : "CowAgent 后端未连接");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => () => { if (avatarPreview) URL.revokeObjectURL(avatarPreview); }, [avatarPreview]);

  useEffect(() => {
    if (!createKind) return;
    const controller = new AbortController();
    fetch("/api/v1/knowledge?limit=200", { cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "知识库列表读取失败");
      const entries = Array.isArray(payload?.data) ? payload.data : [];
      setKnowledgeOptions(entries.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const item = entry as Record<string, unknown>;
        if (typeof item.id !== "string" || !item.id) return [];
        return [{ id: item.id, title: typeof item.title === "string" && item.title ? item.title : "未命名知识文件", originalName: typeof item.originalName === "string" ? item.originalName : "" }];
      }));
    }).catch((issue) => {
      if (!controller.signal.aborted) setKnowledgeError(issue instanceof Error ? issue.message : "知识库列表读取失败");
    }).finally(() => {
      if (!controller.signal.aborted) setKnowledgeLoading(false);
    });
    return () => controller.abort();
  }, [createKind]);

  function resetForm() {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    setName(""); setAgentId(""); setIdEdited(false); setDescription(""); setSystemPrompt(""); setCloneFrom("");
    setKnowledgeMode("shared"); setKnowledgeBaseText(""); setKnowledgeOptions([]); setKnowledgeError(""); setWorkspace(""); setAllowedPathsText(""); setWechatSubtypeValue("weixin_personal");
    setRoleIds(["sales-consultant"]); setPermissions({ ...defaultLocalPermissions }); setAvatar(null); setAvatarPreview(""); setError("");
  }

  function startCreate(kind: AgentKind, template?: (typeof templates)[number]) {
    resetForm();
    setKnowledgeLoading(true); setKnowledgeError("");
    if (template) {
      setName(template.name); setAgentId(template.id); setIdEdited(true); setDescription(template.description);
      setWechatSubtypeValue(template.agentType); setRoleIds([...template.roleIds]);
    } else if (kind === "wechat") {
      setRoleIds(["wechat-service"]);
    }
    setCreateKind(kind);
  }

  function changeName(value: string) {
    setName(value);
    if (!idEdited) setAgentId(generatedId(value));
  }

  function updatePermission(key: keyof AgentPermissions, value: boolean) {
    setPermissions((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    if (!createKind) return;
    const cleanName = name.trim();
    const cleanId = agentId.trim();
    if (!cleanName) { setError("请先填写智能体名称。"); return; }
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
        body.permissions = permissions;
      } else {
        body.agentType = wechatSubtypeValue;
      }
      const response = await fetch(endpoint, {
        method: "POST",
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
      setRoster(payload.data as CowAgentRoster);
      setView(createKind);
      setAutoBindAgentId(createKind === "wechat" && wechatSubtypeValue === "weixin_personal" ? cleanId : "");
      setSelectedAgentId(cleanId);
      setCreateKind(null); resetForm();
      onToast?.(createKind === "local"
        ? "本地 Agent“" + cleanName + "”已创建" + avatarWarning
        : "微信 Agent“" + cleanName + "”已创建，等待绑定 WeixinClawBot" + avatarWarning);
      if (avatar) await load();
    } catch (issue) { setError(issue instanceof Error ? issue.message : "智能体创建失败"); }
    finally { setSaving(false); }
  }

  async function removeAgent(agent: CowAgentProfile) {
    if (agent.id === roster.defaultAgentId) return;
    const kind = agentKind(agent);
    const message = "确定删除智能体“" + agent.name + "”吗？\n\n" + (kind === "local" ? "将同时移除它的本地工作空间。" : "将同时解除对应微信通道绑定。") + "\n此操作无法撤销。";
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
      setAutoBindAgentId("");
      onToast?.("智能体“" + agent.name + "”已删除");
    } catch (issue) { setError(issue instanceof Error ? issue.message : "智能体删除失败"); }
    finally { setDeleting(false); }
  }

  const localAgents = useMemo(() => roster.agents.filter((agent) => agentKind(agent) === "local"), [roster.agents]);
  const wechatAgents = useMemo(() => roster.agents.filter((agent) => agentKind(agent) === "wechat"), [roster.agents]);
  const visibleAgents = view === "local" ? localAgents : wechatAgents;
  const selectedAgent = visibleAgents.find((agent) => agent.id === selectedAgentId) ?? visibleAgents[0];
  const enabledCount = visibleAgents.filter((agent) => agent.enabled).length;
  const selectedSubtype = selectedAgent ? wechatSubtype(selectedAgent) : "weixin_personal";
  const selectedKnowledgeIds = parseKnowledgeIds(knowledgeBaseText);

  return <div className={styles.root} data-testid="agent-management">
    <section className={styles.hero}>
      <div><small>LumaFlow 控制台 · Agent 管理</small><h2>两种 Agent，一个统一管理入口</h2><p>创建本地 Agent 处理电脑上的文件和任务，或创建微信 Agent 并部署到微信。微信 Agent 与 WeixinClawBot 一一对应。</p></div>
      <div className={styles.heroActions}><button type="button" className={styles.secondary} onClick={() => startCreate("local")}><Plus size={15} /> 创建本地 Agent</button><button type="button" className={styles.primary} onClick={() => startCreate("wechat")}><Plus size={15} /> 创建微信 Agent</button></div>
    </section>

    <div className={styles.viewBar}>
      <div className={styles.viewTabs} role="tablist" aria-label="Agent 类型">
        <button type="button" role="tab" aria-selected={view === "local"} onClick={() => setView("local")}><Bot size={14} /> 本地 Agent <em>{localAgents.length}</em></button>
        <button type="button" role="tab" aria-selected={view === "wechat"} onClick={() => setView("wechat")}><MessageCircle size={14} /> 微信 Agent <em>{wechatAgents.length}</em></button>
      </div>
      <button type="button" className={styles.secondary} disabled={loading} onClick={() => void load()}><RefreshCw size={13} /> 刷新后端</button>
    </div>

    {view === "wechat" && <section className={styles.templateSection}><div className={styles.toolbar}><div><h3>微信 Agent 快速模板</h3><span>模板只预填角色和微信类型，创建后仍可修改 Prompt 与知识库。</span></div></div><div className={styles.templates}>{templates.map((template) => <button type="button" key={template.id} onClick={() => startCreate("wechat", template)}><Plus size={12} /> {template.label}</button>)}</div></section>}

    <div className={styles.toolbar}><div><h3>{view === "local" ? "本地 Agent" : "微信 Agent"}</h3><span>{view === "local" ? "运行在当前电脑，使用授权的文件、Workspace 和本地工具。" : "部署到微信；每个微信 Agent 对应一个 WeixinClawBot，私人微信最多绑定 1 个。"}</span></div><strong className={styles.countLabel}>{enabledCount} 个运行中 · {visibleAgents.length} 个 Agent</strong></div>
    {error && !createKind && <p className={styles.error} role="alert">{error}</p>}
    {loading ? <div className={styles.empty}>正在读取 CowAgent 后端…</div> : visibleAgents.length && selectedAgent ? <section className={styles.workspace} aria-label={(view === "local" ? "本地" : "微信") + " Agent 列表"}>
      <aside className={styles.roster}><header><strong>{view === "local" ? "本地 Agent" : "微信 Agent"}</strong><button type="button" onClick={() => startCreate(view)}><Plus size={13} /> 新建</button></header>{visibleAgents.map((agent) => <button type="button" className={styles.rosterItem} aria-pressed={selectedAgent.id === agent.id} key={agent.id} data-highlight={autoBindAgentId === agent.id} onClick={() => setSelectedAgentId(agent.id)}><span className={styles.avatar}>{agent.avatar === "image" ? <img src={endpoint + "/" + encodeURIComponent(agent.id) + "/avatar?v=" + encodeURIComponent(agent.avatarRev || "0")} alt="" /> : initials(agent)}</span><span><strong>{agent.name}</strong><small>{view === "wechat" ? wechatSubtype(agent) === "wecom_group" ? "企业微信 Agent" : "私人微信 Agent" : agent.description || "本机文件与工具 Agent"}</small></span>{agent.id === roster.defaultAgentId && <em className={styles.badge}>默认</em>}</button>)}</aside>
      <article className={styles.detail}>
        <div className={styles.detailHeading}><div className={styles.detailAvatar}>{selectedAgent.avatar === "image" ? <img src={endpoint + "/" + encodeURIComponent(selectedAgent.id) + "/avatar?v=" + encodeURIComponent(selectedAgent.avatarRev || "0")} alt="" /> : initials(selectedAgent)}</div><div><h3>{selectedAgent.name}</h3><p>Agent ID · {selectedAgent.id}</p></div><span className={styles.runState} data-active={selectedAgent.enabled}><i />{selectedAgent.enabled ? "运行中" : "已停用"}</span></div>
        {view === "local" ? <>
          <div className={styles.detailTabs}><strong>本地 Agent 概况</strong><span>本机执行权限只对这个 Agent 生效</span></div>
          <dl className={styles.profileFields}><div><dt>类型</dt><dd>本地 Agent · 当前电脑执行</dd></div><div><dt>角色</dt><dd>{roleNames(selectedAgent)}</dd></div><div><dt>System Prompt</dt><dd className={styles.preWrap}>{selectedAgent.systemPrompt || "未设置额外 System Prompt，使用本机默认角色策略。"}</dd></div><div><dt>知识库</dt><dd>{knowledgeSummary(selectedAgent)}</dd></div><div><dt>Workspace</dt><dd className={styles.monospace}>{selectedAgent.workspace}</dd></div><div><dt>本地文件与工具权限</dt><dd><div className={styles.capabilityList}>{permissionLabels.map(([key, label]) => <span key={key} className={styles.capability} data-enabled={selectedAgent.permissions?.[key] !== false}>{selectedAgent.permissions?.[key] === false ? "×" : "✓"} {label}</span>)}</div></dd></div></dl>
          <div className={styles.detailActions}>{onWork && <button type="button" className={styles.primary} disabled={!selectedAgent.enabled} onClick={() => onWork(selectedAgent.id)}>开始 Work</button>}{selectedAgent.id !== roster.defaultAgentId && <button type="button" className={styles.danger} disabled={deleting} onClick={() => void removeAgent(selectedAgent)}><Trash2 size={14} /> {deleting ? "正在删除…" : "删除 Agent"}</button>}</div>
        </> : <>
          <div className={styles.detailTabs}><strong>微信 Agent 绑定</strong><span>网页和微信使用同一个 Agent ID：{selectedAgent.id}</span></div>
          <div className={styles.channelNotice}><strong>微信 Agent 与微信中的 WeixinClawBot 使用同一份 Agent 配置和数据。</strong><span>{selectedSubtype === "wecom_group" ? "这是企业微信 Agent；连接企业微信机器人后，它只处理已配置的群聊消息。" : "这是私人微信 Agent；一个私人微信账号最多绑定一个微信 Agent。"}</span></div>
          <dl className={styles.profileFields}><div><dt>类型</dt><dd>微信 Agent</dd></div><div><dt>微信类型</dt><dd>{selectedSubtype === "wecom_group" ? "企业微信 / 其他" : "私人微信"}</dd></div><div><dt>WeixinClawBot</dt><dd className={styles.monospace}>{selectedAgent.wechat?.instanceId || (selectedSubtype === "wecom_group" ? "wecom-" : "weixin-") + selectedAgent.id} · Agent ID {selectedAgent.id}</dd></div><div><dt>角色</dt><dd>{roleNames(selectedAgent)}</dd></div><div><dt>System Prompt</dt><dd className={styles.preWrap}>{selectedAgent.systemPrompt || "未设置额外 System Prompt，使用微信 Agent 默认角色策略。"}</dd></div><div><dt>知识库</dt><dd>{knowledgeSummary(selectedAgent)}</dd></div></dl>
          <div className={styles.bindingCard}><div className={styles.channelIcon}>{selectedSubtype === "wecom_group" ? <Bot size={22} /> : <MessageCircle size={22} />}</div><div><strong>WeixinClawBot · {selectedAgent.id}</strong><p>{selectedAgent.enabled ? "完成绑定后，微信消息会路由到这个微信 Agent；两端共享同一份配置。" : "请先启用这个 Agent。"}</p></div>{selectedSubtype === "wecom_group" ? <CowAgentWecomDeployment key={selectedAgent.id} agentId={selectedAgent.id} agentName={selectedAgent.name} disabled={!selectedAgent.enabled} /> : <CowAgentWeixinDeployment key={selectedAgent.id} agentId={selectedAgent.id} agentName={selectedAgent.name} disabled={!selectedAgent.enabled} autoStart={autoBindAgentId === selectedAgent.id} onAutoStartHandled={() => setAutoBindAgentId("")} />}</div>
          {selectedAgent.id !== roster.defaultAgentId && <div className={styles.channelActions}><button type="button" className={styles.danger} disabled={deleting} onClick={() => void removeAgent(selectedAgent)}><Trash2 size={14} /> {deleting ? "正在删除…" : "删除 Agent"}</button></div>}
        </>}
      </article>
    </section> : <div className={styles.empty}>{view === "local" ? "暂无本地 Agent。创建一个 Agent，让它帮助你处理本机文件和任务。" : "暂无微信 Agent。创建后可绑定微信并通过 WeixinClawBot 使用。"}</div>}

    {createKind && <div className={styles.modal} role="dialog" aria-modal="true" aria-label={"创建" + (createKind === "local" ? "本地" : "微信") + " Agent"}><button type="button" className={styles.scrim} aria-label="关闭创建 Agent" onClick={() => !saving && setCreateKind(null)} /><section className={styles.panel}>
      <header className={styles.modalHeader}><div><small>{createKind === "local" ? "LOCAL AGENT" : "WECHAT AGENT"}</small><h2>创建{createKind === "local" ? "本地" : "微信"} Agent</h2><p>{createKind === "local" ? "运行在当前电脑，拥有你授权的文件、Workspace 和本地工具权限。" : "部署到微信中的对话 Agent；创建后可绑定对应的 WeixinClawBot。"}</p></div><button type="button" className={styles.iconButton} aria-label="关闭" disabled={saving} onClick={() => setCreateKind(null)}><X size={18} /></button></header>
      <div className={styles.form}>
        <label className={styles.field}>名称<input aria-label="名称" autoFocus required value={name} maxLength={80} placeholder={createKind === "local" ? "例如：销售资料助手" : "例如：微信销售助手"} onChange={(event) => changeName(event.target.value)} /></label>
        <div className={styles.twoColumns}><label className={styles.field}>Agent ID<input aria-label="Agent ID" required value={agentId} maxLength={64} placeholder={createKind === "local" ? "local-sales" : "wechat-service"} onChange={(event) => { setIdEdited(true); setAgentId(event.target.value); }} /><small>创建后保持稳定；微信 Agent 会使用它连接对应 WeixinClawBot。</small></label><label className={styles.field}>从已有 Agent 复制<select value={cloneFrom} onChange={(event) => setCloneFrom(event.target.value)}><option value="">不复制，只使用基础设置</option>{roster.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><small>只复制角色设定，不复制聊天记录和秘密。</small></label></div>
        <div className={styles.field}><span>角色</span><div className={styles.roleGrid}>{AGENT_ROLES.map((role) => { const selected = roleIds.includes(role.id); return <button type="button" key={role.id} data-active={selected} aria-pressed={selected} onClick={() => setRoleIds((current) => selected ? current.length > 1 ? current.filter((id) => id !== role.id) : current : [...current, role.id])}><strong>{role.name}</strong><small>{role.description}</small></button>; })}</div><small>可选择多个角色；角色决定 Agent 的工作职责，权限由下面的独立设置控制。</small></div>
        <label className={styles.field}>System Prompt<textarea aria-label="System Prompt" value={systemPrompt} maxLength={12_000} placeholder={createKind === "local" ? "描述它的身份、工作边界和回答方式…" : "描述它在微信对话中的身份、语气和工作边界…"} onChange={(event) => setSystemPrompt(event.target.value)} /></label>
        <label className={styles.field}>知识库<textarea aria-label="知识库" value={knowledgeBaseText} maxLength={10_000} placeholder="输入知识库 ID，用逗号或换行分隔；留空使用共享知识库" onChange={(event) => setKnowledgeBaseText(event.target.value)} /><small>从下面的现有文件勾选，或粘贴明确的知识库 ID。空白不会被前端自行推断。</small></label>
        <div className={styles.knowledgePicker} aria-label="现有知识库列表"><div className={styles.knowledgePickerHead}><strong>现有知识库文件</strong><small>{knowledgeLoading ? "正在读取…" : knowledgeOptions.length ? "勾选后会写入 knowledgeBaseIds" : "暂无可选择文件"}</small></div>{knowledgeOptions.length ? <div className={styles.knowledgeOptions}>{knowledgeOptions.map((option) => <label key={option.id}><input type="checkbox" checked={selectedKnowledgeIds.includes(option.id)} onChange={(event) => { const next = event.target.checked ? [...selectedKnowledgeIds, option.id] : selectedKnowledgeIds.filter((id) => id !== option.id); setKnowledgeBaseText(next.join("\n")); }} /><span><strong>{option.title}</strong><small>{option.originalName ? option.originalName + " · " : ""}{option.id}</small></span></label>)}</div> : <p>{knowledgeError || "启动知识库或上传文件后，这里会显示可授权的 ID。"}</p>}</div>
        <div className={styles.field}><span>知识库范围</span><div className={styles.segments}><button type="button" data-active={knowledgeMode === "shared"} onClick={() => setKnowledgeMode("shared")}>共享团队知识库</button><button type="button" data-active={knowledgeMode === "own"} onClick={() => setKnowledgeMode("own")}>独立知识库</button></div></div>
        {createKind === "local" ? <>
          <label className={styles.field}>工作空间<input aria-label="工作空间" value={workspace} maxLength={2_000} placeholder="留空则自动创建 agents/&lt;agent-id&gt; Workspace" onChange={(event) => setWorkspace(event.target.value)} /><small>可以填写已授权的本机路径；留空由 CowAgent 在本机为这个 Agent 创建独立 Workspace。</small></label>
          <label className={styles.field}>额外授权目录<textarea aria-label="额外授权目录" value={allowedPathsText} maxLength={10_000} placeholder={"每行一个绝对路径，例如 C:\\Users\\你的名字\\Downloads"} onChange={(event) => setAllowedPathsText(event.target.value)} /><small>这些目录会加入本地 Agent 的授权范围；Workspace 内文件默认可用。PowerShell 与本地工具仍使用当前 Windows 账户权限。</small></label>
          <fieldset className={styles.permissionField}><legend>本地文件权限</legend><div className={styles.permissionGrid}>{permissionLabels.map(([key, label]) => <label key={key} className={styles.permissionCard}><input type="checkbox" checked={permissions[key]} onChange={(event) => updatePermission(key, event.target.checked)} /><span>{label}</span></label>)}</div><small>这些权限只授予本地 Agent。它们决定是否可以读取、创建、修改、删除文件及使用本地工具。</small></fieldset>
        </> : <fieldset className={styles.permissionField}><legend>微信类型</legend><div className={styles.radioGrid} role="radiogroup" aria-label="微信类型"><label className={styles.radioCard}><input type="radio" name="wechat-agent-type" value="personal" checked={wechatSubtypeValue === "weixin_personal"} onChange={() => setWechatSubtypeValue("weixin_personal")} /><span><strong>私人微信</strong><small>一个私人微信账号最多绑定一个微信 Agent。</small></span></label><label className={styles.radioCard}><input type="radio" name="wechat-agent-type" value="other" checked={wechatSubtypeValue === "wecom_group"} onChange={() => setWechatSubtypeValue("wecom_group")} /><span><strong>企业微信 / 其他</strong><small>创建后使用企业微信机器人凭据完成绑定。</small></span></label></div><small>微信 Agent 不拥有本机文件权限；它只负责微信对话和通道消息。</small></fieldset>}
        <div className={styles.field}><span>头像（可选）</span><div className={styles.avatarRow}><button type="button" className={styles.avatarPick} onClick={() => fileInput.current?.click()}>{avatarPreview ? <img src={avatarPreview} alt="头像预览" /> : <Upload size={19} />}</button><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (avatarPreview) URL.revokeObjectURL(avatarPreview); setAvatar(file); setAvatarPreview(URL.createObjectURL(file)); }} /><span>PNG、JPG、WebP 或 GIF<br />最大 2 MB</span></div></div>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
      <footer className={styles.footer}><button type="button" className={styles.secondary} disabled={saving} onClick={() => setCreateKind(null)}>取消</button><button type="button" className={styles.primary} disabled={saving} onClick={() => void submit()}>{saving ? "正在创建…" : <><CheckCircle2 size={15} /> {createKind === "local" ? "创建本地 Agent" : "创建并绑定微信"}</>}</button></footer>
    </section></div>}
  </div>;
}
