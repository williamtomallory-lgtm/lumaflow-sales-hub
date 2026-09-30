"use client";
import { useEffect, useRef, useState } from "react";
import { MessageCircle, X } from "lucide-react";
import { formatWechatSnapshot, type WechatProbe, type WechatSnapshot } from "@/lib/contracts/wechat";
import styles from "./wechat-connection.module.css";

type Connection = { connectionId: string; chatLabel: string; loadedItems: number };
async function request(body?: object, signal?: AbortSignal) {
  const response = await fetch("/api/v1/integrations/wechat", { method: body ? "POST" : "GET", cache: "no-store", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "微信接口未就绪");
  return result.data;
}
export function WechatConnection({ roleId, disabled, onImport }: { roleId: string; disabled: boolean; onImport: (snapshotId: string, text: string) => boolean }) {
  const [probe, setProbe] = useState<WechatProbe | null>(null);
  const [processId, setProcessId] = useState(0);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [snapshot, setSnapshot] = useState<WechatSnapshot | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [consent, setConsent] = useState(false);
  const [limit, setLimit] = useState(5);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const locked = disabled || pending;
  useEffect(() => {
    const controller = new AbortController();
    request(undefined, controller.signal).then((data: WechatProbe) => {
      if (!controller.signal.aborted) { setProbe(data); setProcessId((id) => data.windows?.some((item) => item.processId === id) ? id : data.windows?.[0]?.processId ?? 0); }
    }).catch((issue) => { if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : "检测失败"); });
    return () => controller.abort();
  }, [roleId]);
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); if (!open && dialog.current?.open) dialog.current.close(); }, [open]);
  async function run(action: "refresh" | "connect" | "read" | "disconnect") {
    if (locked) return;
    setPending(true); setError("");
    try {
      if (action === "refresh") {
        const data: WechatProbe = await request(); setProbe(data); setProcessId(data.windows?.[0]?.processId ?? 0);
      } else if (action === "connect") {
        if (connection) await request({ action: "disconnect", connectionId: connection.connectionId });
        setConnection(null); setSnapshot(null); setConsent(false);
        setConnection(await request({ action, processId }));
      } else if (action === "read" && connection && consent) {
        const data: WechatSnapshot = await request({ action, connectionId: connection.connectionId, confirmed: true, limit });
        setSnapshot(data); setSelected(data.entries.map((_, index) => index));
      } else if (action === "disconnect" && connection) {
        await request({ action, connectionId: connection.connectionId }); setConnection(null); setSnapshot(null); setConsent(false);
      }
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "微信连接失败");
      if (action === "read") { setConnection(null); setSnapshot(null); setConsent(false); }
    } finally { setPending(false); }
  }
  return <div className={styles.root}>
    <button type="button" disabled={locked} onClick={() => setOpen(true)}><MessageCircle size={14} />{connection ? "微信只读连接" : probe?.running ? "检测到微信 · 连接" : "检测 / 连接微信"}</button>
    <dialog ref={dialog} className={styles.dialog} aria-label="连接个人微信" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <header><h2>连接个人微信 · 只读</h2><button type="button" aria-label="关闭微信连接" onClick={() => setOpen(false)}><X size={18} /></button></header>
      <p>在电脑微信中登录并切到要分析的会话。所有 Agent 共用此接口；连接只检查桌面控件，不自动读取或发送消息。</p>
      <div className={styles.actions}><button type="button" disabled={locked} onClick={() => void run("refresh")}>检测后台微信</button><span>{probe?.running ? "微信进程已检测到" : probe ? "未检测到运行的微信，请先手动打开" : "等待检测"}</span></div>
      {!!probe?.windows?.length && <label>微信窗口<select aria-label="微信窗口" value={processId} disabled={locked} onChange={(event) => setProcessId(Number(event.target.value))}>{probe.windows.map((item) => <option key={item.processId} value={item.processId}>{item.application} {item.version} · PID {item.processId}</option>)}</select></label>}
      <div className={styles.actions}><button type="button" disabled={locked || !processId} onClick={() => void run("connect")}>{connection ? "重新确认当前会话" : "连接当前微信会话"}</button>{connection && <button type="button" disabled={locked} onClick={() => void run("disconnect")}>断开</button>}</div>
      {connection && <section className={styles.preview}><strong>桌面接口已连接：{connection.chatLabel}</strong><p>当前加载 {connection.loadedItems} 条，尚未导入内容。10 分钟后过期，切换聊天须重新连接。</p>
        <label><input type="checkbox" checked={consent} disabled={locked} onChange={(event) => setConsent(event.target.checked)} />我确认这是要分析的会话，只读取当前已加载记录并交给本机模型。</label>
        <label>读取最近几条<select aria-label="微信读取条数" value={limit} disabled={locked} onChange={(event) => setLimit(Number(event.target.value))}>{[1, 3, 5, 10, 20].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
        <button type="button" disabled={locked || !consent} onClick={() => void run("read")}>只读预览当前会话</button>
      </section>}
      {snapshot && <section className={styles.preview}><strong>已读取 {snapshot.entries.length} 条，选中后再放入任务</strong><div className={styles.entries}>{snapshot.entries.map((entry, index) => <label key={index}><input type="checkbox" checked={selected.includes(index)} disabled={locked} onChange={() => setSelected((items) => items.includes(index) ? items.filter((id) => id !== index) : [...items, index])} /><span>[{entry.kind}] {entry.text}</span></label>)}</div>
        <button type="button" disabled={locked || !selected.length} onClick={() => { if (onImport(snapshot.id, formatWechatSnapshot(snapshot, snapshot.entries.filter((_, index) => selected.includes(index))))) setOpen(false); }}>把选中记录放入任务</button>
      </section>}
      {pending && <p role="status">正在检测微信桌面接口…</p>}{error && <p role="alert">{error}</p>}
      <small>仅当前桌面已加载文本，不含完整历史；附件正文未读取。内容不自动入库、不上传 GitHub，不自动发微信或朋友圈。</small>
    </dialog>
  </div>;
}
