"use client";

import {
  Bot,
  BellRing,
  BookOpen,
  Box,
  BriefcaseBusiness,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
  Inbox,
  Menu,
  MessageCircleMore,
  Plus,
  RefreshCw,
  Search,
  ScanSearch,
  Settings,
  SquarePen,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { PRIMARY_NAV, SECONDARY_NAV, VIEW_META, type StaticNavItem, type View } from "@/config/ui-static";
import { useBackendData } from "@/hooks/use-backend-data";
import type { AppDataSnapshot } from "@/lib/data-snapshot";
import type { Product } from "@/lib/catalog";
import { FollowupView } from "./crm-views";
import { KnowledgeHub as KnowledgeBaseView } from "./knowledge-hub";
import { AgentWorkspace } from "./agent-workspace";
import { AgentManagement } from "./agent-management";
import { WechatAgentWorkspace } from "./wechat-agent-workspace";
import { ProjectSidebar, ProjectWorkspace } from "./project-workspace";

type NavItem = StaticNavItem & { icon: LucideIcon };

const navIcons: Record<View, LucideIcon> = {
  knowledge: BookOpen,
  agents: Bot,
  assistant: ScanSearch,
  salesAssistant: MessageCircleMore,
  followup: Clock3,
};

const primaryNav: NavItem[] = PRIMARY_NAV.map((item) => ({ ...item, icon: navIcons[item.id] }));
const secondaryNav: NavItem[] = SECONDARY_NAV.map((item) => ({ ...item, icon: navIcons[item.id] }));

export function SalesHub() {
  const { response, loading, error, refresh } = useBackendData();
  if (!response && loading) return <BackendState title="正在读取后端动态数据" detail="正在读取知识、客户和跟进记录…" />;
  if (!response || error) return <BackendState title="后端数据读取失败" detail={error ?? "返回格式不符合 API 契约"} action="重新读取" onAction={() => void refresh()} />;
  return <SalesHubWorkspace initialData={response.data} generatedAt={response.meta.generatedAt} refreshing={loading} onRefresh={() => void refresh()} />;
}

function BackendState({ title, detail, action, onAction }: { title: string; detail: string; action?: string; onAction?: () => void }) {
  return <main className="backend-state"><div className="brand-mark" aria-hidden="true"><span /></div><span>LumaFlow · Backend API v1</span><h1>{title}</h1><p>{detail}</p>{action && <button className="primary-button" onClick={onAction}><RefreshCw size={16} /> {action}</button>}</main>;
}

function SalesHubWorkspace({ initialData, generatedAt, refreshing, onRefresh }: { initialData: AppDataSnapshot; generatedAt: string; refreshing: boolean; onRefresh: () => void }) {
  const catalog = initialData.products;
  const catalogAssets = catalog.flatMap((product) => product.assets.map((asset) => ({ ...asset, productId: product.id, productName: product.name })));
  const [view, setView] = useState<View>("assistant");
  const [newChatVersion, setNewChatVersion] = useState(0);
  const [wechatWork, setWechatWork] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectPage, setProjectPage] = useState(false);
  const [initialChatId, setInitialChatId] = useState<string | undefined>();
  const [globalQuery, setGlobalQuery] = useState("");
  const [knowledgeSearchVersion, setKnowledgeSearchVersion] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [knowledgeSection, setKnowledgeSection] = useState<"library" | "kit">("library");
  const [kitProductId, setKitProductId] = useState(catalog[0]?.id ?? "");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [historyHost, setHistoryHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    let next: View;
    if (url.searchParams.get("work") === "1") {
      next = "salesAssistant";
      url.searchParams.delete("work");
    } else if (url.searchParams.get("knowledge") === "1") {
      next = "knowledge";
      url.searchParams.delete("knowledge");
    } else if (url.searchParams.get("followup") === "1") {
      next = "followup";
      url.searchParams.delete("followup");
    } else return;
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    const timer = window.setTimeout(() => setView(next), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const meta = VIEW_META[view];
  const isChat = view === "assistant" || view === "salesAssistant";
  const openFollowup = initialData.followupTasks.find((task) => task.status === "open");
  const qualityIssue = initialData.qualityIssues[0];
  const notificationCount = Number(Boolean(openFollowup)) + Number(Boolean(qualityIssue));
  const sourceLabel = initialData.source === "postgres" ? "PostgreSQL" : initialData.source === "local-fallback" ? "本地回退" : initialData.source === "local" ? "本地存储" : initialData.source === "json-fallback" ? "JSON 回退" : "JSON";

  function navigate(next: View) {
    setProjectPage(false); setProjectId(null); setInitialChatId(undefined);
    setWechatWork(false);
    setView(next);
    setMobileOpen(false);
    setSelectedProduct(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startNewChat() {
    if (wechatWork) {
      window.dispatchEvent(new CustomEvent("lumaflow-wechat-new-conversation"));
      setMobileOpen(false);
      return;
    }
    setWechatWork(false);
    setProjectPage(false); setInitialChatId(undefined);
    setGlobalQuery("");
    setView("assistant");
    setNewChatVersion((current) => current + 1);
    setMobileOpen(false);
    setSelectedProduct(null);
  }

  function openWechatWork() {
    navigate("salesAssistant");
    setWechatWork(true);
  }
  function openProject(id: string) { setProjectId(id); setProjectPage(true); setWechatWork(false); setView("assistant"); setMobileOpen(false); }
  function startProjectChat(id: string | null, chatId?: string, experience: "chat" | "work" = "chat") { setProjectId(id); setProjectPage(false); setWechatWork(false); setInitialChatId(chatId); setGlobalQuery(""); setView(experience === "work" ? "salesAssistant" : "assistant"); setNewChatVersion((current) => current + 1); setMobileOpen(false); }

  function openSalesKit(id?: string) {
    if (id) setKitProductId(id);
    setKnowledgeSection("kit");
    navigate("knowledge");
  }

  function runGlobalSearch() {
    if (!globalQuery.trim()) return;
    setView("knowledge");
    setKnowledgeSection("library");
    setKnowledgeSearchVersion((current) => current + 1);
  }

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }

  return (
    <div className={`app-shell${isChat ? " chat-shell" : ""}`}>
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`} aria-label="主导航">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div><strong>LumaFlow</strong><small>Sales Intelligence</small></div>
          <button className="icon-button sidebar-close" onClick={() => setMobileOpen(false)} aria-label="关闭菜单"><X size={20} /></button>
        </div>

        <button type="button" className="new-chat-button" onClick={startNewChat}><SquarePen size={18} /> 新聊天</button>

        <nav className="nav-groups">
          <div className="nav-group">
            <span className="nav-label">工作空间</span>
            {primaryNav.map((item) => <NavButton key={item.id} item={item} active={view === item.id || (view === "salesAssistant" && item.id === "assistant")} onClick={() => navigate(item.id)} />)}
          </div>
          <div className="chat-sidebar-panel" hidden={!isChat}><ProjectSidebar selectedId={projectId} onSelect={openProject} onToast={showToast} onOpenChat={(chatId, id) => startProjectChat(id, chatId)} onRemoved={(id) => { if (projectId === id) navigate("assistant"); }} recentAvailable={isChat && !projectPage} recentContent={<div className="sidebar-history-host" ref={setHistoryHost} />} /></div>
        </nav>

        <div className="sidebar-bottom-nav">
          {secondaryNav.map((item) => <NavButton key={item.id} item={item} active={view === item.id} onClick={() => navigate(item.id)} />)}
        </div>
        <div className="profile-row">
          <div className="avatar">本</div>
          <div><strong>本地工作区</strong><small>尚未连接用户身份</small></div>
          <Settings size={17} />
        </div>
      </aside>

      {mobileOpen && <button className="scrim" aria-label="关闭菜单" onClick={() => setMobileOpen(false)} />}

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMobileOpen(true)} aria-label="打开菜单"><Menu size={21} /></button>
          {isChat ? <span className="chat-topbar-label">你的本地 AI 工作空间</span> : <div className="global-search">
            <Search size={18} />
            <input
              value={globalQuery}
              onChange={(event) => setGlobalQuery(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && runGlobalSearch()}
              placeholder="搜索 SKU、型号、功率、场景…"
              aria-label="全局搜索"
            />
            <kbd>⌘ K</kbd>
          </div>}
          <div className="topbar-actions">
            <button className="data-source-button" data-testid="data-source" onClick={onRefresh} disabled={refreshing} title={`最后同步：${new Date(generatedAt).toLocaleString("zh-CN")}`}><span />动态数据 · {sourceLabel} <RefreshCw size={13} className={refreshing ? "spinning" : ""} /></button>
            {!isChat && <button className="icon-button notification-button" aria-label="消息" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen((open) => !open)}><Inbox size={19} /><span /></button>}
            {!isChat && <button className="primary-button compact" onClick={() => openSalesKit()}><Plus size={17} /> 新建资料包</button>}
          </div>
        </header>

        <section className={isChat ? "chat-page-wrap" : view === "knowledge" ? "page-wrap knowledge-page-wrap" : "page-wrap"}>
          {!isChat && <div className="page-heading">
            <div><span className="eyebrow">{meta.eyebrow}</span><h1>{meta.title}</h1><p>{meta.subtitle}</p></div>
          </div>}

          {view === "knowledge" && <KnowledgeBaseView key={`knowledge-${knowledgeSearchVersion}`} products={catalog} assets={catalogAssets} dataSource={initialData.source} initialQuery={globalQuery} section={knowledgeSection} onSectionChange={setKnowledgeSection} kitProductId={kitProductId} onOpenProduct={setSelectedProduct} onWork={() => navigate("salesAssistant")} onToast={showToast} />}
          {view === "agents" && <AgentManagement onWork={(agentId) => { try { localStorage.setItem("lumaflow.agent.id", agentId); } catch {} navigate("salesAssistant"); }} onWechatWork={openWechatWork} onToast={showToast} />}
          {isChat && projectPage && projectId ? <ProjectWorkspace key={projectId} projectId={projectId} onNewChat={(id, experience) => startProjectChat(id, undefined, experience)} onOpenChat={(chatId, id) => startProjectChat(id, chatId)} onBack={() => navigate("assistant")} onToast={showToast} /> : isChat && wechatWork ? <WechatAgentWorkspace onBack={() => navigate("agents")} onToast={showToast} historyPortalTarget={historyHost} onExperienceChange={(next) => navigate(next === "chat" ? "assistant" : "salesAssistant")} /> : isChat && <AgentWorkspace key={`${view}-${newChatVersion}`} products={catalog} assets={catalogAssets} customers={initialData.customers} initialExperience={view === "salesAssistant" ? "work" : "chat"} initialMessage={view === "salesAssistant" ? "" : globalQuery} preferredRoleId={view === "salesAssistant" ? "sales-review" : undefined} selectAllKnowledge={view === "salesAssistant"} onOpenProduct={setSelectedProduct} onOpenKnowledge={() => navigate("knowledge")} onToast={showToast} onAddToKit={openSalesKit} historyPortalTarget={historyHost} onOpenWechat={openWechatWork} projectId={projectId} initialChatId={initialChatId} onOpenProject={openProject} />}
          {view === "followup" && <FollowupView customers={initialData.customers} tasks={initialData.followupTasks} onToast={showToast} />}
        </section>
      </main>

      {notificationsOpen && <div className="notification-popover"><div><BellRing size={16} /><strong>{notificationCount} 条后端提醒</strong><button onClick={() => setNotificationsOpen(false)} aria-label="关闭通知"><X size={15} /></button></div>{openFollowup && <button onClick={() => { setNotificationsOpen(false); navigate("followup"); }}><span className="notification-dot urgent" /><p><strong>{openFollowup.company} · {openFollowup.title}</strong><small>{openFollowup.dueLabel}</small></p><ChevronRight size={14} /></button>}{qualityIssue && <button onClick={() => { setNotificationsOpen(false); navigate("knowledge"); }}><span className="notification-dot warn" /><p><strong>{qualityIssue.subject}</strong><small>{qualityIssue.severity}优先 · {qualityIssue.detail}</small></p><ChevronRight size={14} /></button>}</div>}
      {selectedProduct && <ProductDrawer products={catalog} product={selectedProduct} onClose={() => setSelectedProduct(null)} onBuildKit={() => openSalesKit(selectedProduct.id)} onAsk={() => { setGlobalQuery(`${selectedProduct.model} 有哪些参数和适用场景？`); setSelectedProduct(null); navigate("assistant"); }} />}
      <div className={`toast ${toast ? "toast-visible" : ""}`} role="status"><CheckCircle2 size={17} /> {toast}</div>
    </div>
  );
}

function NavButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const Icon = item.icon;
  return (
    <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined}>
      <Icon size={18} /><span>{item.label}</span>
      {item.badge && <em>{item.badge}</em>}
    </button>
  );
}

function ProductArt({ product, large = false }: { product: Product; large?: boolean }) {
  return (
    <div className={`product-art ${large ? "large" : ""}`} style={{ background: product.gradient }}>
      <span className="art-label">{product.category}</span>
      <span className="art-model">{product.model}</span>
      <div className="art-shine" style={{ background: product.accent }} />
    </div>
  );
}

function ProductDrawer({ products, product, onClose, onBuildKit, onAsk }: { products: Product[]; product: Product; onClose: () => void; onBuildKit: () => void; onAsk: () => void }) {
  const related = products.filter((item) => item.id !== product.id && (item.family === product.family || item.category === product.category)).slice(0, 2);
  return (
    <div className="drawer-layer" role="dialog" aria-modal="true" aria-label={`${product.name} 产品详情`}>
      <button className="drawer-scrim" onClick={onClose} aria-label="关闭产品详情" />
      <aside className="drawer">
        <div className="drawer-top"><span>产品详情</span><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></div>
        <ProductArt product={product} large />
        <div className="drawer-title"><div><span>{product.family} · {product.category}</span><h2>{product.name}</h2><p>{product.model} · {product.sku}</p></div><span className={`stock-badge ${product.status === "低库存" ? "warning" : product.status === "预售" ? "neutral" : ""}`}>{product.status}</span></div>
        <p className="drawer-description">{product.description}</p>
        <div className="detail-grid">
          <Detail label="功率 / 光通量" value={`${product.power} / ${product.lumens}`} />
          <Detail label="色温" value={product.colorTemp} />
          <Detail label="材质" value={product.material} />
          <Detail label="尺寸" value={product.dimensions} />
          <Detail label="颜色" value={product.colors.join("、")} />
          <Detail label="起订量" value={`${product.moq} 件`} />
          <Detail label="库存与交期" value={`${product.stock} 件 · ${product.leadTime}`} />
          <Detail label="参考报价" value={product.priceRange} />
          <Detail label="内部成本" value={`¥${product.cost}`} />
          <Detail label="供应商" value={product.supplier} />
        </div>
        <div className="drawer-section"><span>适用场景</span><div className="scenario-list">{product.scenarios.map((item) => <em key={item}>{item}</em>)}</div></div>
        <div className="drawer-section"><span>关联资料 · {product.assets.length}</span><div className="drawer-files">{product.assets.map((asset) => <div key={asset.id}><FileText size={16} /><p><strong>{asset.name}</strong><small>{asset.type} · {asset.size}</small></p><CheckCircle2 size={15} /></div>)}</div></div>
        <div className="drawer-section"><span>关联产品</span><div className="related-products">{related.length ? related.map((item) => <div key={item.id}><Box size={15} /><p><strong>{item.name}</strong><small>{item.model} · {item.category}</small></p><span>{item.status}</span></div>) : <p className="no-related">暂无同系列关联产品</p>}</div></div>
        <div className="drawer-actions"><button className="outline-button" onClick={onAsk}><MessageCircleMore size={16} /> 问产品问题</button><button className="primary-button" onClick={onBuildKit}><BriefcaseBusiness size={16} /> 生成资料包</button></div>
      </aside>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
