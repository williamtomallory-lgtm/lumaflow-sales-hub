"use client";

/* eslint-disable @next/next/no-img-element -- CowAgent avatars use authenticated runtime URLs and local blob previews. */

import { CheckCircle2, Plus, RefreshCw, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CowAgentProfile, CowAgentRoster } from "@/lib/contracts/cowagent-agent";
import { CowAgentWeixinDeployment } from "./cowagent-weixin-deployment";
import { CowAgentWecomDeployment } from "./cowagent-wecom-deployment";
import styles from "./agent-management.module.css";

const endpoint = "/api/v1/cowagent/agents";
const templates = [
  { label: "个人微信客服", id: "wechat-service", name: "个人微信客服 Agent", agentType: "weixin_personal", description: "只处理个人微信私聊，负责客户咨询、需求提炼、资料查询与待确认回复草稿。" },
  { label: "群聊销售助手", id: "group-sales", name: "群聊销售 Agent", agentType: "wecom_group", description: "只处理企业微信群聊，被 @ 或命中已启用关键词时回复，并执行明确启用的定时任务。" },
  { label: "个人销售复盘", id: "sales-review", name: "个人销售复盘 Agent", agentType: "weixin_personal", description: "在个人微信场景总结聊天和跟进过程，识别问题并形成下一步行动清单。" },
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
  return slug || `agent-${Date.now().toString(36)}`;
}

export function AgentManagement({ onToast }: { onToast?: (message: string) => void }) {
  const [roster, setRoster] = useState<CowAgentRoster>({ agents: [], defaultAgentId: "", revision: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [cloneFrom, setCloneFrom] = useState("");
  const [knowledgeMode, setKnowledgeMode] = useState<"shared" | "own">("shared");
  const [agentType, setAgentType] = useState<"weixin_personal" | "wecom_group">("weixin_personal");
  const [avatar, setAvatar] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState("");
  const [saving, setSaving] = useState(false);
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

  function resetForm() {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    setName(""); setAgentId(""); setIdEdited(false); setDescription(""); setCloneFrom(""); setKnowledgeMode("shared"); setAgentType("weixin_personal"); setAvatar(null); setAvatarPreview(""); setError("");
  }

  function startCreate(template?: (typeof templates)[number]) {
    resetForm();
    if (template) { setName(template.name); setAgentId(template.id); setIdEdited(true); setDescription(template.description); setAgentType(template.agentType); }
    setOpen(true);
  }

  function changeName(value: string) {
    setName(value);
    if (!idEdited) setAgentId(generatedId(value));
  }

  async function submit() {
    const cleanName = name.trim();
    const cleanId = agentId.trim();
    if (!cleanName) { setError("请先填写智能体名称。"); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(cleanId)) { setError("ID 只能包含英文字母、数字、下划线或短横线，并以字母或数字开头。"); return; }
    setSaving(true); setError("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ id: cleanId, name: cleanName, description: description.trim(), cloneFrom: cloneFrom || null, knowledgeMode, agentType, revision: roster.revision || undefined }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "智能体创建失败");
      let avatarWarning = "";
      if (avatar) {
        const form = new FormData(); form.append("avatar", avatar, avatar.name);
        const avatarResponse = await fetch(`${endpoint}/${encodeURIComponent(cleanId)}/avatar`, { method: "POST", body: form });
        if (!avatarResponse.ok) avatarWarning = "，但头像暂未保存";
      }
      setRoster(payload.data as CowAgentRoster);
      setOpen(false); resetForm();
      onToast?.(`智能体“${cleanName}”已创建${avatarWarning}`);
      if (avatar) await load();
    } catch (issue) { setError(issue instanceof Error ? issue.message : "智能体创建失败"); }
    finally { setSaving(false); }
  }

  const enabledCount = useMemo(() => roster.agents.filter((agent) => agent.enabled).length, [roster.agents]);
  return <div className={styles.root} data-testid="agent-management">
    <section className={styles.hero}><div><small>CowAgent · 本地智能体团队</small><h2>创建并管理你的智能体</h2><p>每个智能体拥有独立身份和工作空间，可共享知识库，也可绑定微信。所有运行都由本机 CowAgent 与 Qwen 模型负责。</p></div><button type="button" className={styles.primary} onClick={() => startCreate()}><Plus size={16} /> 创建智能体</button></section>
    <section><div className={styles.toolbar}><div><h3>推荐角色</h3><span>点选模板后仍可修改名称、职责和知识库模式</span></div></div><div className={styles.templates}>{templates.map((template) => <button type="button" key={template.id} onClick={() => startCreate(template)}><Plus size={12} /> {template.label}</button>)}</div></section>
    <div className={styles.toolbar}><div><h3>我的智能体</h3><span>{enabledCount} 个正在使用 · {roster.agents.length} 个工作空间</span></div><button type="button" className={styles.secondary} disabled={loading} onClick={() => void load()}><RefreshCw size={13} /> 刷新</button></div>
    {error && !open && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.grid}>{loading ? <div className={styles.empty}>正在读取 CowAgent 智能体…</div> : roster.agents.length ? roster.agents.map((agent) => <article className={styles.card} key={agent.id}>
      <div className={styles.cardTop}><div className={styles.avatar}>{agent.avatar === "image" ? <img src={`${endpoint}/${encodeURIComponent(agent.id)}/avatar?v=${encodeURIComponent(agent.avatarRev || "0")}`} alt="" /> : initials(agent)}</div><div className={styles.identity}><strong>{agent.name}</strong><span>{agent.id}</span></div>{agent.id === roster.defaultAgentId && <em className={styles.badge}>默认</em>}</div>
      <p className={styles.description}>{agent.description || "尚未填写职责；可作为通用 CowAgent 使用。"}</p>
      {agent.botType === "weixin_personal" && <CowAgentWeixinDeployment agentId={agent.id} agentName={agent.name} disabled={!agent.enabled} />}
      {agent.botType === "wecom_group" && <CowAgentWecomDeployment agentId={agent.id} agentName={agent.name} disabled={!agent.enabled} />}
      <div className={styles.meta}><span>{agent.botType === "wecom_group" ? "群聊 Agent" : agent.botType === "weixin_personal" ? "个人 Agent" : "通用 Agent"}</span><span>{agent.knowledgeMode === "own" ? "独立知识库" : "共享知识库"}</span><span>{agent.model || "Qwen3 8B · 默认模型"}</span><span>{agent.enabled ? "运行中" : "已停用"}</span></div>
    </article>) : <div className={styles.empty}>CowAgent 尚未返回智能体。点击“创建智能体”开始。</div>}</div>

    {open && <div className={styles.modal} role="dialog" aria-modal="true" aria-label="创建智能体"><button type="button" className={styles.scrim} aria-label="关闭创建智能体" onClick={() => !saving && setOpen(false)} /><section className={styles.panel}>
      <header><h2>创建智能体</h2><button type="button" className={styles.iconButton} aria-label="关闭" disabled={saving} onClick={() => setOpen(false)}><X size={18} /></button></header>
      <div className={styles.form}>
        <label className={styles.field}>名称<input autoFocus value={name} maxLength={80} placeholder="例如：微信客服 Agent" onChange={(event) => changeName(event.target.value)} /></label>
        <div className={styles.field}><span>头像</span><div className={styles.avatarRow}><button type="button" className={styles.avatarPick} onClick={() => fileInput.current?.click()}>{avatarPreview ? <img src={avatarPreview} alt="头像预览" /> : <Upload size={19} />}</button><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (avatarPreview) URL.revokeObjectURL(avatarPreview); setAvatar(file); setAvatarPreview(URL.createObjectURL(file)); }} /><span>PNG、JPG、WebP 或 GIF<br />最大 2 MB</span></div></div>
        <div className={styles.twoColumns}><label className={styles.field}>ID<input value={agentId} maxLength={64} placeholder="wechat-service" onChange={(event) => { setIdEdited(true); setAgentId(event.target.value); }} /><small>创建后保持稳定，用于微信绑定和任务路由。</small></label><label className={styles.field}>从已有智能体复制<select value={cloneFrom} onChange={(event) => setCloneFrom(event.target.value)}><option value="">不复制，只使用基础模板</option>{roster.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><small>只复制角色设定，不复制聊天记录和秘密。</small></label></div>
        <label className={styles.field}>职责<textarea value={description} maxLength={1_000} placeholder="说明这个智能体负责什么、不能做什么…" onChange={(event) => setDescription(event.target.value)} /></label>
        <div className={styles.field}><span>Agent 类型（创建后固定）</span><div className={styles.segments}><button type="button" data-active={agentType === "weixin_personal"} onClick={() => setAgentType("weixin_personal")}>个人微信 Agent</button><button type="button" data-active={agentType === "wecom_group"} onClick={() => setAgentType("wecom_group")}>群聊 Agent</button></div><small>个人类型只接个人微信私聊；群聊类型只接企业微信群聊机器人，不混用消息路由。</small></div>
        <div className={styles.field}><span>知识库</span><div className={styles.segments}><button type="button" data-active={knowledgeMode === "shared"} onClick={() => setKnowledgeMode("shared")}>共享</button><button type="button" data-active={knowledgeMode === "own"} onClick={() => setKnowledgeMode("own")}>独立</button></div><small>共享：读取团队知识；独立：拥有自己的知识目录，互不影响。</small></div>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
      <footer className={styles.footer}><button type="button" className={styles.secondary} disabled={saving} onClick={() => setOpen(false)}>取消</button><button type="button" className={styles.primary} disabled={saving} onClick={() => void submit()}>{saving ? "正在创建…" : <><CheckCircle2 size={15} /> 创建智能体</>}</button></footer>
    </section></div>}
  </div>;
}
