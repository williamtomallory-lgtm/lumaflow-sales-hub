"use client";

import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Code2, Copy, Eye } from "lucide-react";
import hljs from "highlight.js/lib/core";
import xml from "highlight.js/lib/languages/xml";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import { splitFencedAnswer } from "@/lib/ai/fenced-code";
import { extractCompleteHtml } from "@/lib/ai/code-artifact";
import styles from "./code-answer.module.css";

for (const [name, grammar] of Object.entries({ html: xml, xml, svg: xml, javascript, js: javascript, jsx: javascript, typescript, ts: typescript, tsx: typescript, css, json, python, py: python, bash, sh: bash })) {
  hljs.registerLanguage(name, grammar);
}

const previewPolicy = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'";

function previewDocument(html: string) {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${previewPolicy}">`;
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + policy)
    : html.replace(/<html(?:\s[^>]*)?>/i, (root) => `${root}<head>${policy}</head>`);
}

function CodeCard({ content, language, preview, complete, streaming }: { content: string; language: string; preview: string | null; complete: boolean; streaming: boolean }) {
  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied] = useState(false);
  const syntax = hljs.getLanguage(language) ? language : /<!doctype\s+html|<html\b/i.test(content) ? "html" : "plaintext";
  const highlighted = useMemo(() => syntax === "plaintext" ? hljs.highlightAuto(content, []).value : hljs.highlight(content, { language: syntax, ignoreIllegals: true }).value, [content, syntax]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { /* Clipboard access depends on the browser context. */ }
  }
  return <section className={styles.card} aria-label={`${language || "代码"} 代码块`}>
    <header><span><Code2 size={16} /> {language.toUpperCase() || "代码"}{!complete && <small>{streaming ? "正在生成…" : "代码块未闭合"}</small>}</span><div>{preview && <button type="button" onClick={() => setShowPreview((value) => !value)} aria-label={showPreview ? "查看 HTML 代码" : "预览 HTML"}><Eye size={14} /> {showPreview ? "查看代码" : "预览"}</button>}<button type="button" onClick={() => void copy()} aria-label="复制代码">{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "已复制" : "复制"}</button></div></header>
    {showPreview && preview ? <iframe title="HTML 隔离预览" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={previewDocument(preview)} /> : <pre><code className={`hljs language-${syntax}`} dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>}
  </section>;
}

export function CodeAnswer({ text, complete = true }: { text: string; complete?: boolean }) {
  const segments = splitFencedAnswer(text);
  const fullHtml = complete ? extractCompleteHtml(text) : null;
  return <div>{segments.map((segment, index) => segment.kind === "code"
    ? <CodeCard key={index} content={segment.content} language={segment.language || "code"} complete={complete && segment.complete !== false} streaming={!complete} preview={fullHtml && segment.content.includes(fullHtml) ? fullHtml : null} />
    : <div className={styles.prose} key={index}><ReactMarkdown remarkPlugins={[remarkGfm]}>{segment.content}</ReactMarkdown></div>)}</div>;
}
