"use client";
import { cloneElement, isValidElement, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, Plus, ArrowLeft, Upload, Trash2, X, ChevronRight, ChevronDown, Eye, MoreHorizontal, Pin } from "lucide-react";
import { type Project } from "@/lib/contracts/project";
import type { LocalChatSummary } from "@/lib/contracts/chat-history";
import { wechatConversationPageSchema, wechatMessagePageSchema, type WechatConversation } from "@/lib/contracts/wechat-conversation";
import { ProjectContextMenu, ProjectEditDialog, ProjectSectionDialog } from "./project-actions";
import { WorkspaceFolderField } from "./workspace-folder-field";
import { ConversationHistoryList, type ConversationHistoryItem } from "./conversation-history-list";
import styles from "./project-workspace.module.css";
export type HistoryCategory = "chat" | "work" | "image" | "wechat";
const historyCategoryLabels: Record<HistoryCategory, string> = { chat: "Chat", work: "Work", image: "Image", wechat: "Wechat Agent" };
export async function projectRequest<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result?.error?.message || "项目操作失败"); return result.data;
}
async function wechatHistoryRequest<T>(url: string, schema: { parse: (value: unknown) => T }, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal, headers: { Accept: "application/json" } });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message || "微信 Agent 历史暂不可用");
  return schema.parse(result?.data);
}
export function projectsUpdated() { window.dispatchEvent(new Event("lumaflow-projects-updated")); }
export function ProjectSidebar({ selectedId, onSelect, onToast, recentContent, recentAvailable = true, onOpenChat, onOpenHistory, onRemoved, onNewHistory }: { selectedId?: string | null; onSelect: (id: string) => void; onToast?: (text: string) => void; recentContent?: ReactNode; recentAvailable?: boolean; onOpenChat?: (chatId: string, projectId: string | null) => void; onOpenHistory?: (category: HistoryCategory, id: string, projectId?: string | null) => void; onRemoved?: (id: string) => void; onNewHistory?: (category: HistoryCategory) => void }) {
  const [sectionProject, setSectionProject] = useState<Project | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ project: Project; x: number; y: number } | null>(null);
  const [editingProject, setEditingProject] = useState<{ project: Project; remove: boolean } | null>(null);
  const closeProjectMenu = useCallback(() => setProjectMenu(null), []);
  const [historyCategory, setHistoryCategory] = useState<HistoryCategory>("chat");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [projectChats, setProjectChats] = useState<Record<string, LocalChatSummary[]>>({});
  const [recentChats, setRecentChats] = useState<LocalChatSummary[]>([]);
  const [wechatChats, setWechatChats] = useState<WechatConversation[]>([]);
  const [wechatCursor, setWechatCursor] = useState<string | null>(null);
  const [wechatPaging, setWechatPaging] = useState(false);
  const [wechatSearchQuery, setWechatSearchQuery] = useState("");
  const [wechatSearchText, setWechatSearchText] = useState<Record<string, string>>({});
  const wechatSearchController = useRef<AbortController | null>(null);
  const wechatAllLoadedRef = useRef(false);
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
  const refreshWechat = useCallback(async () => {
    wechatAllLoadedRef.current = false;
    try {
      const page = await wechatHistoryRequest("/api/v1/wechat-agent?action=conversations", wechatConversationPageSchema);
      setWechatChats(page.items);
      setWechatCursor(page.nextCursor ?? null);
    } catch {
      // A disconnected WeChat runtime still leaves the local history shell usable.
    }
  }, []);
  useEffect(() => {
    if (historyCategory !== "wechat") return;
    queueMicrotask(() => { void refreshWechat(); });
    window.addEventListener("lumaflow-wechat-agent-updated", refreshWechat);
    return () => window.removeEventListener("lumaflow-wechat-agent-updated", refreshWechat);
  }, [historyCategory, refreshWechat]);
  useEffect(() => {
    wechatSearchController.current?.abort();
    const needle = wechatSearchQuery.trim().toLocaleLowerCase();
    if (!needle) {
      queueMicrotask(() => setWechatSearchText({}));
      wechatSearchController.current = null;
      return;
    }
    const controller = new AbortController();
    wechatSearchController.current = controller;
    const readSearchText = async () => {
      let searchableConversations = wechatChats;
      let remainingCursor = wechatCursor || undefined;
      if (!wechatAllLoadedRef.current) {
        try {
          const loaded = [...wechatChats];
          while (remainingCursor && !controller.signal.aborted) {
            const params = new URLSearchParams({ action: "conversations", cursor: remainingCursor });
            const page = await wechatHistoryRequest(`/api/v1/wechat-agent?${params.toString()}`, wechatConversationPageSchema, controller.signal);
            loaded.push(...page.items);
            remainingCursor = page.nextCursor ?? undefined;
          }
          if (!controller.signal.aborted) {
            searchableConversations = [...new Map(loaded.map((item) => [item.id, item])).values()];
            wechatAllLoadedRef.current = true;
            if (searchableConversations.length !== wechatChats.length || wechatCursor) {
              setWechatChats(searchableConversations);
              setWechatCursor(null);
            }
          }
        } catch {
          if (controller.signal.aborted) return;
        }
      }
      const results = await Promise.all(searchableConversations.map(async (conversation) => {
        const chunks = [conversation.title, conversation.preview || ""];
        let cursor: string | undefined;
        try {
          do {
            const params = new URLSearchParams({ action: "messages", conversationId: conversation.id });
            if (cursor) params.set("cursor", cursor);
            const page = await wechatHistoryRequest(`${"/api/v1/wechat-agent"}?${params.toString()}`, wechatMessagePageSchema, controller.signal);
            chunks.push(...page.items.map((message) => message.text));
            cursor = page.nextCursor ?? undefined;
          } while (cursor && !controller.signal.aborted);
        } catch {
          if (controller.signal.aborted) return null;
        }
        const searchableText = chunks.join("\n");
        return searchableText.toLocaleLowerCase().includes(needle) ? [conversation.id, searchableText] as const : null;
      }));
      if (controller.signal.aborted) return;
      setWechatSearchText(Object.fromEntries(results.filter((result): result is readonly [string, string] => result !== null)));
    };
    void readSearchText();
    return () => {
      controller.abort();
      if (wechatSearchController.current === controller) wechatSearchController.current = null;
    };
  }, [wechatChats, wechatCursor, wechatSearchQuery]);
  useEffect(() => () => wechatSearchController.current?.abort(), []);
  function selectHistoryCategory(next: HistoryCategory) {
    setHistoryCategory(next);
    // AgentWorkspace and WechatAgentWorkspace render their history into the
    // host supplied by SalesHub. The event makes a tab change reactive for a
    // portal child while the data attribute also covers a remount.
    window.dispatchEvent(new CustomEvent("lumaflow-history-category-changed", { detail: { category: next } }));
  }
  useEffect(() => {
    const onHistoryCategoryChanged = (event: Event) => {
      const category = (event as CustomEvent<{ category?: string }>).detail?.category;
      if (category === "chat" || category === "work" || category === "image" || category === "wechat") setHistoryCategory(category);
    };
    window.addEventListener("lumaflow-history-category-changed", onHistoryCategoryChanged);
    return () => window.removeEventListener("lumaflow-history-category-changed", onHistoryCategoryChanged);
  }, []);
  function startHistory() {
    if (onNewHistory) onNewHistory(historyCategory);
    else window.dispatchEvent(new CustomEvent("lumaflow-new-history-session", { detail: { category: historyCategory } }));
  }
  async function loadMoreWechat() {
    if (!wechatCursor || wechatPaging) return;
    setWechatPaging(true);
    try {
      const page = await wechatHistoryRequest(`/api/v1/wechat-agent?action=conversations&cursor=${encodeURIComponent(wechatCursor)}`, wechatConversationPageSchema);
      setWechatChats((old) => [...new Map([...old, ...page.items].map((item) => [item.id, item])).values()]);
      setWechatCursor(page.nextCursor ?? null);
      if (!page.nextCursor) wechatAllLoadedRef.current = true;
    } catch (issue) {
      onToast?.(issue instanceof Error ? issue.message : "微信历史读取失败");
    } finally {
      setWechatPaging(false);
    }
  }
  async function updateWechatConversation(id: string, patch: { title?: string; pinned?: boolean }) {
    try {
      const response = await fetch("/api/v1/wechat-agent", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ action: "updateConversation", conversationId: id, ...patch }) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error?.message || "微信对话更新失败");
      await refreshWechat();
      onToast?.(patch.title ? "对话名称已更新" : patch.pinned ? "对话已置顶" : "对话已取消置顶");
    } catch (issue) {
      onToast?.(issue instanceof Error ? issue.message : "微信对话更新失败");
    }
  }
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
  const renderedRecentContent = isValidElement(recentContent)
    ? cloneElement(recentContent as ReactElement<{ "data-history-category"?: string }>, { "data-history-category": historyCategory })
    : recentContent;
  const visibleRecentChats = recentChats.filter((chat) => historyCategory === "image" ? chat.hasImage === true : historyCategory === "chat" ? chat.experience === "chat" && chat.hasImage !== true : historyCategory === "work" ? chat.experience === "work" && chat.hasImage !== true : false);
  const localHistoryItems: ConversationHistoryItem[] = visibleRecentChats.map((chat) => ({ id: chat.id, title: chat.title, experience: chat.experience, turnCount: chat.turnCount, pinned: chat.pinned, archived: chat.archived, searchableText: chat.searchableText }));
  const wechatHistoryItems: ConversationHistoryItem[] = wechatChats.map((chat) => ({ id: chat.id, title: chat.title, pinned: chat.pinned, searchableText: wechatSearchText[chat.id] || chat.preview || "" }));
  const historyItems = historyCategory === "wechat" ? wechatHistoryItems : localHistoryItems;
  function openHistory(id: string) {
    if (historyCategory === "wechat") {
      if (onOpenHistory) onOpenHistory("wechat", id);
      else window.dispatchEvent(new CustomEvent("lumaflow-open-wechat-conversation", { detail: { id } }));
      return;
    }
    const chat = recentChats.find((item) => item.id === id);
    if (onOpenHistory) onOpenHistory(historyCategory, id, chat?.projectId || null);
    else onOpenChat?.(id, chat?.projectId || null);
  }
  const historySearchChange = historyCategory === "wechat" ? setWechatSearchQuery : undefined;
  return <section className={styles.sidebar} aria-label="项目与对话记录">
    <div className={styles.projectRegion}><div className={styles.projectSection} aria-label="项目"><header><strong>项目</strong><button ref={createButton} aria-label="创建项目" title="创建项目" onClick={() => setCreating(true)}><Plus size={17} /></button></header>
    {projects.length === 0 && <p className={styles.sidebarHint}>点击加号创建项目</p>}
    {[...projects].sort((a, b) => (a.sectionName || "").localeCompare(b.sectionName || "")).map((project, index, list) => <div className={styles.projectGroup} key={project.id}>{project.sectionName && (index === 0 || list[index - 1].sectionName !== project.sectionName) && <h4 className={styles.sectionHeading}>{project.sectionName}</h4>}<div className={styles.projectRow} onContextMenu={(event) => { event.preventDefault(); setProjectMenu({ project, x: event.clientX, y: event.clientY }); }}><button aria-label={`${expanded[project.id] ? "收起" : "展开"}项目 ${project.name}`} aria-expanded={Boolean(expanded[project.id])} onClick={() => { const opening = !expanded[project.id]; setExpanded((old) => ({ ...old, [project.id]: opening })); if (opening) void loadChats(project.id); }}>{expanded[project.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button><button className={selectedId === project.id ? styles.selected : ""} onClick={() => onSelect(project.id)} title={`${project.name}\n${project.instructions || "尚未设置项目规则"}\n${project.knowledgeBaseIds.length} 个文件 · ${project.sources.length} 份资料`}><FolderOpen size={16} /><span>{project.name}</span>{project.pinned && <Pin size={12} />}</button><button className={styles.previewButton} aria-label={`预览项目 ${project.name}`} title="预览项目" onClick={() => onSelect(project.id)}><Eye size={15} /></button><button aria-label={`项目更多操作 ${project.name}`} aria-haspopup="menu" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setProjectMenu({ project, x: rect.right, y: rect.bottom }); }}><MoreHorizontal size={16} /></button></div>
    {expanded[project.id] && <div className={styles.projectChildren}>{loadingProject === project.id ? <p>正在读取…</p> : <ConversationHistoryList hideToolbar items={projectChats[project.id] || []} onSelect={(id) => { const chat = projectChats[project.id]?.find((item) => item.id === id); if (onOpenHistory && chat) onOpenHistory(chat.hasImage ? "image" : chat.experience, id, project.id); else onOpenChat?.(id, project.id); }} onRename={(id, title) => void changeChat(id, { title }, project.id)} onPin={(id, pinned) => void changeChat(id, { pinned }, project.id)} />}</div>}</div>)}
    </div></div>
    {recentContent && <div className={styles.historySection} aria-label="对话记录"><div className={styles.historyTabs} role="tablist" aria-label="对话分类">{(Object.keys(historyCategoryLabels) as HistoryCategory[]).map((category) => <button key={category} role="tab" aria-selected={historyCategory === category} onClick={() => selectHistoryCategory(category)}>{historyCategoryLabels[category]}</button>)}</div><div className={styles.historyPanel} role="tabpanel" aria-label={`${historyCategoryLabels[historyCategory]} 对话`}><header><strong>{historyCategoryLabels[historyCategory]} 对话</strong><button type="button" aria-label={`新建${historyCategoryLabels[historyCategory]}对话`} title={`新建${historyCategoryLabels[historyCategory]}对话`} onClick={startHistory}><Plus size={15} /></button></header><div className={styles.historyContent}><div className={styles.portalHistory} hidden data-history-source={recentAvailable ? "portal" : "local"}>{renderedRecentContent}</div><ConversationHistoryList key={historyCategory} items={historyItems} onSearchChange={historySearchChange} onSelect={openHistory} onRename={(id, title) => historyCategory === "wechat" ? void updateWechatConversation(id, { title }) : void changeChat(id, { title })} onPin={(id, pinned) => historyCategory === "wechat" ? void updateWechatConversation(id, { pinned }) : void changeChat(id, { pinned })} /></div>{historyCategory === "wechat" && wechatCursor && <button type="button" className={styles.historyMore} disabled={wechatPaging} onClick={() => void loadMoreWechat()}>{wechatPaging ? "正在读取…" : "加载更多会话"}</button>}</div></div>}
    {modal}
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
