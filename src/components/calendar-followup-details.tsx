"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { deleteFollowupViaApi, getFollowupViaApi, updateFollowupStatusViaApi } from "@/lib/client/backend-api";
import type { FollowupTask } from "@/lib/crm";
import styles from "./calendar-event-details.module.css";

export function CalendarFollowupDetails({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [task, setTask] = useState<FollowupTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [localMode, setLocalMode] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => setLocalMode(["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    let active = true;
    void getFollowupViaApi(taskId).then((result) => { if (active) { setTask(result); setError(""); } }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "无法打开跟进任务"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [taskId, refreshKey]);

  async function toggleStatus() {
    if (!task) return;
    setBusy(true); setError("");
    try { setTask(await updateFollowupStatusViaApi(task.id, task.status === "completed" ? "open" : "completed")); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "更新任务失败"); }
    finally { setBusy(false); }
  }

  async function removeTask() {
    if (!task || !window.confirm(`确定永久删除本机客户任务「${task.title}」吗？此操作无法恢复。`)) return;
    setBusy(true); setError("");
    try { await deleteFollowupViaApi(task.id); router.push("/?followup=1"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "删除任务失败"); setBusy(false); }
  }

  return <main className={styles.page}><div className={styles.shell}>
    <Link href="/?followup=1" className={styles.back}>← 返回协作日历</Link>
    {error && <div role="alert" className={styles.error}>{error} <button type="button" onClick={() => setRefreshKey((value) => value + 1)}>重试</button></div>}
    {loading && !task ? <p className={styles.loading}>正在打开任务详情…</p> : task && <>
      <header className={styles.header}><div><span className={styles.kicker}>当前部署 · 客户跟进任务</span><h1>{task.title}</h1><p>{task.company} · {task.customerName}</p></div><span className={styles.status}>{task.status === "completed" ? "已完成" : "待处理"}</span></header>
      <section className={styles.card}><h2>任务信息</h2><dl><div><dt>客户</dt><dd>{task.customerName}</dd></div><div><dt>公司</dt><dd>{task.company}</dd></div><div><dt>截止</dt><dd>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "full", timeStyle: "short" }).format(new Date(task.dueAt))}</dd></div><div><dt>优先级</dt><dd>{task.priority}</dd></div><div><dt>状态</dt><dd>{task.status === "completed" ? "已完成" : "待处理"}</dd></div></dl><p className={styles.description}>{task.description || "暂无任务说明"}</p></section>
      <section className={styles.card}><h2>任务操作</h2><p className={styles.loading}>此客户任务只保存在当前部署。需要让其他电脑上的同事看到，请在协作日历创建「共享跟进」并邀请其账号邮箱。</p><div className={styles.actions}><button type="button" disabled={busy} onClick={() => void toggleStatus()}>{task.status === "completed" ? "重新打开任务" : "完成任务"}</button>{localMode && <button type="button" className={styles.danger} disabled={busy} onClick={() => void removeTask()}>删除任务</button>}</div></section>
    </>}
  </div></main>;
}
