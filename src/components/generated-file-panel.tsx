"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileSpreadsheet, FileText, Maximize2, Minimize2, X } from "lucide-react";
import { extractCompleteHtml } from "@/lib/ai/code-artifact";
import { CodeAnswer } from "./code-answer";
import styles from "./generated-file-panel.module.css";

export type GeneratedFileKind = "document" | "html" | "spreadsheet";

const previewPolicy = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'";

function safeName(title: string) {
  return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim().slice(0, 48) || "LumaFlow-文稿";
}

function secureHtml(html: string) {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${previewPolicy}">`;
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + policy)
    : html.replace(/<html(?:\s[^>]*)?>/i, (root) => `${root}<head>${policy}</head>`);
}

function downloadText(content: string, title: string, extension: string, mimeType: string) {
  downloadBlob(new Blob([content], { type: `${mimeType};charset=utf-8` }), title, extension);
}

function downloadBlob(blob: Blob, title: string, extension: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeName(title)}.${extension}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function GeneratedFilePanel({ title, content, kind, preferredFormat, autoDownloadPdf = false, busy, onClose }: { title: string; content: string; kind: GeneratedFileKind; preferredFormat?: "pdf" | "docx" | "xlsx"; autoDownloadPdf?: boolean; busy: boolean; onClose: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const pageRef = useRef<HTMLDivElement>(null);
  const autoDownloadStarted = useRef(false);
  const downloadPdfRef = useRef<() => Promise<void>>(async () => {});
  const html = kind === "html" ? extractCompleteHtml(content) : null;

  async function downloadOffice(format: "docx" | "xlsx") {
    if (!content || busy || exporting) return;
    setError(""); setExporting(true);
    try {
      const { createWordDocument, createExcelWorkbook } = await import("@/lib/ai/generated-office-files");
      const blob = format === "docx" ? await createWordDocument(content) : await createExcelWorkbook(content);
      downloadBlob(blob, title, format);
    } catch { setError(format === "docx" ? "Word 文件生成失败，请下载 Markdown 原文。" : "Excel 文件生成失败，请检查表格内容或下载 Markdown 原文。"); }
    finally { setExporting(false); }
  }

  async function downloadPdf() {
    if (!pageRef.current || exporting) return;
    setError(""); setExporting(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas"), import("jspdf")]);
      const element = pageRef.current;
      const canvas = await html2canvas(element, { scale: 1.7, backgroundColor: "#ffffff", logging: false, windowWidth: element.scrollWidth, windowHeight: element.scrollHeight });
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const widthMm = 190;
      const pagePixels = Math.floor(canvas.width * 277 / widthMm);
      for (let top = 0, page = 0; top < canvas.height; top += pagePixels, page += 1) {
        const height = Math.min(pagePixels, canvas.height - top);
        const slice = document.createElement("canvas");
        slice.width = canvas.width; slice.height = height;
        slice.getContext("2d")?.drawImage(canvas, 0, top, canvas.width, height, 0, 0, canvas.width, height);
        if (page) pdf.addPage();
        pdf.addImage(slice.toDataURL("image/jpeg", 0.9), "JPEG", 10, 10, widthMm, height * widthMm / canvas.width);
      }
      downloadBlob(pdf.output("blob"), title, "pdf");
    } catch { setError("PDF 生成失败；仍可下载 Markdown 原文。"); }
    finally { setExporting(false); }
  }

  downloadPdfRef.current = downloadPdf;
  useEffect(() => {
    if (!autoDownloadPdf || busy || !content || autoDownloadStarted.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (autoDownloadStarted.current) return;
      autoDownloadStarted.current = true;
      void downloadPdfRef.current();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoDownloadPdf, busy, content]);

  return <aside className={`${styles.panel} ${expanded ? styles.expanded : ""}`} aria-label="生成文件预览">
    <header className={styles.topbar}><span>{kind === "spreadsheet" ? <FileSpreadsheet size={17} /> : <FileText size={17} />} {kind === "html" ? "HTML 预览" : kind === "spreadsheet" ? "表格预览" : "文档预览"}</span><div><button type="button" aria-label={expanded ? "退出全屏预览" : "全屏预览"} onClick={() => setExpanded((value) => !value)}>{expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button><button type="button" aria-label="关闭文件预览" onClick={onClose}><X size={18} /></button></div></header>
    <div className={styles.toolbar}><strong title={title}>{safeName(title)}.{kind === "html" ? "html" : preferredFormat ?? (kind === "spreadsheet" ? "xlsx" : "docx")}</strong><span>{busy ? "生成中，预览随内容更新" : "完整内容"}</span><div>{kind === "html" ? <button type="button" disabled={!html || busy} onClick={() => html && downloadText(html, title, "html", "text/html")}><Download size={14} /> 下载 HTML</button> : <>{preferredFormat === "pdf" && <button type="button" className={styles.primaryDownload} disabled={!content || busy || exporting} onClick={() => void downloadPdf()}><Download size={14} /> {exporting ? "生成中…" : "下载 PDF"}</button>}{kind === "spreadsheet" ? <button type="button" disabled={!content || busy || exporting} onClick={() => void downloadOffice("xlsx")}><Download size={14} /> {exporting ? "生成中…" : "下载 Excel"}</button> : <button type="button" disabled={!content || busy || exporting} onClick={() => void downloadOffice("docx")}><Download size={14} /> {exporting ? "生成中…" : "下载 Word"}</button>}{preferredFormat !== "pdf" && <button type="button" disabled={!content || busy || exporting} onClick={() => void downloadPdf()}><Download size={14} /> {exporting ? "生成中…" : "下载 PDF"}</button>}<button type="button" disabled={!content} onClick={() => downloadText(content, title, "md", "text/markdown")}><Download size={14} /> 下载 Markdown</button></>}</div></div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {kind === "html" && html ? <iframe className={styles.htmlFrame} title="生成的 HTML 页面预览" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={secureHtml(html)} /> : <div className={styles.scroll}><div ref={pageRef} className={styles.paper}>{content ? <CodeAnswer text={content} complete={!busy} /> : <p className={styles.waiting}>正在生成内容，完整预览会显示在这里…</p>}</div></div>}
  </aside>;
}
