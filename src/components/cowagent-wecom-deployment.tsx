"use client";

import { Bot, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CowAgentWecomState } from "@/lib/contracts/cowagent-wecom";
import styles from "./cowagent-wecom-deployment.module.css";

const endpoint = "/api/v1/integrations/cowagent/wecom";

function emptyState(agentId: string): CowAgentWecomState {
  return { engine: "CowAgent", instanceId: `wecom-${agentId}`, boundAgentId: agentId, active: false, keywordEnabled: false, keywords: [], recipients: [], tasks: [] };
}

async function call(agentId: string, body?: Record<string, unknown>, signal?: AbortSignal) {
  const instanceId = `wecom-${agentId}`;
  const response = await fetch(body ? endpoint : `${endpoint}?${new URLSearchParams({ agentId, instanceId })}`, {
    method: body ? "POST" : "GET", cache: "no-store", signal,
    headers: { Accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify({ ...body, agentId, instanceId }) } : {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || "企业微信接口未就绪");
  return payload.data as CowAgentWecomState;
}

export function CowAgentWecomDeployment({ agentId, agentName, disabled = false }: { agentId: string; agentName: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(() => emptyState(agentId));
  const [botId, setBotId] = useState("");
  const [secret, setSecret] = useState("");
  const [keywordEnabled, setKeywordEnabled] = useState(false);
  const [keywords, setKeywords] = useState("");
  const [taskName, setTaskName] = useState("");
  const [taskContent, setTaskContent] = useState("");
  const [receiver, setReceiver] = useState("");
  const [scheduleType, setScheduleType] = useState<"once" | "cron" | "interval">("once");
  const [scheduleValue, setScheduleValue] = useState("");
  const [taskEnabled, setTaskEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await call(agentId, undefined, signal);
      setState(next); setKeywordEnabled(next.keywordEnabled); setKeywords(next.keywords.join(", ")); setError("");
    } catch (issue) { if (!signal?.aborted) setError(issue instanceof Error ? issue.message : "CowAgent 后端未连接"); }
  }, [agentId]);

  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); if (!open && dialog.current?.open) dialog.current.close(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { void refresh(controller.signal); }, 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, refresh]);

  async function run(body: Record<string, unknown>) {
    if (pending || disabled) return;
    setPending(true); setError("");
    try { setState(await call(agentId, body)); }
    catch (issue) { setError(issue instanceof Error ? issue.message : "企业微信操作失败"); }
    finally { setPending(false); }
  }

  function keywordList() { return keywords.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean); }
  function schedule() {
    if (scheduleType === "cron") return { type: "cron", expression: scheduleValue.trim() };
    if (scheduleType === "interval") return { type: "interval", seconds: Number(scheduleValue) };
    return { type: "once", runAt: new Date(scheduleValue).toISOString() };
  }

  return <div className={styles.root}>
    <button type="button" className={styles.trigger} data-connected={state.active} disabled={disabled} onClick={() => setOpen(true)}><Bot size={14} /> 企业微信群 Agent · {state.active ? "已连接" : "配置"}</button>
    <dialog ref={dialog} className={styles.dialog} aria-label={`配置企业微信群 Agent ${agentName}`} onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <header><div><h2>企业微信群 Agent · {agentName}</h2><p>实例 {state.instanceId} · 只处理群聊</p></div><button type="button" aria-label="关闭" onClick={() => setOpen(false)}><X size={18} /></button></header>
      {!state.active ? <section className={styles.section}><h3>连接企业微信智能机器人</h3><p>在企业微信工作台创建“API 模式、长连接”智能机器人，然后填写凭据。</p><label>Bot ID<input value={botId} onChange={(event) => setBotId(event.target.value)} autoComplete="off" /></label><label>Secret<input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" /></label><button type="button" disabled={pending || !botId.trim() || !secret.trim()} onClick={() => void run({ action: "connect", botId: botId.trim(), botSecret: secret.trim(), keywordEnabled, keywords: keywordList() })}>连接并绑定 Agent</button></section> : <>
        <section className={styles.section}><h3>群聊触发规则</h3><p>群聊被 @ 时回复。关键词只对企业微信实际投递给机器人的群消息生效。</p><label className={styles.check}><input type="checkbox" checked={keywordEnabled} onChange={(event) => setKeywordEnabled(event.target.checked)} />启用关键词</label><label>关键词（逗号分隔）<input value={keywords} disabled={!keywordEnabled} onChange={(event) => setKeywords(event.target.value)} placeholder="报价, 库存, 参数" /></label><button type="button" disabled={pending} onClick={() => void run({ action: "update-policy", keywordEnabled, keywords: keywordList() })}>保存触发规则</button></section>
        <section className={styles.section}><div className={styles.titleRow}><h3>自动任务</h3><button type="button" onClick={() => void refresh()}><RefreshCw size={13} />刷新</button></div><p>机器人在目标群第一次被 @ 后，该群才会进入可信接收列表。新任务默认关闭。</p><label>目标群<select value={receiver} onChange={(event) => setReceiver(event.target.value)}><option value="">请选择已验证群聊</option>{state.recipients.map((item) => <option key={item.receiver} value={item.receiver}>{item.name}</option>)}</select></label><label>任务名称<input value={taskName} onChange={(event) => setTaskName(event.target.value)} /></label><label>发送内容<textarea value={taskContent} onChange={(event) => setTaskContent(event.target.value)} /></label><div className={styles.row}><label>计划<select value={scheduleType} onChange={(event) => setScheduleType(event.target.value as typeof scheduleType)}><option value="once">单次</option><option value="cron">Cron</option><option value="interval">间隔秒数</option></select></label><label>时间 / 表达式<input type={scheduleType === "once" ? "datetime-local" : "text"} value={scheduleValue} onChange={(event) => setScheduleValue(event.target.value)} placeholder={scheduleType === "cron" ? "0 9 * * 1-5" : scheduleType === "interval" ? "3600" : ""} /></label></div><label className={styles.check}><input type="checkbox" checked={taskEnabled} onChange={(event) => setTaskEnabled(event.target.checked)} />创建后立即启用</label><button type="button" disabled={pending || !receiver || !taskName.trim() || !taskContent.trim() || !scheduleValue} onClick={() => void run({ action: "create-task", name: taskName.trim(), receiver, content: taskContent.trim(), enabled: taskEnabled, schedule: schedule() })}>创建自动任务</button>{state.tasks.map((task) => <div className={styles.task} key={task.id}><span><strong>{task.name}</strong><small>{task.nextRunAt || "暂无下次运行时间"}</small></span><button type="button" disabled={pending} onClick={() => void run({ action: "toggle-task", taskId: task.id, enabled: !task.enabled })}>{task.enabled ? "停用" : "启用"}</button></div>)}</section>
        <button type="button" className={styles.danger} disabled={pending} onClick={() => void run({ action: "disconnect" })}>解除企业微信绑定</button>
      </>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <small>Secret 只发送到本机 CowAgent 并写入本地配置，不会进入浏览器存储或 GitHub。</small>
    </dialog>
  </div>;
}
