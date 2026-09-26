"use client";
import { useEffect, useRef, useState } from "react";
import { FileText, FolderOpen, Plus, Search, Upload, X } from "lucide-react";
import styles from "./agent-knowledge-picker.module.css";
type KnowledgeFile = { id: string; title: string };
type WebResult = { title: string; url: string; content: string };
export function AgentKnowledgePicker({ value, onChange, disabled = false, onBusyChange }: { value: string[]; onChange: (ids: string[]) => void; disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<"files" | "text" | "search" | null>(null);
  const [title, setTitle] = useState(""); const [text, setText] = useState("");
  const [query, setQuery] = useState(""); const [results, setResults] = useState<WebResult[]>([]);
  const [busy, setBusy] = useState(false); const [searching, setSearching] = useState(false); const [error, setError] = useState("");
  const uploadInput = useRef<HTMLInputElement>(null); const menuArea = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => { const all: KnowledgeFile[] = []; for (let offset = 0; ; offset += 200) { const response = await fetch(`/api/v1/knowledge?limit=200&offset=${offset}`, { cache: "no-store", signal: controller.signal }); const body = await response.json(); if (!response.ok) throw new Error(body?.error?.message || "无法读取知识库"); const entries: KnowledgeFile[] = body.data || []; all.push(...entries); if (entries.length < 200) break; } if (!controller.signal.aborted) setFiles(all); })().catch((issue) => { if (!controller.signal.aborted) setError(issue.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !menuArea.current?.contains(event.target)) setMenu(false); };
    document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  async function upload(selected: File[] | FileList | null): Promise<boolean> {
    if (!selected?.length) return false;
    if (value.length + selected.length > 50) { setError("最多选择 50 个知识文件。"); return false; }
    setBusy(true); onBusyChange?.(true); setError("");
    const ids = [...value];
    try {
      for (const file of Array.from(selected)) {
        const form = new FormData(); form.set("file", file);
        const response = await fetch("/api/v1/knowledge", { method: "POST", body: form }); const body = await response.json();
        if (!response.ok || !body.data?.id) throw new Error(body?.error?.message || `无法上传 ${file.name}`);
        const entry = body.data as KnowledgeFile;
        if (!ids.includes(entry.id)) ids.push(entry.id);
        setFiles((old) => [entry, ...old.filter((item) => item.id !== entry.id)]); onChange([...ids]);
      }
      return true;
    } catch (issue) { setError((issue as Error).message); return false; }
    finally { setBusy(false); onBusyChange?.(false); if (uploadInput.current) uploadInput.current.value = ""; }
  }
  async function search() {
    setSearching(true); setError("");
    try { const response = await fetch("/api/v1/knowledge/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: query.trim() }) }); const body = await response.json(); if (!response.ok) throw new Error(body?.error?.message || "搜索失败"); setResults(body.results || body.data?.results || []); }
    catch (issue) { setError((issue as Error).message); } finally { setSearching(false); }
  }
  function open(next: typeof panel) { setMenu(false); setPanel(next); setError(""); }
  return <section className={styles.root} aria-label="微信 Agent 知识库">
    <strong>知识库</strong><div className={styles.actions} ref={menuArea}><button type="button" disabled={disabled || busy} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Plus size={16} /> 添加文件</button><small>{value.length ? `已选择 ${value.length} 个文件` : "可留空，按需添加知识文件"}</small>
      {menu && <div className={styles.menu} role="menu" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setMenu(false); } }}><small>添加</small><button type="button" role="menuitem" onClick={() => { setMenu(false); uploadInput.current?.click(); }}><Upload size={17} /> 上传新文件</button><button type="button" role="menuitem" onClick={() => open("files")}><FolderOpen size={17} /> 选择知识库现有文件</button><button type="button" role="menuitem" onClick={() => open("text")}><FileText size={17} /> 输入文字</button><button type="button" role="menuitem" onClick={() => open("search")}><Search size={17} /> 网上搜索</button></div>}
    </div>
    <input ref={uploadInput} className={styles.hidden} aria-label="微信知识库文件上传" type="file" multiple disabled={disabled || busy} onChange={(event) => void upload(event.target.files)} />
    {value.length > 0 && <div className={styles.selected}>{value.map((id) => <div key={id}><FileText size={14} /><span>{files.find((file) => file.id === id)?.title || id}</span><button type="button" aria-label={`移除知识文件 ${files.find((file) => file.id === id)?.title || id}`} disabled={disabled || busy} onClick={() => onChange(value.filter((item) => item !== id))}><X size={14} /></button></div>)}</div>}
    {panel && <div className={styles.panel}><header><strong>{{ files: "现有知识库文件", text: "输入文字", search: "网上搜索" }[panel]}</strong><button type="button" aria-label="关闭知识库添加面板" onClick={() => setPanel(null)}><X size={15} /></button></header>
      {panel === "files" && <div className={styles.files}>{files.length ? files.map((file) => <label key={file.id}><input type="checkbox" checked={value.includes(file.id)} disabled={disabled || busy || (!value.includes(file.id) && value.length >= 50)} onChange={(event) => onChange(event.target.checked ? [...value, file.id] : value.filter((id) => id !== file.id))} />{file.title}</label>) : <p>暂无知识文件，请先上传。</p>}</div>}
      {panel === "text" && <><label>标题<input aria-label="知识文字标题" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></label><label>正文<textarea aria-label="知识文字正文" value={text} maxLength={100000} onChange={(event) => setText(event.target.value)} /></label><button type="button" disabled={disabled || busy || !title.trim() || !text.trim()} onClick={async () => { if (await upload([new File([text], `${title.replace(/[<>:"/\\|?*]/g, "_")}.txt`, { type: "text/plain" })])) { setTitle(""); setText(""); setPanel(null); } }}>保存并选用</button></>}
      {panel === "search" && <><label>搜索内容<input aria-label="搜索内容" value={query} maxLength={1000} onChange={(event) => setQuery(event.target.value)} /></label><button type="button" disabled={searching || !query.trim()} onClick={() => void search()}>{searching ? "正在搜索…" : "搜索"}</button>{results.map((result) => <article key={result.url}><a href={result.url} target="_blank" rel="noreferrer">{result.title}</a><p>{result.content}</p><button type="button" disabled={disabled || busy} onClick={() => void upload([new File([`${result.title}\n来源：${result.url}\n检索时间：${new Date().toISOString()}\n\n${result.content}`], `${result.title.replace(/[<>:"/\\|?*]/g, "_").slice(0, 100)}.txt`, { type: "text/plain" })])}>保存并选用</button></article>)}</>}
    </div>}
    {busy && <p role="status">正在添加知识文件…</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
  </section>;
}
