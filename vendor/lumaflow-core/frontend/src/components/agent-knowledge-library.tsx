"use client";

import { useEffect, useState } from "react";
import type { CowAgentProfile } from "@/lib/contracts/cowagent-agent";
import type { KnowledgeEntry } from "@/lib/knowledge/contracts";
import styles from "./knowledge-hub.module.css";

type LibraryStatus = { agentId: string; documentIds: string[]; includeDemo: boolean; documents: Array<{ id: string; title: string; fileName: string; collection: string; characters: number }> };

export function AgentKnowledgeLibrary({ documents, onToast }: { documents: KnowledgeEntry[]; onToast: (message: string) => void }) {
  const [agents, setAgents] = useState<CowAgentProfile[]>([]);
  const [agentId, setAgentId] = useState("");
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [demo, setDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    fetch("/api/v1/cowagent/agents", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error("Agent 名单读取失败");
      return payload;
    }).then((payload) => {
      if (!live) return;
      const list = ((payload.data?.agents ?? []) as CowAgentProfile[]).filter((a) => a.enabled);
      setAgents(list);
      setAgentId(list.find((a) => a.id === "wechat-service")?.id ?? list.find((a) => a.agentType === "weixin_personal")?.id ?? list[0]?.id ?? "");
    }).catch(() => { if (live) setError("请先启动 CowAgent，才能选择知识库使用者。"); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!agentId) return;
    let live = true;
    fetch(`/api/v1/knowledge/agent-library?agentId=${encodeURIComponent(agentId)}`, { cache: "no-store" }).then(async (r) => {
      const payload = await r.json();
      if (!r.ok) throw new Error(payload.error?.message ?? "授权读取失败");
      if (live) { setStatus(payload.data); setIds(payload.data.documentIds); setDemo(payload.data.includeDemo); setError(""); }
    }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [agentId]);

  async function update(action: "assign" | "import-demo") {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/knowledge/agent-library", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "assign" ? { action, agentId, documentIds: ids, includeDemo: demo } : { action, agentId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "知识授权失败");
      setStatus(payload.data); setIds(payload.data.documentIds); setDemo(payload.data.includeDemo);
      onToast(action === "import-demo" ? "四份虚构 TXT 已导入隔离演示空间，并授权给所选 Agent。" : "知识授权已保存。");
    } catch (e) { setError(e instanceof Error ? e.message : "知识授权失败"); }
    finally { setBusy(false); }
  }

  return <section className={`${styles.catalogPanel} ${styles.agentLibrary}`} aria-label="微信 Agent 知识授权">
    <div className={styles.sectionHead}><div><span>WECHAT KNOWLEDGE</span><h3>微信 Agent 使用网站知识库</h3></div></div>
    <p className={styles.catalogHint}>选择上传文件并授权给 Agent。它会在微信中检索同一份最新正文；删除文件后不再被检索。演示 TXT 单独存放，不进入公司正式资料库。</p>
    <label>知识使用者 <select aria-label="知识授权 Agent" value={agentId} disabled={busy || !agents.length} onChange={(event) => {
      setStatus(null); setIds([]); setDemo(false); setError(""); setAgentId(event.target.value);
    }}>
      {!agents.length && <option value="">等待后端 Agent 名单…</option>}{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.id}</option>)}
    </select></label>
    <div className={styles.toolbar}>
      <button className={styles.secondaryButton} disabled={busy || !agentId} onClick={() => void update("import-demo")}>导入四份虚构演示 TXT</button>
      <button className={styles.primaryButton} disabled={busy || !agentId || !status} onClick={() => void update("assign")}>{busy ? "保存中…" : "保存文件授权"}</button>
      <label><input type="checkbox" checked={demo} disabled={busy || !status} onChange={(event) => setDemo(event.target.checked)} />启用隔离演示知识</label>
    </div>
    <div className={styles.agentLibraryFiles}>
      {documents.filter((entry) => entry.hasText && entry.classificationStatus !== "archived").map((entry) => <label key={entry.id}>
        <input type="checkbox" checked={ids.includes(entry.id)} disabled={busy || !status} onChange={(event) => setIds((previous) => event.target.checked ? [...new Set([...previous, entry.id])] : previous.filter((id) => id !== entry.id))} /> {entry.originalName} · 授权后 Agent 可读取正文
      </label>)}
      {!documents.some((entry) => entry.hasText) && <p>暂未上传可读文件；可先启用四份隔离演示资料。</p>}
    </div>
    {status && <p>当前可检索 {status.documents.length} 份资料：{status.documents.map((document) => `${document.fileName}${document.collection === "demo" ? "（虚构演示）" : ""}`).join("、") || "暂无"}。</p>}
    {error && <p role="alert" className={styles.inlineWarning}>{error}</p>}
  </section>;
}
