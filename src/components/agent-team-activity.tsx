"use client";

import Image from "next/image";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import type { AgentProgress, CollaborationMode } from "@/lib/contracts/agent-progress";
import styles from "./agent-team-activity.module.css";

type AgentTeamActivityProps = { records: AgentProgress[]; busy: boolean; mode?: CollaborationMode };
type DisplayState = AgentProgress["state"] | "stopped";

function displayState(record: AgentProgress, busy: boolean): DisplayState {
  return record.state === "running" && !busy ? "stopped" : record.state;
}

function stateLabel(record: AgentProgress, busy: boolean, mode: CollaborationMode) {
  const state = displayState(record, busy);
  if (state === "running") return record.round === 1 ? mode === "debate" ? "正在分析" : "正在工作" : record.round === 2 ? "正在回应" : "正在汇总与交付";
  return { completed: "已完成", failed: "失败", cancelled: "已取消", stopped: "已停止" }[state];
}

export function AgentTeamActivity({ records, busy, mode = "debate" }: AgentTeamActivityProps) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const grouped = new Map<string, Map<number, AgentProgress>>();
  for (const record of records) {
    const rounds = grouped.get(record.agentId) ?? new Map<number, AgentProgress>();
    const previous = rounds.get(record.round);
    rounds.set(record.round, { ...record, text: record.text ?? previous?.text, recipientNames: record.recipientNames ?? previous?.recipientNames, actions: record.actions ?? previous?.actions });
    grouped.set(record.agentId, rounds);
  }
  const members = [...grouped.values()].map((rounds) => {
    const history = [...rounds.values()].sort((left, right) => left.round - right.round);
    const latest = history[history.length - 1];
    return { current: { ...latest, avatarUrl: latest.avatarUrl ?? history.find((round) => round.avatarUrl)?.avatarUrl }, history };
  });
  if (!members.length) return null;
  const counts = { running: 0, completed: 0, failed: 0, cancelled: 0, stopped: 0 };
  for (const member of members) counts[displayState(member.current, busy)] += 1;

  return <section className={styles.root} aria-label="协作 Agent 进度">
    <header className={styles.header}>
      <button type="button" className={styles.toggle} aria-label="协作 Agent" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((value) => !value)}><strong>协作 Agent</strong><ChevronDown size={14} data-expanded={expanded} /></button>
      <span className={styles.counts} role="status" aria-live="polite" aria-atomic="true">{counts.running} 运行中 · {counts.completed} 完成{counts.failed > 0 ? ` · ${counts.failed} 失败` : ""}{counts.cancelled > 0 ? ` · ${counts.cancelled} 已取消` : ""}{counts.stopped > 0 ? ` · ${counts.stopped} 已停止` : ""}</span>
    </header>
    {!expanded && counts.running > 0 && <ul className={styles.activeMembers} aria-label="正在工作的 Agent">{members.filter(({ current }) => displayState(current, busy) === "running").map(({ current }) => <li key={current.agentId} className={styles.memberHeading}>
      <span className={styles.avatar} aria-hidden="true">{current.avatarUrl ? <Image src={current.avatarUrl} alt="" width={28} height={28} unoptimized /> : current.name.trim().slice(0, 2).toUpperCase()}</span>
      <strong className={styles.name}>{current.name}</strong><span className={styles.memberState} data-state="running"><i className={styles.runningDot} aria-hidden="true" /><span className={styles.runningLabel}>{current.round === 1 && mode === "debate" ? "开始工作" : stateLabel(current, busy, mode)}</span></span>
    </li>)}</ul>}
    {expanded && <div id={panelId}>
      <p className={styles.publicNote}>公开分析依据与成员发言</p>
      <ul className={styles.members} aria-label="协作成员进度">{members.map(({ current, history }) => {
      const state = displayState(current, busy);
      return <li key={current.agentId} className={styles.member}>
        <div className={styles.memberHeading}>
          <span className={styles.avatar} aria-hidden="true">{current.avatarUrl ? <Image src={current.avatarUrl} alt="" width={28} height={28} unoptimized /> : current.name.trim().slice(0, 2).toUpperCase()}</span>
          <strong className={styles.name}>{current.name}</strong>
          <span className={styles.memberState} data-state={state}>{state === "running" && <i className={styles.runningDot} aria-hidden="true" />}<span className={state === "running" ? styles.runningLabel : undefined}>{stateLabel(current, busy, mode)}</span></span>
        </div>
        <div className={styles.rounds}>{history.map((round) => <details className={styles.round} key={round.round} open={displayState(round, busy) === "running" ? true : undefined}>
          <summary><span>第 {round.round} 轮 · {round.round === 1 ? mode === "debate" ? "分析观点" : "处理任务" : round.round === 2 ? "相互回应" : "汇总与交付"}</span><small>{stateLabel(round, busy, mode)}</small><span className={styles.recipients}>{round.name} → {round.recipientNames?.length ? round.recipientNames.join("、") : "全体"}</span></summary>
          {round.text ? <p className={styles.text}>{round.text}</p> : <p className={styles.emptyText}>{displayState(round, busy) === "running" ? "等待公开发言…" : "尚无返回内容"}</p>}
          {!!round.actions?.length && <div className={styles.actions} aria-label={`${round.name} 第 ${round.round} 轮实际操作`}><strong>实际操作</strong><ul>{round.actions.map((action, index) => <li key={`${index}-${action}`}>{action}</li>)}</ul></div>}
        </details>)}</div>
      </li>;
    })}</ul></div>}
  </section>;
}
