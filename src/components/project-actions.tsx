"use client";
import { useEffect, useRef, useState } from "react";
import { FolderOpen, Pin, PinOff, Settings, X, List } from "lucide-react";
import { createPortal } from "react-dom";
import type { Project } from "@/lib/contracts/project";
import { projectRequest, projectsUpdated } from "./project-workspace";
import { WorkspaceFolderField } from "./workspace-folder-field";
import styles from "./project-actions.module.css";
export function ProjectContextMenu({ project, position, onClose, onEdit, onRemove, onSection, onToast }: { project: Project; position: { x: number; y: number }; onClose: () => void; onEdit: () => void; onRemove: () => void; onSection: () => void; onToast?: (text: string) => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape); window.addEventListener("resize", onClose);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); window.removeEventListener("resize", onClose); };
  }, [onClose]);
  async function pin() { onClose(); try { await projectRequest(`/api/v1/projects?id=${project.id}`, "PATCH", { pinned: !project.pinned }); projectsUpdated(); } catch (error) { onToast?.((error as Error).message); } }
  async function openFolder() { onClose(); try { await projectRequest("/api/v1/projects/workspace", "POST", { projectId: project.id }); } catch (error) { onToast?.((error as Error).message); } }
  return createPortal(<div ref={menu} className={styles.menu} role="menu" aria-label={`项目 ${project.name} 操作`} style={{ left: Math.max(8, Math.min(position.x, window.innerWidth - 218)), top: Math.max(8, Math.min(position.y, window.innerHeight - 270)) }} onKeyDown={(event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button")); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
  }}>
    <button type="button" role="menuitem" onClick={() => void pin()}>{project.pinned ? <PinOff size={17} /> : <Pin size={17} />}{project.pinned ? "取消置顶" : "置顶"}</button>
    <button type="button" role="menuitem" onClick={() => { onClose(); onEdit(); }}><Settings size={17} />编辑项目</button>
    <button type="button" role="menuitem" onClick={() => void openFolder()}><FolderOpen size={17} />在资源管理器中打开</button>
    <button type="button" role="menuitem" onClick={() => { onClose(); onSection(); }}><List size={17} />分区</button>
    <hr /><button type="button" role="menuitem" className={styles.danger} onClick={() => { onClose(); onRemove(); }}><X size={17} />移除项目</button>
  </div>, document.body);
}
export function ProjectEditDialog({ project, remove = false, onClose, onRemoved }: { project: Project; remove?: boolean; onClose: () => void; onRemoved?: (id: string) => void }) {
  const [name, setName] = useState(project.name); const [workspace, setWorkspace] = useState(project.workspace || "");
  const [confirmRemove, setConfirmRemove] = useState(remove); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const section = useRef<HTMLElement>(null);
  useEffect(() => { section.current?.querySelector<HTMLInputElement>("input")?.focus(); }, []);
  async function save() { setBusy(true); setError(""); try { await projectRequest(`/api/v1/projects?id=${project.id}`, "PATCH", { name, workspace }); projectsUpdated(); onClose(); } catch (issue) { setError((issue as Error).message); } finally { setBusy(false); } }
  async function removeProject() { setBusy(true); setError(""); try { await projectRequest(`/api/v1/projects?id=${project.id}`, "DELETE"); projectsUpdated(); window.dispatchEvent(new Event("lumaflow-chat-history-updated")); onRemoved?.(project.id); onClose(); } catch (issue) { setError((issue as Error).message); } finally { setBusy(false); } }
  return createPortal(<div className={styles.overlay} onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section ref={section} className={styles.dialog} role="dialog" aria-modal="true" aria-label={confirmRemove ? "移除项目确认" : "编辑项目"} onKeyDown={(event) => {
    if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
    if (event.key === "Tab") { const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')); const first = controls[0]; const last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}><header><h2>{confirmRemove ? "移除项目" : "编辑项目"}</h2><button type="button" aria-label="关闭编辑项目" disabled={busy} onClick={onClose}><X size={19} /></button></header>
    {confirmRemove ? <p>移除“{project.name}”？已有聊天会保留为独立对话，文件和工作目录会保留。</p> : <><label className={styles.name}>项目名称<input aria-label="编辑项目名称" value={name} maxLength={80} disabled={busy} onChange={(event) => setName(event.target.value)} /></label><WorkspaceFolderField value={workspace} onChange={setWorkspace} label="工作目录（源文件夹）" inputLabel="项目工作目录" hint="项目关联的本机文件夹，资源管理器将打开此目录；留空使用项目默认目录。" disabled={busy} />{workspace && <button type="button" className={styles.clear} disabled={busy} onClick={() => setWorkspace("")}><X size={14} />移除源文件夹，使用默认目录</button>}</>}
    {error && <p role="alert" className={styles.danger}>{error}</p>}<footer>{!confirmRemove && <button type="button" className={styles.danger} disabled={busy} onClick={() => setConfirmRemove(true)}>移除本地项目</button>}<span /><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className={confirmRemove ? styles.danger : styles.primary} disabled={busy || (!confirmRemove && !name.trim())} onClick={() => void (confirmRemove ? removeProject() : save())}>{busy ? "正在保存…" : confirmRemove ? "确认移除" : "保存"}</button></footer>
  </section></div>, document.body);
}

export function ProjectSectionDialog({ project, sections, onClose }: { project: Project; sections: string[]; onClose: () => void }) {
  const [name, setName] = useState(project.sectionName || ""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function assign(sectionName: string) { setBusy(true); setError(""); try { await projectRequest(`/api/v1/projects?id=${project.id}`, "PATCH", { sectionName }); projectsUpdated(); onClose(); } catch (issue) { setError((issue as Error).message); } finally { setBusy(false); } }
  return createPortal(<div className={styles.overlay}><section className={styles.dialog} role="dialog" aria-modal="true" aria-label="新建分区" onKeyDown={(event) => { if (event.key === "Escape" && !busy) onClose(); }}><header><h2>新建分区</h2><button type="button" aria-label="关闭分区弹窗" disabled={busy} onClick={onClose}><X size={18} /></button></header><p>整理聊天和项目，将“{project.name}”放入一个项目分组。</p><form onSubmit={(event) => { event.preventDefault(); if (name.trim()) void assign(name); }}><label className={styles.name}>分区名称<input aria-label="分区名称" value={name} maxLength={80} autoFocus disabled={busy} onChange={(event) => setName(event.target.value)} placeholder="分区名称" /></label>{sections.length > 0 && <div className={styles.sectionChoices}><small>现有分区</small>{sections.map((section) => <button type="button" key={section} disabled={busy} onClick={() => void assign(section)}>{section}</button>)}</div>}{error && <p role="alert" className={styles.danger}>{error}</p>}<footer>{project.sectionName && <button type="button" disabled={busy} onClick={() => void assign("")}>移出分区</button>}<span /><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className={styles.primary} disabled={busy || !name.trim()}>{busy ? "正在保存…" : "创建分区"}</button></footer></form></section></div>, document.body);
}
