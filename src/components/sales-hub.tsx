"use client";

import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BellRing,
  BookOpen,
  Box,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Copy,
  Download,
  FileBadge,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  History,
  Inbox,
  LayoutDashboard,
  Menu,
  MessageCircleMore,
  PackageCheck,
  Paperclip,
  Plus,
  Search,
  ScanSearch,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UsersRound,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type FormEvent } from "react";
import type { AppDataSnapshot } from "@/lib/data-snapshot";
import { type Asset, type Product } from "@/lib/catalog";
import { answerQuestion, buildSalesMessage, searchProducts } from "@/lib/search";
import { CustomersView, FollowupView, SalesAssistantView } from "./crm-views";
import { AdminView, KnowledgeBaseView, QuotationView } from "./operations-views";

type View = "overview" | "products" | "assets" | "knowledge" | "assistant" | "kit" | "salesAssistant" | "customers" | "quotation" | "followup" | "admin";
type CatalogAsset = Asset & { productId: string; productName: string };

type NavItem = { id: View; label: string; icon: LucideIcon; badge?: string; phase?: string };

const primaryNav: NavItem[] = [
  { id: "overview", label: "工作台", icon: LayoutDashboard },
  { id: "products", label: "产品中心", icon: Box },
  { id: "assets", label: "资料中心", icon: FolderOpen },
  { id: "knowledge", label: "知识库", icon: BookOpen },
  { id: "assistant", label: "智能搜索", icon: ScanSearch, badge: "AI" },
  { id: "kit", label: "销售资料包", icon: BriefcaseBusiness },
  { id: "salesAssistant", label: "销售助手", icon: MessageCircleMore, badge: "AI" },
];

const secondaryNav: NavItem[] = [
  { id: "customers", label: "客户与会话", icon: UsersRound },
  { id: "quotation", label: "报价系统", icon: CircleDollarSign },
  { id: "followup", label: "跟进提醒", icon: Clock3 },
  { id: "admin", label: "管理后台", icon: BarChart3 },
];

const viewMeta: Record<View, { eyebrow: string; title: string; subtitle: string }> = {
  overview: { eyebrow: "9 月 4 日 · 星期五", title: "下午好，Junjun", subtitle: "这里是今天最值得你关注的产品与销售资料。" },
  products: { eyebrow: "产品中心", title: "把每个型号讲清楚", subtitle: "型号、参数、场景、库存和资料都在同一个视图里。" },
  assets: { eyebrow: "资料中心", title: "找到，选中，直接发", subtitle: "按产品归档的最新图片、参数表、证书与案例。" },
  knowledge: { eyebrow: "知识库", title: "把团队经验变成共同资产", subtitle: "统一管理 FAQ、销售话术、产品知识、政策、案例和解析文档。" },
  assistant: { eyebrow: "智能搜索", title: "自然语言、图片和附件，一处搜索", subtitle: "SKU 精确查找、参数筛选与语义问答都引用已审核数据。" },
  kit: { eyebrow: "销售资料包", title: "十秒拼好一套客户资料", subtitle: "选择产品与附件，生成推荐话术并下载交付清单。" },
  salesAssistant: { eyebrow: "销售助手", title: "读懂客户，再给出可审核的回复", subtitle: "识别客户意图，推荐产品与附件，生成可编辑、确认后待发送的回复。" },
  customers: { eyebrow: "客户与会话", title: "每次沟通都带着完整上下文", subtitle: "客户档案、联系人、需求、聊天、历史报价和记忆统一管理。" },
  quotation: { eyebrow: "报价系统 · CPQ", title: "准确报价，也能快速推进", subtitle: "价格阶梯、折扣、币种、审批、PDF 与版本历史完整联动。" },
  followup: { eyebrow: "跟进系统", title: "不错过该推进的客户", subtitle: "未回复提醒、下一步行动、自动话术和销售任务集中处理。" },
  admin: { eyebrow: "管理后台", title: "让知识、权限和 AI 持续可信", subtitle: "用户权限、数据质量、AI 日志、使用统计与效果评估。" },
};

const quickQuestions = [
  "18W 黑色轨道灯，服装店用，今天能发吗？",
  "酒店餐厅适合哪款金色吊灯？",
  "推荐一款低眩光的办公室筒灯",
];

export function SalesHub({ initialData }: { initialData: AppDataSnapshot }) {
  const catalog = initialData.products;
  const catalogAssets = catalog.flatMap((product) => product.assets.map((asset) => ({ ...asset, productId: product.id, productName: product.name })));
  const [view, setView] = useState<View>("overview");
  const [globalQuery, setGlobalQuery] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [kitProductId, setKitProductId] = useState(catalog[0].id);
  const [crmCustomerId, setCrmCustomerId] = useState<string>();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [toast, setToast] = useState("");
  const meta = viewMeta[view];

  function navigate(next: View) {
    setView(next);
    setMobileOpen(false);
    setSelectedProduct(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function runGlobalSearch() {
    if (!globalQuery.trim()) return;
    setView("products");
  }

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`} aria-label="主导航">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div><strong>LumaFlow</strong><small>Sales Intelligence</small></div>
          <button className="icon-button sidebar-close" onClick={() => setMobileOpen(false)} aria-label="关闭菜单"><X size={20} /></button>
        </div>

        <nav className="nav-groups">
          <div className="nav-group">
            <span className="nav-label">工作空间</span>
            {primaryNav.map((item) => <NavButton key={item.id} item={item} active={view === item.id} onClick={() => navigate(item.id)} />)}
          </div>
          <div className="nav-group nav-secondary">
            <span className="nav-label">管理与增长</span>
            {secondaryNav.map((item) => <NavButton key={item.id} item={item} active={view === item.id} onClick={() => navigate(item.id)} />)}
          </div>
        </nav>

        <div className="sidebar-card">
          <div className="sidebar-card-icon"><Zap size={16} fill="currentColor" /></div>
          <strong>资料完整度 86%</strong>
          <p>补齐 3 份产品证书，回答可信度会更高。</p>
          <button onClick={() => navigate("assets")}>查看待补资料 <ArrowRight size={14} /></button>
        </div>

        <div className="profile-row">
          <div className="avatar">JH</div>
          <div><strong>Junjun Hu</strong><small>销售顾问</small></div>
          <Settings size={17} />
        </div>
      </aside>

      {mobileOpen && <button className="scrim" aria-label="关闭菜单" onClick={() => setMobileOpen(false)} />}

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMobileOpen(true)} aria-label="打开菜单"><Menu size={21} /></button>
          <div className="global-search">
            <Search size={18} />
            <input
              value={globalQuery}
              onChange={(event) => setGlobalQuery(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && runGlobalSearch()}
              placeholder="搜索 SKU、型号、功率、场景…"
              aria-label="全局搜索"
            />
            <kbd>⌘ K</kbd>
          </div>
          <div className="topbar-actions">
            <button className="icon-button notification-button" aria-label="消息" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen((open) => !open)}><Inbox size={19} /><span /></button>
            <button className="primary-button compact" onClick={() => navigate("kit")}><Plus size={17} /> 新建资料包</button>
          </div>
        </header>

        <section className="page-wrap">
          <div className="page-heading">
            <div><span className="eyebrow">{meta.eyebrow}</span><h1>{meta.title}</h1><p>{meta.subtitle}</p></div>
          </div>

          {view === "overview" && <Overview products={catalog} onNavigate={navigate} onProduct={setSelectedProduct} onAsk={(question) => { setGlobalQuery(question); navigate("assistant"); }} />}
          {view === "products" && <ProductsView products={catalog} initialQuery={globalQuery} onProduct={setSelectedProduct} onToast={showToast} />}
          {view === "assets" && <AssetsView assets={catalogAssets} onNavigate={navigate} onToast={showToast} />}
          {view === "knowledge" && <KnowledgeBaseView initialEntries={initialData.knowledgeEntries} onToast={showToast} />}
          {view === "assistant" && <AssistantView products={catalog} initialQuestion={globalQuery} onProduct={setSelectedProduct} onToast={showToast} onAddToKit={(id) => { setKitProductId(id); navigate("kit"); }} />}
          {view === "kit" && <SalesKitView products={catalog} initialProductId={kitProductId} onProduct={setSelectedProduct} onToast={showToast} />}
          {view === "salesAssistant" && <SalesAssistantView products={catalog} assets={catalogAssets} customers={initialData.customers} initialCustomerId={crmCustomerId} onOpenProduct={setSelectedProduct} onOpenCustomer={(id) => { setCrmCustomerId(id); navigate("customers"); }} onToast={showToast} />}
          {view === "customers" && <CustomersView customers={initialData.customers} initialCustomerId={crmCustomerId} onOpenCustomer={setCrmCustomerId} onAnalyzeCustomer={(customer) => { setCrmCustomerId(customer.id); navigate("salesAssistant"); }} onCreateQuote={() => navigate("quotation")} onToast={showToast} />}
          {view === "quotation" && <QuotationView products={catalog} initialHistory={initialData.quoteHistory} currencyRates={initialData.currencyRates} onToast={showToast} />}
          {view === "followup" && <FollowupView customers={initialData.customers} tasks={initialData.followupTasks} onOpenCustomer={(id) => { setCrmCustomerId(id); navigate("customers"); }} onToast={showToast} />}
          {view === "admin" && <AdminView initialUsers={initialData.adminUsers} initialKnowledge={initialData.knowledgeEntries} initialLogs={initialData.aiLogs} initialIssues={initialData.qualityIssues} onToast={showToast} />}
        </section>
      </main>

      {notificationsOpen && <div className="notification-popover"><div><BellRing size={16} /><strong>3 条待处理</strong><button onClick={() => setNotificationsOpen(false)} aria-label="关闭通知"><X size={15} /></button></div><button onClick={() => { setNotificationsOpen(false); navigate("followup"); }}><span className="notification-dot urgent" /><p><strong>NOVA 服饰 3 天未回复</strong><small>建议今天 16:00 前跟进</small></p><ChevronRight size={14} /></button><button onClick={() => { setNotificationsOpen(false); navigate("admin"); }}><span className="notification-dot warn" /><p><strong>MOSS O8 证书即将过期</strong><small>剩余 21 天</small></p><ChevronRight size={14} /></button><button onClick={() => { setNotificationsOpen(false); navigate("quotation"); }}><span className="notification-dot" /><p><strong>1 份报价等待审批</strong><small>来自 Lin Chen</small></p><ChevronRight size={14} /></button></div>}
      {selectedProduct && <ProductDrawer products={catalog} product={selectedProduct} onClose={() => setSelectedProduct(null)} onBuildKit={() => { setKitProductId(selectedProduct.id); setSelectedProduct(null); navigate("kit"); }} onAsk={() => { setGlobalQuery(`${selectedProduct.model} 有哪些参数和适用场景？`); setSelectedProduct(null); navigate("assistant"); }} />}
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
      {item.phase && <small>{item.phase}</small>}
    </button>
  );
}

function Overview({ products, onNavigate, onProduct, onAsk }: { products: Product[]; onNavigate: (view: View) => void; onProduct: (product: Product) => void; onAsk: (question: string) => void }) {
  return (
    <div className="overview-grid">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="hero-badge"><Sparkles size={14} /> 智能产品顾问</span>
          <h2>客户问什么，<br />这里都有答案。</h2>
          <p>搜索产品、参数和资料，再把准确答案一键发给客户。</p>
          <div className="hero-actions">
            <button className="light-button" onClick={() => onNavigate("assistant")}>开始提问 <ArrowRight size={16} /></button>
            <button className="ghost-light-button" onClick={() => onNavigate("products")}>浏览产品</button>
          </div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="glow-ring ring-one" /><div className="glow-ring ring-two" />
          <div className="lamp"><span className="lamp-head" /><span className="lamp-neck" /><span className="lamp-light" /></div>
          <div className="floating-pill pill-one"><Check size={13} /> 已匹配 4 项参数</div>
          <div className="floating-pill pill-two"><PackageCheck size={13} /> 库存 126</div>
        </div>
      </section>

      <section className="metric-strip" aria-label="核心指标">
        <Metric icon={Box} label="在售产品" value="5" note="1 款预售" tone="sand" />
        <Metric icon={FolderOpen} label="可用资料" value="18" note="本周 +3" tone="blue" />
        <Metric icon={Sparkles} label="今日问答" value="24" note="节省约 46 分钟" tone="green" />
        <Metric icon={BriefcaseBusiness} label="已发资料包" value="9" note="打开率 78%" tone="rose" />
      </section>

      <section className="panel products-panel">
        <PanelHeading eyebrow="产品速览" title="最近使用" action="查看全部" onClick={() => onNavigate("products")} />
        <div className="product-row">
          {products.slice(0, 4).map((product) => <MiniProductCard key={product.id} product={product} onClick={() => onProduct(product)} />)}
        </div>
      </section>

      <section className="panel ask-panel">
        <PanelHeading eyebrow="快速问答" title="大家都在问" action="进入知识问答" onClick={() => onNavigate("assistant")} />
        <div className="question-list">
          {quickQuestions.map((question, index) => (
            <button key={question} onClick={() => onAsk(question)}>
              <span>{index + 1}</span><p>{question}</p><ArrowRight size={16} />
            </button>
          ))}
        </div>
      </section>

      <section className="panel activity-panel">
        <PanelHeading eyebrow="知识动态" title="最近更新" />
        <div className="activity-list">
          <Activity icon={FileSpreadsheet} tone="blue" title="ARC T18 参数表" detail="更新了光束角与显色指数" time="12 分钟前" />
          <Activity icon={FileBadge} tone="green" title="LINE 系列 CE 证书" detail="资料状态已变为可发送" time="2 小时前" />
          <Activity icon={FileImage} tone="rose" title="NOVA 服装店案例" detail="新增 8 张项目现场图" time="昨天" />
        </div>
      </section>
    </div>
  );
}

function Metric({ icon: Icon, label, value, note, tone }: { icon: LucideIcon; label: string; value: string; note: string; tone: string }) {
  return <div className="metric"><span className={`metric-icon ${tone}`}><Icon size={18} /></span><div><small>{label}</small><strong>{value}</strong><em>{note}</em></div></div>;
}

function PanelHeading({ eyebrow, title, action, onClick }: { eyebrow: string; title: string; action?: string; onClick?: () => void }) {
  return <div className="panel-heading"><div><span>{eyebrow}</span><h2>{title}</h2></div>{action && <button onClick={onClick}>{action} <ChevronRight size={15} /></button>}</div>;
}

function MiniProductCard({ product, onClick }: { product: Product; onClick: () => void }) {
  return (
    <button className="mini-product" onClick={onClick}>
      <ProductArt product={product} />
      <span className={`status-dot ${product.status === "低库存" ? "warn" : product.status === "预售" ? "muted" : ""}`}>{product.status}</span>
      <strong>{product.name}</strong><small>{product.model} · {product.power}</small>
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

function Activity({ icon: Icon, tone, title, detail, time }: { icon: LucideIcon; tone: string; title: string; detail: string; time: string }) {
  return <div className="activity"><span className={`activity-icon ${tone}`}><Icon size={17} /></span><div><strong>{title}</strong><p>{detail}</p></div><time>{time}</time></div>;
}

function ProductsView({ products, initialQuery, onProduct, onToast }: { products: Product[]; initialQuery: string; onProduct: (product: Product) => void; onToast: (message: string) => void }) {
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState("全部产品");
  const [catalog, setCatalog] = useState(products);
  const [stockOnly, setStockOnly] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const categories = ["全部产品", ...new Set(catalog.map((product) => product.category))];
  const results = useMemo(() => searchProducts(query, catalog).filter(({ product }) => (category === "全部产品" || product.category === category) && (!stockOnly || product.stock > 0)), [query, category, catalog, stockOnly]);

  function addProduct(product: Product) {
    setCatalog((current) => [product, ...current]);
    setCategory("全部产品");
    setQuery(product.model);
    setShowCreate(false);
    onToast(`${product.model} 已加入产品中心`);
  }

  return (
    <div className="catalog-layout">
      <div className="catalog-toolbar">
        <div className="inline-search"><Search size={17} /><input data-testid="product-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索型号、SKU、功率、材质或场景" /><kbd>Enter</kbd></div>
        <button className={`filter-button ${stockOnly ? "active-filter" : ""}`} onClick={() => setStockOnly((active) => !active)} aria-pressed={stockOnly}><SlidersHorizontal size={16} /> {stockOnly ? "仅看有货" : "库存筛选"}</button>
        <button className="primary-button" onClick={() => setShowCreate(true)}><Plus size={16} /> 新增产品</button>
      </div>
      <div className="category-tabs" role="tablist" aria-label="产品分类">
        {categories.map((item) => <button role="tab" aria-selected={category === item} key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item}</button>)}
      </div>
      <div className="result-summary"><span>找到 <strong>{results.length}</strong> 款产品</span>{query && <p>搜索条件：<em>{query}</em></p>}</div>
      {results.length > 0 ? (
        <div className="catalog-grid" data-testid="catalog-results">
          {results.map(({ product, matches }) => <ProductCard key={product.id} product={product} matches={matches} onClick={() => onProduct(product)} />)}
        </div>
      ) : (
        <EmptyState icon={Search} title="没有匹配的产品" detail="试试换成功率、品类、颜色或使用场景。" action="清除搜索" onClick={() => { setQuery(""); setCategory("全部产品"); }} />
      )}
      {showCreate && <ProductCreateModal onClose={() => setShowCreate(false)} onCreate={addProduct} />}
    </div>
  );
}

function ProductCard({ product, matches, onClick }: { product: Product; matches: string[]; onClick: () => void }) {
  return (
    <article className="product-card">
      <button className="product-card-main" onClick={onClick} aria-label={`查看 ${product.name}`}>
        <ProductArt product={product} large />
        <div className="product-card-body">
          <div className="product-title-line"><div><span>{product.family}</span><h3>{product.name}</h3></div><span className={`stock-badge ${product.status === "低库存" ? "warning" : product.status === "预售" ? "neutral" : ""}`}>{product.status}</span></div>
          <p className="product-code">{product.model} · {product.sku}</p>
          <div className="spec-chips"><span>{product.power}</span><span>{product.colorTemp}</span><span>{product.material}</span></div>
          {matches.length > 0 && <div className="match-line"><Sparkles size={13} /> 匹配：{matches.join("、")}</div>}
          <div className="product-meta"><span><PackageCheck size={15} /> {product.stock > 0 ? `${product.stock} 件` : "预售"}</span><strong>{product.priceRange}</strong></div>
        </div>
      </button>
    </article>
  );
}

function ProductCreateModal({ onClose, onCreate }: { onClose: () => void; onCreate: (product: Product) => void }) {
  const [form, setForm] = useState({ name: "", model: "", sku: "", category: "轨道灯", power: "18W", material: "压铸铝", dimensions: "", stock: "0", price: "299" });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.name.trim() || !form.model.trim() || !form.sku.trim()) return;
    const stock = Math.max(0, Number(form.stock) || 0);
    const price = Math.max(0, Number(form.price) || 0);
    onCreate({
      id: `custom-${Date.now()}`,
      name: form.name.trim(), model: form.model.trim().toUpperCase(), sku: form.sku.trim().toUpperCase(), category: form.category, family: "自定义产品",
      status: stock > 10 ? "在售" : stock > 0 ? "低库存" : "预售", power: form.power, lumens: "待补充", colorTemp: "待补充", material: form.material,
      dimensions: form.dimensions || "待补充", colors: ["待补充"], scenarios: ["待补充"], supplier: "待补充", cost: 0, priceRange: `¥${price}`, moq: 1, stock,
      leadTime: stock > 0 ? "现货，交期待确认" : "待确认到仓时间", warranty: "待补充", description: "新建产品，等待产品负责人补齐并审核参数。",
      gradient: "linear-gradient(145deg,#dfe5df,#81968a)", accent: "#a8c2b2", assets: [],
    });
  }
  return <div className="form-modal-layer" role="dialog" aria-modal="true" aria-label="新增产品"><button className="form-modal-scrim" onClick={onClose} aria-label="关闭" /><form className="form-modal" onSubmit={submit}><div className="form-modal-head"><div><span>产品中心</span><h2>新增产品</h2></div><button type="button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div><div className="form-grid"><label>产品名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：Nova 射灯" /></label><label>型号<input required value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="NOVA T20" /></label><label>SKU<input required value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} placeholder="LT-NOVA-T20-BK" /></label><label>品类<select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}><option>轨道灯</option><option>吊灯</option><option>磁吸灯</option><option>洗墙灯</option><option>户外灯</option><option>筒灯</option></select></label><label>功率<input value={form.power} onChange={(event) => setForm({ ...form, power: event.target.value })} /></label><label>材质<input value={form.material} onChange={(event) => setForm({ ...form, material: event.target.value })} /></label><label>尺寸<input value={form.dimensions} onChange={(event) => setForm({ ...form, dimensions: event.target.value })} placeholder="Ø62 × H138 mm" /></label><label>库存<input type="number" min="0" value={form.stock} onChange={(event) => setForm({ ...form, stock: event.target.value })} /></label><label>参考价格<input type="number" min="0" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} /></label></div><p className="form-note"><ShieldCheck size={14} /> 新产品会标记待补资料，发布前应完成参数与证书审核。</p><div className="form-modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" type="submit">保存产品</button></div></form></div>;
}

function AssetsView({ assets, onNavigate, onToast }: { assets: CatalogAsset[]; onNavigate: (view: View) => void; onToast: (message: string) => void }) {
  const [type, setType] = useState("全部资料");
  const [query, setQuery] = useState("");
  const [uploadedAssets, setUploadedAssets] = useState<Array<Asset & { productId: string; productName: string }>>([]);
  const [uploadedFiles, setUploadedFiles] = useState<Record<string, File>>({});
  const [versionAsset, setVersionAsset] = useState<(Asset & { productName: string }) | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const assetTypes = ["全部资料", "图片", "尺寸图", "参数表", "PDF", "证书", "案例", "视频", "说明书"];
  const assetCatalog = [...uploadedAssets, ...assets];
  const results = assetCatalog.filter((asset) => (type === "全部资料" || asset.type === type) && `${asset.name}${asset.productName}`.toLowerCase().includes(query.toLowerCase()));

  function uploadAsset(file?: File) {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    const assetType: Asset["type"] = file.type.startsWith("image/") ? "图片" : file.type.startsWith("video/") ? "视频" : extension === "pdf" ? "PDF" : extension === "xlsx" || extension === "csv" ? "参数表" : "说明书";
    const id = `upload-${Date.now()}`;
    setUploadedAssets((current) => [{ id, name: file.name, type: assetType, size: formatAssetSize(file.size), version: "v1.0", updatedAt: "刚刚", productId: "unlinked", productName: "待关联产品" }, ...current]);
    setUploadedFiles((current) => ({ ...current, [id]: file }));
    onToast(`${file.name} 已上传并进入版本管理`);
    if (uploadRef.current) uploadRef.current.value = "";
  }

  function downloadAsset(asset: Asset & { productName: string }) {
    const uploaded = uploadedFiles[asset.id];
    const blob = uploaded ?? new Blob([`LumaFlow 资料记录\n名称：${asset.name}\n关联产品：${asset.productName}\n类型：${asset.type}\n版本：${asset.version ?? "v1.0"}\n\n演示目录未包含原始二进制文件；接入对象存储后，此入口将下载已审核原件。`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = uploaded ? uploaded.name : `${asset.name}-资料记录.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    onToast(`${asset.name} 已下载`);
  }

  return (
    <div className="assets-layout">
      <section className="asset-summary-cards">
        <div><FileImage size={21} /><strong>{assetCatalog.filter((asset) => ["图片", "尺寸图"].includes(asset.type)).length}</strong><span>图片与尺寸图</span><small>支持上传与版本追踪</small></div>
        <div><FileSpreadsheet size={21} /><strong>{assetCatalog.filter((asset) => ["参数表", "PDF"].includes(asset.type)).length}</strong><span>参数与 PDF</span><small>1 份本周更新</small></div>
        <div><ShieldCheck size={21} /><strong>{assetCatalog.filter((asset) => asset.type === "证书").length}</strong><span>证书报告</span><small className="warning-text">3 份待补</small></div>
        <div><FileText size={21} /><strong>{assetCatalog.filter((asset) => ["案例", "说明书", "视频"].includes(asset.type)).length}</strong><span>案例 / 视频 / 手册</span><small>可组合发送</small></div>
      </section>
      <section className="panel asset-browser">
        <div className="asset-toolbar">
          <div className="inline-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资料或产品" /></div>
          <input ref={uploadRef} hidden type="file" accept="image/*,video/*,.pdf,.doc,.docx,.csv,.xlsx" onChange={(event) => uploadAsset(event.target.files?.[0])} />
          <button className="outline-button" onClick={() => uploadRef.current?.click()}><Plus size={16} /> 上传资料</button>
        </div>
        <div className="category-tabs compact-tabs">{assetTypes.map((item) => <button key={item} className={type === item ? "active" : ""} onClick={() => setType(item)}>{item}</button>)}</div>
        <div className="asset-table-wrap">
          <table className="asset-table">
            <thead><tr><th>资料名称</th><th>关联产品</th><th>类型</th><th>版本</th><th>大小</th><th>状态</th><th /></tr></thead>
            <tbody>{results.map((asset) => <AssetRow key={asset.id} asset={asset} onDownload={() => downloadAsset(asset)} onHistory={() => setVersionAsset(asset)} />)}</tbody>
          </table>
        </div>
        {results.length === 0 && <EmptyState icon={FolderOpen} title="没有找到资料" detail="换一个关键词或资料类型试试。" />}
      </section>
      <div className="asset-cta"><div><Sparkles size={20} /><span><strong>不用逐份挑选</strong><small>销售资料包会自动推荐与产品匹配的附件。</small></span></div><button onClick={() => onNavigate("kit")}>去组资料包 <ArrowRight size={15} /></button></div>
      {versionAsset && <div className="asset-history-panel" role="dialog" aria-modal="true" aria-label="资料版本历史"><button className="form-modal-scrim" onClick={() => setVersionAsset(null)} aria-label="关闭" /><div><div className="form-modal-head"><span><small>版本管理</small><h2>{versionAsset.name}</h2></span><button onClick={() => setVersionAsset(null)} aria-label="关闭"><X size={18} /></button></div><div className="version-timeline"><article><span className="version-current"><Check size={12} /></span><p><strong>{versionAsset.version ?? "v1.0"} · 当前版本</strong><small>{versionAsset.updatedAt ?? "8 月 28 日"} · 产品中心发布</small></p><em>可发送</em></article><article><span>2</span><p><strong>v{Math.max(0, Number((versionAsset.version ?? "v1.0").replace(/[^\d.]/g, "")) - .1).toFixed(1)}</strong><small>8 月 12 日 · Junjun Hu</small></p><em>已归档</em></article></div><button className="primary-button" onClick={() => { setVersionAsset(null); onToast("新版本上传入口已准备"); }}>上传新版本</button></div></div>}
    </div>
  );
}

function AssetRow({ asset, onDownload, onHistory }: { asset: Asset & { productName: string }; onDownload: () => void; onHistory: () => void }) {
  const icon = asset.type === "图片" ? FileImage : asset.type === "证书" ? FileBadge : asset.type === "参数表" ? FileSpreadsheet : FileText;
  const Icon = icon;
  return <tr><td><span className="file-icon"><Icon size={17} /></span><strong>{asset.name}</strong></td><td>{asset.productName}</td><td><span className="type-pill">{asset.type}</span></td><td><button className="version-button" onClick={onHistory}>{asset.version ?? "v1.0"}</button></td><td>{asset.size}</td><td><span className="ready-status"><Check size={12} /> 可发送</span></td><td><div className="asset-row-actions"><button className="icon-button" onClick={onHistory} aria-label={`查看 ${asset.name} 版本`}><History size={15} /></button><button className="icon-button" onClick={onDownload} aria-label={`下载 ${asset.name}`}><Download size={16} /></button></div></td></tr>;
}

function formatAssetSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AssistantView({ products, initialQuestion, onProduct, onToast, onAddToKit }: { products: Product[]; initialQuestion: string; onProduct: (product: Product) => void; onToast: (message: string) => void; onAddToKit: (productId: string) => void }) {
  const starter = initialQuestion && initialQuestion.length < 90 ? initialQuestion : quickQuestions[0];
  const [input, setInput] = useState(starter);
  const [question, setQuestion] = useState(starter);
  const [attachment, setAttachment] = useState("");
  const attachmentRef = useRef<HTMLInputElement>(null);
  const result = useMemo(() => answerQuestion(question, products), [question, products]);

  async function copyAnswer() {
    await navigator.clipboard.writeText(result.answer);
    onToast("答案已复制，可以直接发给客户");
  }

  function searchAttachment(file?: File) {
    if (!file) return;
    const name = file.name.toLowerCase();
    const inferred = name.includes("halo") || name.includes("hotel") || name.includes("酒店") ? "酒店餐厅适合的金色吊灯" : name.includes("line") || name.includes("磁吸") ? "黑色磁吸线条灯" : name.includes("beam") || name.includes("office") ? "办公室低眩光筒灯" : "18W 黑色轨道灯 服装店";
    setAttachment(file.name);
    setInput(inferred);
    setQuestion(inferred);
    onToast(`已读取附件“${file.name}”并匹配目录特征`);
    if (attachmentRef.current) attachmentRef.current.value = "";
  }

  return (
    <div className="assistant-layout">
      <section className="assistant-main">
        <div className="search-mode-bar"><span className="active"><Sparkles size={13} /> 自然语言</span><span>语义搜索</span><button onClick={() => attachmentRef.current?.click()}><Paperclip size={13} /> 图片 / 附件</button><input ref={attachmentRef} hidden type="file" accept="image/*,.pdf,.doc,.docx,.xlsx,.csv" onChange={(event) => searchAttachment(event.target.files?.[0])} /></div>
        <div className="chat-date"><span>今天</span></div>
        {attachment && <div className="attachment-chip"><FileImage size={14} /><span>{attachment}</span><button onClick={() => setAttachment("")} aria-label="移除附件"><X size={13} /></button></div>}
        <div className="customer-message"><div className="avatar customer">客</div><div><small>客户问题</small><p>{question}</p></div></div>
        <div className="ai-message">
          <div className="ai-avatar"><Sparkles size={17} /></div>
          <div className="answer-card">
            <div className="answer-head"><div><strong>LumaFlow 回答</strong><span><ShieldCheck size={13} /> 基于已审核资料</span></div><em>{result.confidence}% 匹配</em></div>
            <p>{result.answer}</p>
            {result.product && (
              <button className="answer-product" onClick={() => onProduct(result.product!)}>
                <ProductArt product={result.product} />
                <span><small>推荐产品</small><strong>{result.product.name}</strong><em>{result.product.model} · {result.product.power}</em></span>
                <ChevronRight size={18} />
              </button>
            )}
            <div className="answer-actions"><button onClick={copyAnswer}><Copy size={15} /> 复制答案</button><button onClick={() => result.product ? onAddToKit(result.product.id) : onToast("当前答案没有可加入的产品")}><Paperclip size={15} /> 加入资料包</button><button onClick={() => onToast(result.product ? "右侧已列出 3 项引用依据" : "当前没有可引用依据")}><History size={15} /> 查看依据</button></div>
          </div>
        </div>
        <div className="chat-input-wrap">
          <div className="chat-input"><Sparkles size={18} /><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (input.trim()) setQuestion(input); } }} aria-label="输入产品问题" placeholder="输入客户的问题…" /><button aria-label="发送问题" onClick={() => input.trim() && setQuestion(input)}><Send size={17} /></button></div>
          <small>Enter 发送 · Shift + Enter 换行 · 支持 SKU、参数、语义和附件搜索</small>
        </div>
      </section>
      <aside className="assistant-side">
        <div className="side-block"><span className="side-label">试试这样问</span>{quickQuestions.map((item) => <button key={item} onClick={() => { setInput(item); setQuestion(item); }}>{item}<ArrowRight size={14} /></button>)}</div>
        <div className="side-block sources"><span className="side-label">本次引用</span>{result.product ? <><Source icon={FileSpreadsheet} title={`${result.product.model} 参数表`} meta="已审核 · v3.2" /><Source icon={PackageCheck} title="实时库存快照" meta="更新于 14:20" /><Source icon={FileBadge} title="质保与销售政策" meta="2026 版" /></> : <p className="no-source">没有可引用的内部资料</p>}</div>
        <div className="trust-note"><ShieldCheck size={17} /><p><strong>回答边界</strong><span>找不到依据时不会编造产品信息；最终价格仍以审批报价为准。</span></p></div>
      </aside>
    </div>
  );
}

function Source({ icon: Icon, title, meta }: { icon: LucideIcon; title: string; meta: string }) {
  return <div className="source-row"><span><Icon size={15} /></span><div><strong>{title}</strong><small>{meta}</small></div><CheckCircle2 size={14} /></div>;
}

function SalesKitView({ products, initialProductId, onProduct, onToast }: { products: Product[]; initialProductId: string; onProduct: (product: Product) => void; onToast: (message: string) => void }) {
  const [productId, setProductId] = useState(initialProductId);
  const product = products.find((item) => item.id === productId) ?? products[0];
  const [selectedAssets, setSelectedAssets] = useState<string[]>(product.assets.map((asset) => asset.id));
  const [sendMethod, setSendMethod] = useState<"share" | "download">("share");
  const message = buildSalesMessage(product);

  function changeProduct(id: string) {
    const next = products.find((item) => item.id === id) ?? products[0];
    setProductId(id);
    setSelectedAssets(next.assets.map((asset) => asset.id));
  }

  async function copyMessage() {
    await navigator.clipboard.writeText(message);
    onToast("推荐话术已复制");
  }

  async function downloadPackage() {
    const { default: JSZip } = await import("jszip");
    const assets = product.assets.filter((asset) => selectedAssets.includes(asset.id));
    const zip = new JSZip();
    zip.file("01-客户推荐话术.txt", message);
    zip.file("02-产品参数.csv", `字段,内容\n产品,${product.name}\n型号,${product.model}\nSKU,${product.sku}\n功率,${product.power}\n光通量,${product.lumens}\n色温,${product.colorTemp}\n材质,${product.material}\n尺寸,${product.dimensions}\n颜色,${product.colors.join("、")}\n场景,${product.scenarios.join("、")}\n报价区间,${product.priceRange}\n质保,${product.warranty}`);
    zip.file("03-附件清单.txt", assets.map((asset, index) => `${index + 1}. ${asset.name}（${asset.type}，${asset.size}，${asset.version ?? "v1.0"}）`).join("\n"));
    zip.file("README.txt", "本压缩包由 LumaFlow 生成。当前演示目录保存附件清单与结构化产品参数；接入企业对象存储后，将把已审核的图片、PDF、证书和视频原件一并打包。正式报价请以 CPQ 审批版本为准。\n");
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${product.model}-销售资料包.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    onToast("销售资料包 ZIP 已下载");
  }

  async function sharePackage() {
    if (navigator.share) {
      await navigator.share({ title: `${product.name} 销售资料`, text: message });
      onToast("系统分享面板已打开");
      return;
    }
    await navigator.clipboard.writeText(message);
    onToast("当前浏览器不支持系统分享，话术已复制");
  }

  return (
    <div className="kit-layout">
      <section className="kit-builder panel">
        <div className="step-head"><span>01</span><div><h2>选择产品</h2><p>资料与话术会随产品自动更新</p></div></div>
        <div className="select-wrap"><select value={productId} onChange={(event) => changeProduct(event.target.value)} aria-label="选择产品">{products.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.model}</option>)}</select><ChevronDown size={17} /></div>
        <button className="selected-product-row" onClick={() => onProduct(product)}><ProductArt product={product} /><span><small>{product.category}</small><strong>{product.name}</strong><em>{product.sku}</em></span><ChevronRight size={18} /></button>

        <div className="step-divider" />
        <div className="step-head"><span>02</span><div><h2>选择附件</h2><p>已按推荐优先级排序</p></div><em>{selectedAssets.length}/{product.assets.length} 已选</em></div>
        <div className="kit-assets">
          {product.assets.map((asset, index) => {
            const checked = selectedAssets.includes(asset.id);
            return <label key={asset.id} className={checked ? "selected" : ""}><input type="checkbox" checked={checked} onChange={() => setSelectedAssets((current) => checked ? current.filter((id) => id !== asset.id) : [...current, asset.id])} /><span className="custom-check">{checked && <Check size={13} />}</span><span className="kit-file-icon"><FileText size={17} /></span><span><strong>{asset.name}</strong><small>{asset.type} · {asset.size}</small></span>{index < 2 && <em>推荐</em>}</label>;
          })}
        </div>

        <div className="step-divider" />
        <div className="step-head"><span>03</span><div><h2>发送方式</h2><p>调用系统分享，或下载完整结构化 ZIP</p></div></div>
        <div className="send-options"><button className={sendMethod === "share" ? "selected" : ""} onClick={() => setSendMethod("share")}><Send size={18} /><span><strong>一键分享</strong><small>微信 / 邮件 / 系统应用</small></span>{sendMethod === "share" && <CheckCircle2 size={16} />}</button><button className={sendMethod === "download" ? "selected" : ""} onClick={() => setSendMethod("download")}><Download size={18} /><span><strong>下载资料包</strong><small>生成参数、话术与清单</small></span>{sendMethod === "download" && <CheckCircle2 size={16} />}</button></div>
      </section>

      <aside className="kit-preview">
        <div className="preview-head"><div><span>实时预览</span><strong>客户将看到的内容</strong></div><span className="live-dot">已同步</span></div>
        <div className="phone-preview">
          <div className="phone-bar"><ArrowLeft size={17} /><span><strong>客户 · 陈经理</strong><small>在线</small></span><span className="phone-dots">•••</span></div>
          <div className="preview-chat">
            <div className="preview-time">14:26</div>
            <div className="preview-bubble">{message}</div>
            <div className="preview-files">
              {product.assets.filter((asset) => selectedAssets.includes(asset.id)).map((asset) => <div key={asset.id}><span><FileText size={16} /></span><p><strong>{asset.name}</strong><small>{asset.size}</small></p><CheckCircle2 size={15} /></div>)}
            </div>
          </div>
        </div>
        <div className="kit-actions"><button className="outline-button" onClick={copyMessage}><Copy size={16} /> 复制话术</button><button className="primary-button" onClick={sendMethod === "share" ? sharePackage : downloadPackage}>{sendMethod === "share" ? <Send size={16} /> : <Download size={16} />} {sendMethod === "share" ? "一键分享" : "下载 ZIP"}</button></div>
        <p className="kit-footnote"><ShieldCheck size={14} /> 报价为参考区间，发送正式报价前需进入审批流程。</p>
      </aside>
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

function EmptyState({ icon: Icon, title, detail, action, onClick }: { icon: LucideIcon; title: string; detail: string; action?: string; onClick?: () => void }) {
  return <div className="empty-state"><span><Icon size={22} /></span><strong>{title}</strong><p>{detail}</p>{action && <button onClick={onClick}>{action}</button>}</div>;
}
