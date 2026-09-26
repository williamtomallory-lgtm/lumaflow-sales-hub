"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { ChevronDown, ChevronUp, FileText, Folder, GitBranch, Link, Plus } from "lucide-react";
import { z } from "zod";
import type { AgentProgress } from "@/lib/contracts/agent-progress";
import styles from "./work-summary-panel.module.css";

const summarySchema = z.object({ workspace: z.string(), projectName: z.string(), git: z.object({ branch: z.string(), additions: z.number().nonnegative(), deletions: z.number().nonnegative(), changedFiles: z.number().nonnegative(), untrackedFiles: z.number().nonnegative() }).nullable() });
export type WorkSummaryItem = { id: string; name: string; url?: string; onOpen?: () => void };
export type WorkSummaryPanelProps = {
  agentId?: string; workspace?: string; busy?: boolean;
  progress?: readonly AgentProgress[]; outputs?: readonly WorkSummaryItem[]; sources?: readonly WorkSummaryItem[];
  onAddSource?: () => void; onCreateOutput?: () => void;
};

export function WorkSummaryPanel({ agentId, workspace, busy = false, progress = [], outputs = [], sources = [], onAddSource, onCreateOutput }: WorkSummaryPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [allSources, setAllSources] = useState(false);
  const [snapshotState, setSnapshot] = useState<{ agentId: string; data: z.infer<typeof summarySchema> } | null>(null);
  const [errorState, setError] = useState<{ agentId: string; message: string } | null>(null);
  const snapshotCandidate = snapshotState;
  const errorCandidate = errorState;
  const snapshot = snapshotCandidate && snapshotCandidate.agentId === agentId ? snapshotCandidate.data : null;
  const error = errorCandidate && errorCandidate.agentId === agentId ? errorCandidate.message : "";
  const members = useMemo(() => {
    const latest = new Map<string, AgentProgress>();
    for (const record of progress) if (!latest.has(record.agentId) || latest.get(record.agentId)!.round <= record.round) latest.set(record.agentId, record);
    return [...latest.values()];
  }, [progress]);
  const counts = { running: members.filter(member => member.state === "running").length, completed: members.filter(member => member.state === "completed").length, failed: members.filter(member => member.state === "failed" || member.state === "cancelled").length };

  useEffect(() => {
    if (!agentId) return;
    const controller = new AbortController();
    let inFlight = false;
    async function refresh() {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const response = await fetch(`/api/v1/work/summary?agentId=${encodeURIComponent(agentId!)}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error("工作间状态暂不可用");
        const value = summarySchema.parse(payload.data);
        if (!controller.signal.aborted) { setSnapshot({ agentId: agentId!, data: value }); setError(null); }
      } catch { if (!controller.signal.aborted) setError({ agentId: agentId!, message: "工作间状态暂不可用" }); }
      finally { inFlight = false; }
    }
    void refresh();
    const timer = busy ? window.setInterval(() => void refresh(), 10000) : undefined;
    return () => { controller.abort(); if (timer) window.clearInterval(timer); };
  }, [agentId, busy]);

  return <aside className={`${styles.panel} ${expanded ? styles.expanded : ""}`} aria-label="Work 工作概况">
    <header><span><Folder size={15} /><strong title={snapshot?.workspace || workspace}>{snapshot?.projectName || "工作概况"}</strong></span><button type="button" aria-label={expanded ? "收起工作概况" : "展开工作概况"} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button></header>
    <div className={styles.content}>
      {snapshot?.git ? <div className={styles.git}><span><GitBranch size={14} />{snapshot.git.branch}</span><span title="已跟踪文本文件相对 HEAD 的改动"><em>+{snapshot.git.additions.toLocaleString()}</em><b>−{snapshot.git.deletions.toLocaleString()}</b></span>{expanded && <small>{snapshot.git.changedFiles} 个已跟踪文件变更 · {snapshot.git.untrackedFiles} 个未跟踪项</small>}</div> : <p className={styles.muted}>{error || (snapshot ? "工作间未使用 Git" : "正在读取工作间…")}</p>}
      <section><h3>输出内容<button type="button" aria-label="创建输出文件" disabled={!onCreateOutput} onClick={onCreateOutput}><Plus size={16} /></button></h3>{outputs.length ? outputs.slice(0, expanded ? undefined : 3).map(item => <Item key={item.id} item={item} />) : <p className={styles.muted}>暂无已生成文件</p>}</section>
      <section><h3>子智能体</h3><div className={styles.members}>{members.slice(0, expanded ? undefined : 4).map(member => member.avatarUrl ? <Image unoptimized width={24} height={24} key={member.agentId} src={member.avatarUrl} alt={member.name} title={`${member.name} · ${{ running: "运行中", completed: "完成", failed: "失败", cancelled: "已停止" }[member.state]}`} /> : <span key={member.agentId} className={styles.avatar} title={member.name}>{member.name.slice(0, 1)}</span>)}<span>{counts.running ? `${counts.running} 运行中 · ` : ""}{counts.completed} 完成{counts.failed ? ` · ${counts.failed} 已停止或失败` : ""}</span></div>{expanded && members.map(member => <div key={member.agentId} className={styles.member}><span>{member.name}</span><small>{{ running: "运行中", completed: "完成", failed: "失败", cancelled: "已停止" }[member.state]}</small></div>)}</section>
      <section><h3>来源<button type="button" aria-label="添加引用来源" disabled={!onAddSource} onClick={onAddSource}><Plus size={16} /></button></h3>{sources.length ? sources.slice(0, expanded || allSources ? undefined : 3).map(item => <Item key={item.id} item={item} />) : <p className={styles.muted}>暂无引用来源</p>}{sources.length > 3 && !expanded && <button type="button" className={styles.viewAll} onClick={() => setAllSources(value => !value)}>{allSources ? "收起来源" : `查看全部 ${sources.length} 项`}</button>}</section>
    </div>
  </aside>;
}

function Item({ item }: { item: WorkSummaryItem }) {
  const icon = item.url ? <Link size={14} /> : <FileText size={14} />;
  if (item.onOpen) return <button type="button" className={styles.item} title={item.name} onClick={item.onOpen}>{icon}<span>{item.name}</span></button>;
  if (item.url && /^https?:\/\//i.test(item.url)) return <a className={styles.item} title={item.name} href={item.url} target="_blank" rel="noopener noreferrer">{icon}<span>{item.name}</span></a>;
  return <div className={styles.item} title={item.name}>{icon}<span>{item.name}</span></div>;
}
