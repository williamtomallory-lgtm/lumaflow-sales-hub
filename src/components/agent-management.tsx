"use client";

/* eslint-disable @next/next/no-img-element -- CowAgent avatars use authenticated runtime URLs and local blob previews. */

import { Bot, CheckCircle2, MessageCircle, Plus, RefreshCw, Upload, X } from "lucide-react";
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
  const [view, setView] = useState<"agents" | "wechat">("agents");
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
      setView("wechat");
      setAutoBindAgentId(cleanId);
      setSelectedAgentId(cleanId);
      setOpen(false); resetForm();
      onToast?.(`智能体“${cleanName}”已创建并加入微信 Agent 列表${avatarWarning}`);
      if (avatar) await load();
    } catch (issue) { setError(issue instanceof Error ? issue.message : "智能体创建失败"); }
    finally { setSaving(false); }
  }

  const enabledCount = useMemo(() => roster.agents.filter((agent) => agent.enabled).length, [roster.agents]);
  const channelAgents = useMemo(() => roster.agents.filter((agent) => agent.botType === "weixin_personal" || agent.botType === "wecom_group"), [roster.agents]);
  const visibleAgents = view === "agents" ? roster.agents : channelAgents;
  const selectedAgent = visibleAgents.find((agent) => agent.id === selectedAgentId) ?? visibleAgents[0];
  return <div className={styles.root} data-testid="agent-management">
    <section className={styles.hero}><div><small>LumaFlow 控制台 · CowAgent 后端</small><h2>一个网站管理 Agent 与微信</h2><p>LumaFlow 是唯一管理入口；Agent 名单、工作空间和微信路由都以本机 CowAgent 后端为准。个人 Agent 创建后自动进入微信列表并生成专属二维码。</p></div><button type="button" className={styles.primary} onClick={() => startCreate()}><Plus size={16} /> 创建智能体</button></section>
    <section><div className={styles.toolbar}><div><h3>推荐角色</h3><span>点选模板后仍可修改名称、职责和知识库模式</span></div></div><div className={styles.templates}>{templates.map((template) => <button type="button" key={template.id} onClick={() => startCreate(template)}><Plus size={12} /> {template.label}</button>)}</div></section>
    <div className={styles.viewBar}><div className={styles.viewTabs} role="tablist" aria-label="Agent 管理栏目"><button type="button" role="tab" aria-selected={view === "agents"} onClick={() => setView("agents")}><Bot size={14} /> Agent 列表 <em>{roster.agents.length}</em></button><button type="button" role="tab" aria-selected={view === "wechat"} onClick={() => setView("wechat")}><MessageCircle size={14} /> 微信 Agent 列表 <em>{channelAgents.length}</em></button></div><button type="button" className={styles.secondary} disabled={loading} onClick={() => void load()}><RefreshCw size={13} /> 刷新后端</button></div>
    <div className={styles.toolbar}><div><h3>{view === "agents" ? "后端 Agent 名单" : "微信部署与登录"}</h3><span>{view === "agents" ? `${enabledCount} 个正在使用 · ${roster.agents.length} 个后端工作空间` : "创建、绑定、登录和路由使用同一份 CowAgent 数据"}</span></div></div>
    {error && !open && <p className={styles.error} role="alert">{error}</p>}
    {loading ? <div className={styles.empty}>正在读取 CowAgent 后端…</div> : visibleAgents.length && selectedAgent ? <section className={styles.workspace} aria-label={view === "agents" ? "后端 Agent 名单" : "微信 Agent 列表"}>
      <aside className={styles.roster}><header><strong>{view === "agents" ? "智能体团队" : "微信 Agent"}</strong><button type="button" onClick={() => startCreate()}><Plus size={13} /> 新建</button></header>{visibleAgents.map((agent) => <button type="button" className={styles.rosterItem} aria-pressed={selectedAgent.id === agent.id} key={agent.id} data-highlight={autoBindAgentId === agent.id} onClick={() => setSelectedAgentId(agent.id)}><span className={styles.avatar}>{agent.avatar === "image" ? <img src={`${endpoint}/${encodeURIComponent(agent.id)}/avatar?v=${encodeURIComponent(agent.avatarRev || "0")}`} alt="" /> : initials(agent)}</span><span><strong>{agent.name}</strong><small>{view === "wechat" ? agent.botType === "wecom_group" ? "企业微信群 Agent" : "个人微信 Agent" : agent.description || agent.id}</small></span>{agent.id === roster.defaultAgentId && <em className={styles.badge}>默认</em>}</button>)}</aside>
      <article className={styles.detail}>
        <div className={styles.detailHeading}><div className={styles.detailAvatar}>{selectedAgent.avatar === "image" ? <img src={`${endpoint}/${encodeURIComponent(selectedAgent.id)}/avatar?v=${encodeURIComponent(selectedAgent.avatarRev || "0")}`} alt="" /> : initials(selectedAgent)}</div><div><h3>{selectedAgent.name}</h3><p>Agent ID · {selectedAgent.id}</p></div><span className={styles.runState} data-active={selectedAgent.enabled}><i />{selectedAgent.enabled ? "后端运行中" : "已停用"}</span></div>
        {view === "agents" ? <>
          <div className={styles.detailTabs}><strong>概况</strong><span>能力由后端职责与受控工具决定</span></div>
          <dl className={styles.profileFields}><div><dt>职责</dt><dd>{selectedAgent.description || "尚未填写职责；当前使用通用销售 Agent 策略。"}</dd></div><div><dt>Agent 类型</dt><dd>{selectedAgent.botType === "wecom_group" ? "群聊 Agent · 企业微信" : selectedAgent.botType === "weixin_personal" ? "个人 Agent · 微信" : "通用 Agent"}</dd></div><div><dt>默认模型</dt><dd>{selectedAgent.model || "跟随本机全局配置 · Qwen3 8B"}</dd></div><div><dt>知识库</dt><dd>{selectedAgent.knowledgeMode === "own" ? "独立知识库" : "共享团队知识库"}</dd></div><div><dt>后端工作空间</dt><dd className={styles.monospace}>{selectedAgent.workspace}</dd></div></dl>
          {(selectedAgent.botType === "weixin_personal" || selectedAgent.botType === "wecom_group") && <button type="button" className={styles.primary} onClick={() => { setView("wechat"); setSelectedAgentId(selectedAgent.id); }}>管理微信绑定</button>}
        </> : <>
          <div className={styles.detailTabs}><strong>微信绑定</strong><span>{selectedAgent.botType === "wecom_group" ? `实例 wecom-${selectedAgent.id}` : `实例 weixin-${selectedAgent.id}`}</span></div>
          <div className={styles.channelNotice}><strong>创建 ≠ 已成为微信好友</strong><span>{selectedAgent.botType === "wecom_group" ? "群聊 Agent 需要在企业微信创建智能机器人并填写独立 Bot ID / Secret。" : "扫码是让一个真实微信账号登录此 Agent。若要在微信中看到多个不同联系人，每个 Agent 必须绑定不同的真实微信账号。"}</span></div>
          <div className={styles.bindingCard}><div className={styles.channelIcon}>{selectedAgent.botType === "wecom_group" ? <Bot size={22} /> : <MessageCircle size={22} />}</div><div><strong>{selectedAgent.botType === "wecom_group" ? "企业微信群通道" : "个人微信通道"}</strong><p>{selectedAgent.enabled ? "Agent 已创建；完成下面的绑定后，消息才会路由到它。" : "请先启用这个 Agent。"}</p></div>{selectedAgent.botType === "wecom_group" ? <CowAgentWecomDeployment key={selectedAgent.id} agentId={selectedAgent.id} agentName={selectedAgent.name} disabled={!selectedAgent.enabled} /> : <CowAgentWeixinDeployment key={selectedAgent.id} agentId={selectedAgent.id} agentName={selectedAgent.name} disabled={!selectedAgent.enabled} autoStart={autoBindAgentId === selectedAgent.id} onAutoStartHandled={() => setAutoBindAgentId("")} />}</div>
        </>}
      </article>
    </section> : <div className={styles.empty}>{view === "wechat" ? "还没有个人微信或群聊 Agent。创建后会立即出现在这里。" : "CowAgent 尚未返回智能体。点击“创建智能体”开始。"}</div>}

    {open && <div className={styles.modal} role="dialog" aria-modal="true" aria-label="创建智能体"><button type="button" className={styles.scrim} aria-label="关闭创建智能体" onClick={() => !saving && setOpen(false)} /><section className={styles.panel}>
      <header><h2>创建智能体</h2><button type="button" className={styles.iconButton} aria-label="关闭" disabled={saving} onClick={() => setOpen(false)}><X size={18} /></button></header>
      <div className={styles.form}>
        <label className={styles.field}>名称<input autoFocus value={name} maxLength={80} placeholder="例如：微信客服 Agent" onChange={(event) => changeName(event.target.value)} /></label>
        <div className={styles.field}><span>头像</span><div className={styles.avatarRow}><button type="button" className={styles.avatarPick} onClick={() => fileInput.current?.click()}>{avatarPreview ? <img src={avatarPreview} alt="头像预览" /> : <Upload size={19} />}</button><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (avatarPreview) URL.revokeObjectURL(avatarPreview); setAvatar(file); setAvatarPreview(URL.createObjectURL(file)); }} /><span>PNG、JPG、WebP 或 GIF<br />最大 2 MB</span></div></div>
        <div className={styles.twoColumns}><label className={styles.field}>ID<input value={agentId} maxLength={64} placeholder="wechat-service" onChange={(event) => { setIdEdited(true); setAgentId(event.target.value); }} /><small>创建后保持稳定，用于微信绑定和任务路由。</small></label><label className={styles.field}>从已有智能体复制<select value={cloneFrom} onChange={(event) => setCloneFrom(event.target.value)}><option value="">不复制，只使用基础模板</option>{roster.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><small>只复制角色设定，不复制聊天记录和秘密。</small></label></div>
        <label className={styles.field}>职责<textarea value={description} maxLength={1_000} placeholder="说明这个智能体负责什么、不能做什么…" onChange={(event) => setDescription(event.target.value)} /></label>
        <div className={styles.field}><span>Agent 类型（创建后固定）</span><div className={styles.segments}><button type="button" data-active={agentType === "weixin_personal"} onClick={() => setAgentType("weixin_personal")}>个人微信 Agent</button><button type="button" data-active={agentType === "wecom_group"} onClick={() => setAgentType("wecom_group")}>群聊 Agent</button></div><small>{agentType === "weixin_personal" ? "创建后自动进入微信 Agent 列表并生成独立登录二维码；每个同时在线的 Agent 需要不同真实微信账号扫码。" : "创建后进入微信 Agent 列表，使用企业微信 Bot ID / Secret 绑定；群聊只在被 @ 或命中已启用关键词时回复。"}</small></div>
        <div className={styles.field}><span>知识库</span><div className={styles.segments}><button type="button" data-active={knowledgeMode === "shared"} onClick={() => setKnowledgeMode("shared")}>共享</button><button type="button" data-active={knowledgeMode === "own"} onClick={() => setKnowledgeMode("own")}>独立</button></div><small>共享：读取团队知识；独立：拥有自己的知识目录，互不影响。</small></div>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
      <footer className={styles.footer}><button type="button" className={styles.secondary} disabled={saving} onClick={() => setOpen(false)}>取消</button><button type="button" className={styles.primary} disabled={saving} onClick={() => void submit()}>{saving ? "正在创建…" : <><CheckCircle2 size={15} /> 创建智能体</>}</button></footer>
    </section></div>}
  </div>;
}
