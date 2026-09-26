"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, Plus, ArrowLeft, Upload, Trash2, X, ChevronRight, ChevronDown, Eye, MoreHorizontal, Pin } from "lucide-react";
import { type Project } from "@/lib/contracts/project";
import type { LocalChatSummary } from "@/lib/contracts/chat-history";
import { ProjectContextMenu, ProjectEditDialog, ProjectSectionDialog } from "./project-actions";
import { WorkspaceFolderField } from "./workspace-folder-field";
import { ConversationHistoryList } from "./conversation-history-list";
import styles from "./project-workspace.module.css";
export async function projectRequest<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result?.error?.message || "项目操作失败"); return result.data;
}
export function projectsUpdated() { window.dispatchEvent(new Event("lumaflow-projects-updated")); }
export function ProjectSidebar({ selectedId, onSelect, onToast, recentContent, recentAvailable = true, onOpenChat, onRemoved }: { selectedId?: string | null; onSelect: (id: string) => void; onToast?: (text: string) => void; recentContent?: ReactNode; recentAvailable?: boolean; onOpenChat?: (chatId: string, projectId: string | null) => void; onRemoved?: (id: string) => void }) {
  const [sectionProject, setSectionProject] = useState<Project | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ project: Project; x: number; y: number } | null>(null);
  const [editingProject, setEditingProject] = useState<{ project: Project; remove: boolean } | null>(null);
  const closeProjectMenu = useCallback(() => setProjectMenu(null), []);
  const [tab, setTab] = useState<"recent" | "projects">(recentContent ? "recent" : "projects");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [projectChats, setProjectChats] = useState<Record<string, LocalChatSummary[]>>({});
  const [recentChats, setRecentChats] = useState<LocalChatSummary[]>([]);
  const [loadingProject, setLoadingProject] = useState<string | null>(null);
  async function loadChats(id: string) {
    setLoadingProject(id);
    try { const result = await projectRequest<{ chats: LocalChatSummary[] }>(`/api/v1/projects?id=${id}`); setProjectChats((old) => ({ ...old, [id]: result.chats })); }
    catch (issue) { onToast?.((issue as Error).message); }
    finally { setLoadingProject(null); }
  }
  async function changeChat(chatId: string, patch: { title?: string; pinned?: boolean }, id?: string) {
    try { await projectRequest(`/api/v1/assistant/history?id=${chatId}`, "PATCH", patch); if (id) await loadChats(id); window.dispatchEvent(new Event("lumaflow-chat-history-updated")); }
    catch (issue) { onToast?.((issue as Error).message); }
  }
  useEffect(() => { const refreshRecent = () => { void projectRequest<LocalChatSummary[]>("/api/v1/assistant/history").then(setRecentChats).catch(() => {}); }; refreshRecent(); window.addEventListener("lumaflow-chat-history-updated", refreshRecent); return () => window.removeEventListener("lumaflow-chat-history-updated", refreshRecent); }, []);
  useEffect(() => {
    const refreshExpanded = () => { for (const id of Object.keys(expanded).filter((id) => expanded[id])) void projectRequest<{ chats: LocalChatSummary[] }>(`/api/v1/projects?id=${id}`).then((result) => setProjectChats((old) => ({ ...old, [id]: result.chats }))).catch(() => {}); };
    window.addEventListener("lumaflow-chat-history-updated", refreshExpanded); return () => window.removeEventListener("lumaflow-chat-history-updated", refreshExpanded);
  }, [expanded]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [memoryMode, setMemoryMode] = useState<Project["memoryMode"]>("project-only");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const imported = useRef<Map<File, string>>(new Map());
  const createButton = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(() => { void projectRequest<Project[]>("/api/v1/projects").then(setProjects).catch(() => {}); }, []);
  useEffect(() => { refresh(); window.addEventListener("lumaflow-projects-updated", refresh); return () => window.removeEventListener("lumaflow-projects-updated", refresh); }, [refresh]);
  function close() { if (busy) return; setCreating(false); setError(""); createButton.current?.focus(); }
  async function create() {
    if (busy || !name.trim()) return;
    setBusy(true); setError("");
    try {
      for (const file of files) {
        if (imported.current.has(file)) continue;
        const body = new FormData(); body.set("file", file);
        const response = await fetch("/api/v1/knowledge", { method: "POST", body });
        const result = await response.json();
        if (!response.ok || !result.data?.id) throw new Error(result?.error?.message || `无法添加文件：${file.name}`);
        imported.current.set(file, result.data.id);
      }
      const project = await projectRequest<Project>("/api/v1/projects", "POST", { name: name.trim(), memoryMode, knowledgeBaseIds: files.map((file) => imported.current.get(file)!) });
      projectsUpdated(); setCreating(false); setName(""); setFiles([]); imported.current.clear(); onSelect(project.id);
    } catch (issue) { setError((issue as Error).message); onToast?.((issue as Error).message); }
    finally { setBusy(false); }
  }
  const modal = creating && createPortal(<div className={styles.overlay} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className={styles.createDialog} role="dialog" aria-modal="true" aria-labelledby="create-project-title" onKeyDown={(event) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')).filter((item) => item.getClientRects().length > 0);
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><h2 id="create-project-title">创建项目</h2><button type="button" aria-label="关闭创建项目" disabled={busy} onClick={close}><X size={20} /></button></header>
      <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label>项目名称<input aria-label="新项目名称" value={name} maxLength={80} disabled={busy} onChange={(event) => setName(event.target.value)} placeholder="例如：论文研究" autoFocus /></label>
        <label>源文件夹 <small>可选</small></label>
        <div className={styles.folderUpload}><FolderOpen size={27} /><p>添加此电脑上的文件夹，导入项目参考资料</p><label className={styles.folderButton}>添加文件夹<input aria-label="添加源文件夹" type="file" multiple {...{ webkitdirectory: "", directory: "" }} disabled={busy} onChange={(event) => { const selected = Array.from(event.target.files || []); if (selected.length > 50) { setError("一个项目最多添加 50 个文件，请选择较小的文件夹。"); return; } setFiles(selected); setError(""); }} /></label>{files.length > 0 && <p>已选择 {files.length} 个文件 <button type="button" disabled={busy} onClick={() => setFiles([])}>移除</button></p>}</div>
        <p className={styles.createHint}>将 Chat、Work 对话、文件和项目规则集中保存，持续延续同一个项目的背景。</p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <footer><label>项目记忆<select aria-label="新项目记忆" value={memoryMode} disabled={busy} onChange={(event) => setMemoryMode(event.target.value as Project["memoryMode"])}><option value="project-only">仅此项目</option><option value="default">默认记忆</option></select></label><button type="submit" className={styles.primary} disabled={busy || !name.trim()}>{busy ? "正在创建…" : "创建项目"}</button></footer>
      </form>
    </section>
  </div>, document.body);
  return <section className={styles.sidebar} aria-label="最近与项目">
    {recentContent && <div className={styles.sidebarTabs} role="tablist" aria-label="对话导航"><button role="tab" aria-selected={tab === "recent"} onClick={() => setTab("recent")}>最近</button><button role="tab" aria-selected={tab === "projects"} onClick={() => setTab("projects")}>项目</button></div>}
    {recentContent && <div hidden={tab !== "recent"} role="tabpanel" aria-label="最近对话"><div hidden={!recentAvailable}>{recentContent}</div>{!recentAvailable && <ConversationHistoryList items={recentChats} onSelect={(id) => { const chat = recentChats.find((item) => item.id === id); onOpenChat?.(id, chat?.projectId || null); }} onRename={(id, title) => void changeChat(id, { title })} onPin={(id, pinned) => void changeChat(id, { pinned })} />}</div>}
    <div hidden={tab !== "projects"} role="tabpanel" aria-label="项目"><header><strong>项目</strong><button ref={createButton} aria-label="创建项目" title="创建项目" onClick={() => setCreating(true)}><Plus size={17} /></button></header>
    {projects.length === 0 && <p className={styles.sidebarHint}>点击加号创建项目</p>}
    {[...projects].sort((a, b) => (a.sectionName || "").localeCompare(b.sectionName || "")).map((project, index, list) => <div className={styles.projectGroup} key={project.id}>{project.sectionName && (index === 0 || list[index - 1].sectionName !== project.sectionName) && <h4 className={styles.sectionHeading}>{project.sectionName}</h4>}<div className={styles.projectRow} onContextMenu={(event) => { event.preventDefault(); setProjectMenu({ project, x: event.clientX, y: event.clientY }); }}><button aria-label={`${expanded[project.id] ? "收起" : "展开"}项目 ${project.name}`} aria-expanded={Boolean(expanded[project.id])} onClick={() => { const opening = !expanded[project.id]; setExpanded((old) => ({ ...old, [project.id]: opening })); if (opening) void loadChats(project.id); }}>{expanded[project.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button><button className={selectedId === project.id ? styles.selected : ""} onClick={() => onSelect(project.id)} title={`${project.name}\n${project.instructions || "尚未设置项目规则"}\n${project.knowledgeBaseIds.length} 个文件 · ${project.sources.length} 份资料`}><FolderOpen size={16} /><span>{project.name}</span>{project.pinned && <Pin size={12} />}</button><button className={styles.previewButton} aria-label={`预览项目 ${project.name}`} title="预览项目" onClick={() => onSelect(project.id)}><Eye size={15} /></button><button aria-label={`项目更多操作 ${project.name}`} aria-haspopup="menu" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setProjectMenu({ project, x: rect.right, y: rect.bottom }); }}><MoreHorizontal size={16} /></button></div>
    {expanded[project.id] && <div className={styles.projectChildren}>{loadingProject === project.id ? <p>正在读取…</p> : <ConversationHistoryList hideToolbar items={projectChats[project.id] || []} onSelect={(id) => onOpenChat?.(id, project.id)} onRename={(id, title) => void changeChat(id, { title }, project.id)} onPin={(id, pinned) => void changeChat(id, { pinned }, project.id)} />}</div>}</div>)}
    </div>{modal}
    {projectMenu && <ProjectContextMenu project={projectMenu.project} position={projectMenu} onClose={closeProjectMenu} onEdit={() => setEditingProject({ project: projectMenu.project, remove: false })} onRemove={() => setEditingProject({ project: projectMenu.project, remove: true })} onSection={() => setSectionProject(projectMenu.project)} onToast={onToast} />}
    {sectionProject && <ProjectSectionDialog project={sectionProject} sections={[...new Set(projects.map((project) => project.sectionName).filter(Boolean))]} onClose={() => setSectionProject(null)} />}
    {editingProject && <ProjectEditDialog key={editingProject.project.id} project={editingProject.project} remove={editingProject.remove} onClose={() => setEditingProject(null)} onRemoved={onRemoved} />}
  </section>;
}
export function ProjectPicker({ onChoose, onClose }: { onChoose: (id: string | null) => void; onClose: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]); const [error, setError] = useState("");
  useEffect(() => { void projectRequest<Project[]>("/api/v1/projects").then(setProjects).catch((issue) => setError(issue.message)); }, []);
  return <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="移至项目"><section><h3>移至项目</h3><button onClick={() => onChoose(null)}>移出项目，作为独立对话</button>{projects.map((project) => <button key={project.id} onClick={() => onChoose(project.id)}><FolderOpen size={15} /> {project.name}</button>)}{!projects.length && <p>{error || "请先在左侧创建一个项目。"}</p>}<button onClick={onClose}>取消</button></section></div>;
}
export function ProjectWorkspace({ projectId, onNewChat, onOpenChat, onBack, onToast }: { projectId: string; onNewChat: (id: string, experience: "chat" | "work") => void; onOpenChat: (chatId: string, projectId: string) => void; onBack: () => void; onToast?: (text: string) => void }) {
  const [experience, setExperience] = useState<"chat" | "work">("chat");
  const [project, setProject] = useState<Project | null>(null); const [chats, setChats] = useState<LocalChatSummary[]>([]); const [files, setFiles] = useState<Array<{ id: string; title: string }>>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [sourceTitle, setSourceTitle] = useState(""); const [sourceText, setSourceText] = useState(""); const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { let active = true; void projectRequest<{ project: Project; chats: LocalChatSummary[] }>(`/api/v1/projects?id=${projectId}`).then((result) => { if (active) { setProject(result.project); setChats(result.chats); } }).catch((issue) => { if (active) setError(issue.message); }); void (async () => { const all: Array<{ id: string; title: string }> = []; for (let offset = 0; ; offset += 200) { const page = await projectRequest<Array<{ id: string; title: string }>>(`/api/v1/knowledge?limit=200&offset=${offset}`); all.push(...page); if (page.length < 200 || !active) break; } return all; })().then((items) => { if (active) setFiles(items); }).catch(() => {}); return () => { active = false; }; }, [projectId]);
  async function save(next = project) { if (!next) return false; setBusy(true); setError(""); try { const result = await projectRequest<Project>(`/api/v1/projects?id=${projectId}`, "PATCH", { name: next.name, instructions: next.instructions, knowledgeBaseIds: next.knowledgeBaseIds, sources: next.sources, memoryMode: next.memoryMode, ...(next.workspace !== undefined ? { workspace: next.workspace } : {}) }); setProject(result); projectsUpdated(); onToast?.("项目设置已保存，新对话会使用项目背景。"); return true; } catch (issue) { setError((issue as Error).message); return false; } finally { setBusy(false); } }
  async function upload(selected: FileList | null) { if (!selected || !project) return; if (project.knowledgeBaseIds.length + selected.length > 50) { setError("一个项目最多添加 50 个文件。"); return; } setBusy(true); setError(""); try { const ids = [...project.knowledgeBaseIds]; const uploaded: Array<{ id: string; title: string }> = []; for (const file of Array.from(selected)) { const body = new FormData(); body.set("file", file); const response = await fetch("/api/v1/knowledge", { method: "POST", body }); const payload = await response.json(); if (!response.ok) throw new Error(payload?.error?.message || "上传失败"); const entry = payload.data; if (!entry?.id) throw new Error("文件上传没有返回记录"); ids.push(entry.id); uploaded.push({ id: entry.id, title: entry.title || file.name }); } setFiles((old) => [...uploaded, ...old]); await save({ ...project, knowledgeBaseIds: [...new Set(ids)].slice(0, 50) }); } catch (issue) { setError((issue as Error).message); } finally { setBusy(false); } }
  if (!project) return <section className={styles.page}><p>{error || "正在读取项目…"}</p><button onClick={onBack}>返回</button></section>;
  return <section className={styles.page} aria-label="项目工作区"><div className={styles.modeTabs} role="group" aria-label="项目工作模式"><button aria-pressed={experience === "chat"} onClick={() => setExperience("chat")}>Chat</button><button aria-pressed={experience === "work"} onClick={() => setExperience("work")}>Work</button></div><header><button onClick={onBack}><ArrowLeft size={16} /> 返回聊天</button><h1><FolderOpen size={24} /> {project.name}</h1><button className={styles.primary} disabled={busy} onClick={() => onNewChat(projectId, experience)}><Plus size={16} /> 新聊天</button></header>{error && <p role="alert" className={styles.error}>{error}</p>}<div className={styles.grid}><section><h2>聊天</h2>{chats.length ? chats.map((chat) => <button className={styles.chat} key={chat.id} onClick={() => onOpenChat(chat.id, projectId)}><span>{chat.title}</span><small>{chat.experience === "work" ? "Work" : "Chat"}</small></button>) : <p>围绕同一个项目创建多条独立对话，共用项目背景。</p>}<h2>项目资料 Sources</h2>{project.sources.map((source) => <details key={source.id}><summary>{source.title}</summary><p className={styles.source}>{source.text}</p><button disabled={busy} onClick={() => void save({ ...project, sources: project.sources.filter((item) => item.id !== source.id) })}><Trash2 size={14} /> 删除资料</button></details>)}<label>资料标题<input value={sourceTitle} maxLength={120} onChange={(event) => setSourceTitle(event.target.value)} /></label><label>资料正文<textarea value={sourceText} maxLength={150_000} onChange={(event) => setSourceText(event.target.value)} placeholder="保存重要结论、背景或资料来源…" /></label><button disabled={busy || !sourceTitle.trim() || !sourceText.trim()} onClick={async () => { const saved = await save({ ...project, sources: [...project.sources, { id: crypto.randomUUID(), title: sourceTitle, text: sourceText, createdAt: new Date().toISOString() }] }); if (saved) { setSourceTitle(""); setSourceText(""); } }}>保存为项目资料</button></section><section><h2>项目设置</h2><label>项目名称<input value={project.name} maxLength={80} onChange={(event) => setProject({ ...project, name: event.target.value })} /></label><label>项目规则<textarea value={project.instructions} maxLength={12_000} onChange={(event) => setProject({ ...project, instructions: event.target.value })} placeholder="例如：保持学术风格，结果必须依据项目中的实验数据。" /></label><label>项目记忆<select aria-label="项目记忆" value={project.memoryMode} onChange={(event) => setProject({ ...project, memoryMode: event.target.value as Project["memoryMode"] })}><option value="project-only">仅此项目</option><option value="default">默认记忆</option></select></label><p>{project.memoryMode === "project-only" ? "仅参考本项目历史聊天、资料和文件节选。" : "可使用本机全局记忆与历史搜索，项目规则优先。"}</p><WorkspaceFolderField label="项目工作目录" hint="项目关联的本机文件夹，资源管理器将打开此目录。" value={project.workspace || ""} onChange={(workspace) => setProject({ ...project, workspace })} disabled={busy} /><h2>项目文件</h2><label className={styles.upload}><Upload size={15} /> 上传资料<input type="file" multiple disabled={busy} onChange={(event) => void upload(event.target.files)} /></label><div className={styles.files}>{files.map((file) => <label key={file.id}><input type="checkbox" checked={project.knowledgeBaseIds.includes(file.id)} disabled={busy || (!project.knowledgeBaseIds.includes(file.id) && project.knowledgeBaseIds.length >= 50)} onChange={(event) => setProject({ ...project, knowledgeBaseIds: event.target.checked ? [...project.knowledgeBaseIds, file.id] : project.knowledgeBaseIds.filter((id) => id !== file.id) })} />{file.title}</label>)}</div><button className={styles.primary} disabled={busy || !project.name.trim()} onClick={() => void save()}>{busy ? "正在保存…" : "保存设置"}</button><hr />{confirmDelete ? <div><p>删除项目会保留聊天和文件，并移出项目。</p><button disabled={busy} onClick={async () => { try { await projectRequest(`/api/v1/projects?id=${projectId}`, "DELETE"); projectsUpdated(); onBack(); } catch (issue) { setError((issue as Error).message); } }}>确认删除项目</button><button onClick={() => setConfirmDelete(false)}>取消</button></div> : <button onClick={() => setConfirmDelete(true)}>删除项目</button>}</section></div></section>;
}
