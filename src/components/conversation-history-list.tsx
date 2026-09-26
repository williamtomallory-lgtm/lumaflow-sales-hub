"use client";

import { FolderOpen, Check, MoreHorizontal, Pencil, Pin, PinOff, Search, Share2, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./conversation-history-list.module.css";

export type ConversationHistoryItem = {
  id: string;
  title: string;
  experience?: "chat" | "work";
  /** Optional screen-reader context retained for existing session summaries. */
  turnCount?: number;
  pinned?: boolean;
  archived?: boolean;
};

export type ConversationHistoryListProps = {
  items: ConversationHistoryItem[];
  hideToolbar?: boolean;
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  onPin?: (id: string, pinned: boolean) => void;
  onMoveToProject?: (id: string) => void;
  onDelete?: (id: string) => void;
  onShare?: (id: string) => void;
};



/**
 * Shared compact history list for Chat, Work, and WeChat Agent. The list owns
 * only presentation state; all mutations are callbacks so the host can keep
 * the canonical session in its local API store.
 */
export function ConversationHistoryList({ items, selectedId, onSelect, onRename, onPin, onMoveToProject, onDelete, onShare, hideToolbar = false }: ConversationHistoryListProps) {

  const [query, setQuery] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const firstMenuItemRef = useRef<HTMLButtonElement>(null);
  const visibleItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items

      .filter((item) => !needle || item.title.toLocaleLowerCase().includes(needle))
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  }, [items, query]);

  useEffect(() => {
    if (!menuId) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !menuTriggerRef.current?.contains(event.target)) {
        setMenuId(null);
        setMenuPosition(null);
      }
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenuId(null); setMenuPosition(null); }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    firstMenuItemRef.current?.focus();
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, [menuId]);

  function closeMenu() {
    setMenuId(null);
    setMenuPosition(null);
    menuTriggerRef.current = null;
  }

  function openMenu(event: React.MouseEvent<HTMLButtonElement>, id: string) {
    if (menuId === id) { closeMenu(); return; }
    menuTriggerRef.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 164;
    const estimatedHeight = 244;
    const left = Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8));
    const top = rect.bottom + 4 + estimatedHeight <= window.innerHeight - 8 ? rect.bottom + 4 : Math.max(8, rect.top - estimatedHeight - 4);
    setMenuPosition({ left, top });
    setMenuId(id);
  }

  function beginRename(item: ConversationHistoryItem) {
    setMenuId(null);
    setEditingId(item.id);
    setEditingTitle(item.title);
  }

  function cancelRename() {
    setEditingId(null);
    setEditingTitle("");
  }

  function saveRename(item: ConversationHistoryItem) {
    const title = editingTitle.trim();
    if (!title || title === item.title) {
      cancelRename();
      return;
    }
    onRename?.(item.id, title);
    cancelRename();
  }

  return <section className={styles.root} aria-label="对话记录列表">
    {!hideToolbar && <div className={styles.toolbar}>
      <label className={styles.search}>
        <Search size={15} aria-hidden="true" />
        <input aria-label="搜索对话" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索对话" />
        {query && <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={13} /></button>}
      </label>

    </div>}
    <div className={styles.list} role="list">
      {visibleItems.length ? visibleItems.map((item) => {
        const editing = editingId === item.id;
        const menuOpen = menuId === item.id;
        return <div key={item.id} role="listitem" className={`${styles.row} ${selectedId === item.id ? styles.selected : ""}`}>
          {editing ? <form className={styles.renameForm} onSubmit={(event) => { event.preventDefault(); saveRename(item); }}>
            <input autoFocus aria-label={`重命名 ${item.title}`} value={editingTitle} maxLength={120} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelRename(); } }} />
            <button type="submit" aria-label="保存重命名" title="保存"><Check size={14} /></button>
            <button type="button" aria-label="取消重命名" title="取消" onClick={cancelRename}><X size={14} /></button>
          </form> : <>
            <button type="button" className={styles.select} aria-label={item.turnCount === undefined ? item.title : `${item.title} · ${item.turnCount} 轮`} aria-current={selectedId === item.id ? "true" : undefined} onClick={() => onSelect(item.id)}>
              {item.pinned && <Pin size={13} className={styles.pinMark} aria-label="已置顶" />}
              <span>{item.title}</span>{item.experience === "work" && <small className={styles.modeBadge}>Work</small>}
            </button>
            {onPin && <button type="button" className={styles.pinAction} aria-label={item.pinned ? `取消置顶 ${item.title}` : `置顶 ${item.title}`} title={item.pinned ? "取消置顶" : "置顶"} onClick={() => onPin(item.id, !item.pinned)}><Pin size={14} /></button>}
            <div className={styles.menuWrap}>
              <button type="button" className={styles.more} aria-label={`更多操作 ${item.title}`} aria-expanded={menuOpen} aria-haspopup="menu" onClick={(event) => openMenu(event, item.id)}><MoreHorizontal size={17} /></button>
              {menuOpen && menuPosition && typeof document !== "undefined" && createPortal(<div ref={menuRef} className={styles.menu} role="menu" style={{ left: menuPosition.left, top: menuPosition.top }} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button")); const current = buttons.indexOf(document.activeElement as HTMLButtonElement); const next = event.key === "ArrowDown" ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length; buttons[next]?.focus(); } }}>
                {onShare && <button ref={firstMenuItemRef} type="button" role="menuitem" onClick={() => { closeMenu(); onShare(item.id); }}><Share2 size={14} /> 分享</button>}
                {onRename && <button ref={!onShare ? firstMenuItemRef : undefined} type="button" role="menuitem" onClick={() => { closeMenu(); beginRename(item); }}><Pencil size={14} /> 重命名</button>}
                {onPin && <button ref={!onShare && !onRename ? firstMenuItemRef : undefined} type="button" role="menuitem" onClick={() => { closeMenu(); onPin(item.id, !item.pinned); }}>{item.pinned ? <PinOff size={14} /> : <Pin size={14} />} {item.pinned ? "取消置顶" : "置顶"}</button>}
                {onMoveToProject && <button type="button" role="menuitem" onClick={() => { closeMenu(); onMoveToProject(item.id); }}><FolderOpen size={14} /> 移至项目</button>}
                {onDelete && <button ref={!onShare && !onRename && !onPin && !onMoveToProject ? firstMenuItemRef : undefined} type="button" role="menuitem" className={styles.destructive} onClick={() => { closeMenu(); onDelete(item.id); }}><Trash2 size={14} /> 删除</button>}
              </div>, document.body)}
            </div>
          </>}
        </div>;
      }) : <p className={styles.empty}>{query ? "没有匹配的对话。" : "还没有保存的对话。"}</p>}
    </div>
  </section>;
}
