"use client";
import { useState } from "react";
import { FolderOpen } from "lucide-react";
import styles from "./workspace-folder-field.module.css";
export function WorkspaceFolderField({ value, onChange, label = "工作间（文件夹）", inputLabel = label, disabled = false, hint = "用于存储 Agent 生成的文件；留空会自动创建专属目录。" }: { value: string; onChange: (path: string) => void; label?: string; inputLabel?: string; disabled?: boolean; hint?: string }) {
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState("");
  async function browse() {
    if (selecting) return;
    setSelecting(true); setError("");
    try {
      const response = await fetch("/api/v1/local/folder-picker", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initialPath: value }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message || "无法选择文件夹");
      if (!result.data.cancelled && result.data.path) onChange(result.data.path);
    } catch (issue) { setError((issue as Error).message); }
    finally { setSelecting(false); }
  }
  return <div className={styles.field}><label>{label}<span className={styles.row}><input aria-label={inputLabel} value={value} maxLength={2000} placeholder="留空则自动创建专属工作间" disabled={disabled || selecting} onChange={(event) => onChange(event.target.value)} /><button type="button" disabled={disabled || selecting} onClick={() => void browse()}><FolderOpen size={16} />{selecting ? "选择中…" : "浏览"}</button></span></label><small>{hint}</small>{selecting && <small role="status">请在系统窗口中选择文件夹，或取消返回。</small>}{error && <small role="alert" className={styles.error}>{error}</small>}</div>;
}
