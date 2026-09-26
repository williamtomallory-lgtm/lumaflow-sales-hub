"use client";

import { BookOpenText, ChevronDown, RefreshCw } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import styles from "./knowledge-wiki.module.css";

type Page = { path: string; title: string; kind: "index" | "topic" | "source" | "log" | "lint" | "schema"; markdown?: string };
type WikiMatch = Pick<Page, "path" | "title" | "kind"> & { excerpt: string; score?: number };
type WikiResponse = { data: { pages: Page[]; selected: Page; matches?: WikiMatch[] }; error?: { message?: string } };

function linkedLine(line: string, pages: Page[], select: (path: string) => void) {
  const parts: ReactNode[] = [];
  const expression = /\[([^\]]+)\]\(([^)]+)\)/g;
  let cursor = 0;
  for (const match of line.matchAll(expression)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(line.slice(cursor, start));
    const destination = match[2];
    const pagePath = destination.startsWith("../") ? destination.slice(3) : destination;
    if (pages.some((page) => page.path === pagePath)) parts.push(<button className={styles.inlineLink} type="button" key={start} onClick={() => select(pagePath)}>{match[1]}</button>);
    else if (/^\/api\/v1\/knowledge\/[0-9a-f-]{36}\/download$/i.test(destination)) parts.push(<a key={start} href={destination}>{match[1]}</a>);
    else parts.push(match[1]);
    cursor = start + match[0].length;
  }
  if (cursor < line.length) parts.push(line.slice(cursor));
  return parts;
}

function WikiMarkdown({ markdown, pages, select }: { markdown: string; pages: Page[]; select: (path: string) => void }) {
  return <div className={styles.markdown}>{markdown.split("\n").map((line, index) => {
    if (!line.trim()) return <div className={styles.blank} key={index} />;
    if (line.startsWith("# ")) return <h2 key={index}>{line.slice(2)}</h2>;
    if (line.startsWith("## ")) return <h3 key={index}>{linkedLine(line.slice(3), pages, select)}</h3>;
    return <p key={index}>{linkedLine(line, pages, select)}</p>;
  })}</div>;
}

export function KnowledgeWiki({ revision }: { revision: number }) {
  const [open, setOpen] = useState(false);
  const [pagePath, setPagePath] = useState("index.md");
  const [pages, setPages] = useState<Page[]>([]);
  const [selected, setSelected] = useState<Page>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<WikiMatch[]>([]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const parameters = new URLSearchParams({ page: pagePath });
        if (query) parameters.set("q", query);
        const response = await fetch(`/api/v1/knowledge/wiki?${parameters}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json() as WikiResponse;
        if (!response.ok) throw new Error(body.error?.message || `知识维基返回 ${response.status}`);
        setPages(body.data.pages);
        setSelected(body.data.selected);
        setMatches(body.data.matches ?? []);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "知识维基读取失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, pagePath, query, revision]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(draftQuery.trim().slice(0, 160));
  }

  const visible = pages.filter((page) => page.kind !== "source");
  return <section className={styles.root} aria-label="LLM Wiki 知识维基">
    <button type="button" className={styles.heading} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className={styles.icon}><BookOpenText size={20} /></span>
      <span><strong>LLM Wiki · 可追溯知识索引</strong><small>原始文件、主题汇编与处理记录分层管理；模型建议等待人工确认。</small></span>
      <ChevronDown size={18} className={open ? styles.chevronOpen : ""} />
    </button>
    {open && <div className={styles.body}>
      <div className={styles.sidebar}>
        <form className={styles.queryForm} onSubmit={search}>
          <label htmlFor="wiki-query">检索知识维基</label>
          <div><input id="wiki-query" value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} maxLength={160} placeholder="问题、型号或来源名称" /><button type="submit" disabled={loading}>检索</button></div>
        </form>
        {query && <div className={styles.results} aria-label="知识维基检索结果">
          <strong>相关页面 · {matches.length}</strong>
          {matches.length ? matches.map((match) => <button key={match.path} type="button" onClick={() => setPagePath(match.path)}><span>{match.title}</span><small>{match.excerpt}</small></button>) : !loading && <p>未找到相关页面。可以换个型号、类别或文件名。</p>}
        </div>}
        <div className={styles.browseLabel}>浏览维基页面</div>
        <div className={styles.pages}>{visible.map((page) => <button key={page.path} type="button" aria-current={page.path === pagePath ? "page" : undefined} onClick={() => setPagePath(page.path)}><span>{page.kind === "topic" ? "主题" : page.kind === "source" ? "来源" : page.kind === "log" ? "记录" : page.kind === "lint" ? "检查" : page.kind === "schema" ? "规则" : "首页"}</span>{page.title}</button>)}</div>
      </div>
      <article className={styles.article}>
        <div className={styles.articleHead}><span>{selected?.kind === "source" ? "原始来源索引" : selected?.kind === "topic" ? "主题汇编" : "知识维基"}</span><button type="button" disabled={loading} onClick={() => setPagePath("index.md")}><RefreshCw size={14} /> 返回索引</button></div>
        {error ? <p role="alert" className={styles.error}>{error}</p> : loading ? <p className={styles.empty}>正在读取知识维基…</p> : selected?.markdown ? <WikiMarkdown markdown={selected.markdown} pages={pages} select={setPagePath} /> : <p className={styles.empty}>上传资料后，这里会建立来源索引与主题页面。</p>}
      </article>
    </div>}
  </section>;
}
