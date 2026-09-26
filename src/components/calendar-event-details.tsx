"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { deleteCalendarEvent, getCalendarEvent, getCalendarIdentity, listCalendarPresence, sendCalendarHeartbeat, updateCalendarEvent, updateCalendarMemberStatus, type CalendarPresence } from "@/lib/client/calendar-api";
import { connectSharedCalendar, currentCalendarConnection, usesSharedCalendarConnection, type CalendarConnection, type CalendarIdentity } from "@/lib/client/calendar-connection";
import type { CalendarEvent, CalendarMemberStatus } from "@/lib/contracts/calendar";
import styles from "./calendar-event-details.module.css";

const kindLabels: Record<CalendarEvent["kind"], string> = { meeting: "会议", task: "任务", focus: "专注时间", followup: "共享跟进" };
const statusLabels: Record<CalendarEvent["status"], string> = { confirmed: "进行中", completed: "已完成", cancelled: "已取消" };

function memberLabel(status: CalendarMemberStatus, kind: CalendarEvent["kind"]) {
  return { pending: kind === "meeting" ? "待确认" : "待处理", accepted: "已接受", declined: "已拒绝", in_progress: "进行中", done: "已完成" }[status];
}

function displayTime(iso: string) { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "full", timeStyle: "short" }).format(new Date(iso)); }
function localInput(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function CalendarEventDetails({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [identity, setIdentity] = useState<CalendarIdentity | null>(null);
  const [presence, setPresence] = useState<CalendarPresence>({});
  const [localMode, setLocalMode] = useState(false);
  const [connection, setConnection] = useState<CalendarConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const timeout = window.setTimeout(() => { setLocalMode(usesSharedCalendarConnection()); setConnection(currentCalendarConnection()); }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [current, viewer] = await Promise.all([getCalendarEvent(eventId), getCalendarIdentity()]);
        if (!active) return;
        setEvent(current); setIdentity(viewer); setError("");
        const from = new Date(Date.parse(current.startAt) - 60_000).toISOString();
        const to = new Date(Date.parse(current.endAt) + 60_000).toISOString();
        const people = await listCalendarPresence({ from, to }).catch(() => ({} as CalendarPresence));
        if (active) setPresence(people);
      } catch (caught) { if (active) setError(caught instanceof Error ? caught.message : "无法打开事件详情"); }
      finally { if (active) setLoading(false); }
    }
    void load();
    const interval = localMode && !connection ? null : window.setInterval(() => { void load(); }, 20_000);
    return () => { active = false; if (interval !== null) window.clearInterval(interval); };
  }, [eventId, localMode, connection, refreshKey]);

  useEffect(() => {
    if (usesSharedCalendarConnection() && !currentCalendarConnection()) return;
    const heartbeat = () => { if (document.visibilityState === "visible") void sendCalendarHeartbeat().catch(() => {}); };
    heartbeat();
    const interval = window.setInterval(heartbeat, 30_000);
    document.addEventListener("visibilitychange", heartbeat);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", heartbeat); };
  }, [connection]);

  async function connect() {
    setBusy(true); setError("");
    try { const linked = await connectSharedCalendar(); setConnection(linked); setIdentity(linked.viewer); setRefreshKey((value) => value + 1); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "连接失败"); }
    finally { setBusy(false); }
  }

  async function changeEvent(patch: Parameters<typeof updateCalendarEvent>[1]) {
    if (!event) return;
    setBusy(true); setError("");
    try { const updated = await updateCalendarEvent(event.id, { ...patch, revision: event.revision }); setEvent(updated); setEditing(false); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败，请刷新后重试"); }
    finally { setBusy(false); }
  }

  async function changeMyStatus(status: CalendarMemberStatus) {
    if (!event) return;
    setBusy(true); setError("");
    try { setEvent(await updateCalendarMemberStatus(event.id, event.revision, status)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "更新状态失败，请刷新后重试"); }
    finally { setBusy(false); }
  }

  async function removeEvent() {
    if (!event || !window.confirm(`确定永久删除「${event.title}」吗？受邀成员也将无法再查看，且无法恢复。`)) return;
    setBusy(true); setError("");
    try { await deleteCalendarEvent(event.id, event.revision); router.push("/?followup=1"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "删除失败，请刷新后重试"); setBusy(false); }
  }

  const myEmail = identity?.email.toLowerCase();
  const memberEmails = event ? [event.createdByEmail, ...event.participantEmails.filter((email) => email !== event.createdByEmail)] : [];
  const myStatus = event && myEmail && memberEmails.includes(myEmail) ? event.memberStatuses?.[myEmail] ?? "pending" : null;
  const memberChoices: CalendarMemberStatus[] = event?.kind === "meeting" ? ["pending", "accepted", "declined"] : ["pending", "in_progress", "done"];
  if (myStatus && !memberChoices.includes(myStatus)) memberChoices.unshift(myStatus);
  const canDelete = Boolean(event && identity?.id === event.createdById);

  return <main className={styles.page}>
    <div className={styles.shell}>
      <Link href="/?followup=1" className={styles.back}>← 返回协作日历</Link>
      {localMode && !connection && <div className={styles.notice}><p>这台电脑尚未连接云端日历。请用自己的账号登录，才能查看团队共享事件。</p><button type="button" onClick={() => void connect()} disabled={busy}>连接云端日历</button></div>}
      {error && !(localMode && !connection && error.includes("请先连接云端")) && <div role="alert" className={styles.error}>{error} <button type="button" onClick={() => setRefreshKey((value) => value + 1)}>重试</button></div>}
      {loading && !event ? <p className={styles.loading}>正在打开事件详情…</p> : event && <>
        <header className={styles.header}><div><span className={styles.kicker}>协作日历 · {kindLabels[event.kind]}</span><h1>{event.title}</h1><p>{statusLabels[event.status]} · {event.allDay ? "全天" : `${displayTime(event.startAt)} 至 ${displayTime(event.endAt)}`}</p></div><span className={styles.status}>{statusLabels[event.status]}</span></header>
        <section className={styles.card}><h2>事件信息</h2><dl><div><dt>创建人</dt><dd>{event.createdByName} · {event.createdByEmail}</dd></div><div><dt>开始</dt><dd>{displayTime(event.startAt)}</dd></div><div><dt>结束</dt><dd>{displayTime(event.endAt)}</dd></div><div><dt>最后修改</dt><dd>{event.updatedByName} · {displayTime(event.updatedAt)}</dd></div></dl><p className={styles.description}>{event.description || "暂无事件说明"}</p></section>
        <section className={styles.card}><h2>成员状态</h2><div className={styles.members}>{memberEmails.map((email) => <div key={email} className={styles.member}><div className={styles.avatar}>{(event.memberNames?.[email] || presence[email]?.name || email).slice(0, 1).toUpperCase()}</div><div className={styles.memberName}><strong>{event.memberNames?.[email] || presence[email]?.name || (email === event.createdByEmail ? event.createdByName : email)}</strong><small>{email}{email === event.createdByEmail ? " · 创建人" : ""}{email === myEmail ? " · 我" : ""}</small></div><span className={presence[email]?.online ? styles.online : styles.offline}>{presence[email]?.online ? "在线" : presence[email] ? "离线" : "未上线"}</span><span className={styles.memberStatus}>{memberLabel(event.memberStatuses?.[email] ?? (email === event.createdByEmail && event.kind === "meeting" ? "accepted" : "pending"), event.kind)}</span></div>)}</div>{myStatus && <label className={styles.myStatus}>我的参与状态<select value={myStatus} disabled={busy} onChange={(input) => void changeMyStatus(input.target.value as CalendarMemberStatus)}>{memberChoices.map((status) => <option key={status} value={status}>{memberLabel(status, event.kind)}</option>)}</select></label>}</section>
        <section className={styles.card}><h2>事件操作</h2><div className={styles.actions}><button type="button" disabled={busy} onClick={() => setEditing((current) => !current)}>{editing ? "收起编辑" : "编辑事件"}</button>{event.kind === "followup" || event.kind === "task" ? <button type="button" disabled={busy} onClick={() => void changeEvent({ status: event.status === "completed" ? "confirmed" : "completed", revision: event.revision })}>{event.status === "completed" ? "重新打开" : "完成事件"}</button> : <button type="button" disabled={busy} onClick={() => void changeEvent({ status: event.status === "cancelled" ? "confirmed" : "cancelled", revision: event.revision })}>{event.status === "cancelled" ? "恢复事件" : "取消事件"}</button>}{canDelete && <button type="button" className={styles.danger} disabled={busy} onClick={() => void removeEvent()}>删除事件</button>}</div>{editing && <EventEditForm event={event} busy={busy} onSave={(draft) => void changeEvent({ ...draft, revision: event.revision })} />}</section>
      </>}
    </div>
  </main>;
}

function EventEditForm({ event, busy, onSave }: { event: CalendarEvent; busy: boolean; onSave: (draft: { title: string; description: string; startAt: string; endAt: string; allDay: boolean; kind: CalendarEvent["kind"]; participantEmails: string[] }) => void }) {
  const [title, setTitle] = useState(event.title);
  const [description, setDescription] = useState(event.description);
  const [startAt, setStartAt] = useState(localInput(event.startAt));
  const [endAt, setEndAt] = useState(localInput(event.endAt));
  const [kind, setKind] = useState(event.kind);
  const [allDay, setAllDay] = useState(event.allDay);
  const [participants, setParticipants] = useState(event.participantEmails.join(", "));
  const [validationError, setValidationError] = useState("");
  function submit(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    const start = new Date(startAt), end = new Date(endAt);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) { setValidationError("结束时间必须晚于开始时间。"); return; }
    setValidationError("");
    onSave({ title: title.trim(), description: description.trim(), startAt: start.toISOString(), endAt: end.toISOString(), allDay, kind, participantEmails: [...new Set(participants.split(/[，,\s]+/).map((email) => email.trim().toLowerCase()).filter(Boolean))] });
  }
  return <form className={styles.form} onSubmit={submit}><label>标题<input required maxLength={240} value={title} onChange={(input) => setTitle(input.target.value)} /></label><label>说明<textarea maxLength={5000} value={description} onChange={(input) => setDescription(input.target.value)} /></label><div className={styles.formRow}><label>开始<input type="datetime-local" required value={startAt} onChange={(input) => setStartAt(input.target.value)} /></label><label>结束<input type="datetime-local" required value={endAt} onChange={(input) => setEndAt(input.target.value)} /></label></div><div className={styles.formRow}><label>事件类型<select value={kind} onChange={(input) => setKind(input.target.value as CalendarEvent["kind"])}><option value="meeting">会议</option><option value="task">任务</option><option value="followup">共享跟进</option><option value="focus">专注时间</option></select></label><label className={styles.checkbox}><input type="checkbox" checked={allDay} onChange={(input) => setAllDay(input.target.checked)} />全天</label></div><label>受邀成员邮箱<input value={participants} onChange={(input) => setParticipants(input.target.value)} placeholder="多个邮箱用逗号分隔" /></label>{validationError && <p role="alert">{validationError}</p>}<button type="submit" disabled={busy || !title.trim()}>{busy ? "保存中…" : "保存修改"}</button></form>;
}
