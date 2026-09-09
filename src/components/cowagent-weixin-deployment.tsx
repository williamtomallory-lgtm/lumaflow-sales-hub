"use client";

/* eslint-disable @next/next/no-img-element -- QR codes are short-lived data URLs returned by the local CowAgent runtime. */

import { MessageCircle, QrCode, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CowAgentWeixinState } from "@/lib/contracts/cowagent-weixin";
import styles from "./cowagent-weixin-deployment.module.css";

const endpoint = "/api/v1/integrations/cowagent/weixin";

async function request(agentId: string, action?: "create-qr" | "poll" | "disconnect", signal?: AbortSignal) {
  const instanceId = `weixin-${agentId}`;
  const response = await fetch(action ? endpoint : `${endpoint}?${new URLSearchParams({ agentId, instanceId })}`, {
    method: action ? "POST" : "GET",
    cache: "no-store",
    headers: { Accept: "application/json", ...(action ? { "content-type": "application/json" } : {}) },
    ...(action ? { body: JSON.stringify({ action, agentId, instanceId }) } : {}),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || "CowAgent 微信接口未就绪");
  return payload.data as CowAgentWeixinState;
}

export function CowAgentWeixinDeployment({ agentId, agentName, disabled = false }: { agentId: string; agentName: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CowAgentWeixinState>({ engine: "CowAgent", phase: "idle", active: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [pollTick, setPollTick] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const polling = state.phase === "waiting" || state.phase === "scanned";

  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    try { setState(await request(agentId, undefined, signal)); setError(""); }
    catch (issue) { if (!signal?.aborted) setError(issue instanceof Error ? issue.message : "CowAgent 后端未连接"); }
  }, [agentId]);

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { void refreshStatus(controller.signal); }, 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, refreshStatus]);

  useEffect(() => {
    if (!open || !polling) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const next = await request(agentId, "poll", controller.signal);
        setState((current) => ({ ...current, ...next, qrImage: next.qrImage || current.qrImage, qrUrl: next.qrUrl || current.qrUrl }));
        setPollTick((tick) => tick + 1);
        setError("");
      } catch (issue) {
        if (!controller.signal.aborted) {
          setError(issue instanceof Error ? issue.message : "微信扫码状态读取失败");
          setPollTick((tick) => tick + 1);
        }
      }
    }, 2_000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [agentId, open, polling, pollTick]);

  async function run(action: "create-qr" | "disconnect") {
    if (pending || disabled) return;
    setPending(true); setError("");
    try { setState(await request(agentId, action)); }
    catch (issue) { setError(issue instanceof Error ? issue.message : "微信 Agent 操作失败"); }
    finally { setPending(false); }
  }

  const connected = state.phase === "connected" && (!state.boundAgentId || state.boundAgentId === agentId);
  const occupied = state.phase === "connected" && Boolean(state.boundAgentId) && state.boundAgentId !== agentId;
  return <div className={styles.root}>
    <button type="button" className={styles.trigger} data-connected={connected} disabled={disabled} onClick={() => setOpen(true)}>
      <span className={styles.dot} /> <MessageCircle size={14} /> {connected ? "微信已绑定" : occupied ? "微信已被其他 Agent 使用" : "绑定微信"}
    </button>
    <dialog ref={dialog} className={styles.dialog} aria-label="部署微信客服 Agent" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <header><div><h2>绑定微信 · {agentName}</h2><p>微信消息将路由到 Agent ID：{agentId}</p></div><button type="button" className={styles.close} aria-label="关闭微信 Agent 部署" onClick={() => setOpen(false)}><X size={18} /></button></header>
      {connected ? <div className={styles.success}><MessageCircle size={22} /><strong>已绑定到这个智能体</strong><p>微信消息会交给“{agentName}”处理，并调用它的本地模型和知识库。</p></div> : occupied ? <div className={styles.success}><MessageCircle size={22} /><strong>当前微信已绑定其他智能体</strong><p>请先在 Agent“{state.boundAgentId}”的卡片中停止微信连接，再绑定到这里。</p></div> : <>
        <div className={styles.status}><span className={styles.dot} /><span>{pending ? "正在请求 CowAgent…" : state.phase === "scanned" ? "已扫码，请在手机微信确认" : polling ? "等待你使用手机微信扫码" : "尚未登录微信"}</span></div>
        {(state.qrImage || state.qrUrl) && <img className={styles.qr} src={state.qrImage || state.qrUrl} alt="微信客服 Agent 登录二维码" />}
        <div className={styles.actions}><button type="button" disabled={pending} onClick={() => void run("create-qr")}>{state.qrImage || state.qrUrl ? <><RefreshCw size={13} /> 刷新二维码</> : <><QrCode size={13} /> 生成登录二维码</>}</button></div>
      </>}
      {connected && <div className={styles.actions}><button type="button" disabled={pending} onClick={() => void run("disconnect")}>解除微信绑定</button></div>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <small className={styles.boundary}>二维码必须由你本人扫码确认。这里不会索取微信密码；停止 Agent 不会删除聊天记录或本地知识库。</small>
    </dialog>
  </div>;
}
