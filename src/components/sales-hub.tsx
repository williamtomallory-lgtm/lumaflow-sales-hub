"use client";

import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
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
import { useMemo, useState } from "react";
import { allAssets, products, type Asset, type Product } from "@/lib/catalog";
import { answerQuestion, buildSalesMessage, searchProducts } from "@/lib/search";

type View = "overview" | "products" | "assets" | "assistant" | "kit" | "customers" | "quotation" | "followup" | "admin";

type NavItem = { id: View; label: string; icon: LucideIcon; badge?: string; phase?: string };

const primaryNav: NavItem[] = [
  { id: "overview", label: "工作台", icon: LayoutDashboard },
  { id: "products", label: "产品中心", icon: Box },
  { id: "assets", label: "资料中心", icon: FolderOpen },
  { id: "assistant", label: "知识问答", icon: Sparkles, badge: "AI" },
  { id: "kit", label: "销售资料包", icon: BriefcaseBusiness },
];

const secondaryNav: NavItem[] = [
  { id: "customers", label: "客户与会话", icon: UsersRound, phase: "二期" },
  { id: "quotation", label: "报价系统", icon: CircleDollarSign, phase: "三期" },
  { id: "followup", label: "跟进提醒", icon: Clock3, phase: "二期" },
  { id: "admin", label: "管理后台", icon: BarChart3, phase: "后续" },
];

const viewMeta: Record<View, { eyebrow: string; title: string; subtitle: string }> = {
  overview: { eyebrow: "9 月 4 日 · 星期五", title: "下午好，Junjun", subtitle: "这里是今天最值得你关注的产品与销售资料。" },
  products: { eyebrow: "产品中心", title: "把每个型号讲清楚", subtitle: "型号、参数、场景、库存和资料都在同一个视图里。" },
  assets: { eyebrow: "资料中心", title: "找到，选中，直接发", subtitle: "按产品归档的最新图片、参数表、证书与案例。" },
  assistant: { eyebrow: "知识问答", title: "把客户问题变成可发送答案", subtitle: "回答只引用已录入的产品数据，并明确给出匹配依据。" },
  kit: { eyebrow: "销售资料包", title: "十秒拼好一套客户资料", subtitle: "选择产品与附件，生成推荐话术并下载交付清单。" },
  customers: { eyebrow: "客户与会话", title: "会话上下文，正在连接", subtitle: "下一阶段将承接消息、意图与客户历史。" },
  quotation: { eyebrow: "报价系统", title: "把准确放在速度之前", subtitle: "价格库、数量阶梯、审批和报价单将在数据闭环后上线。" },
  followup: { eyebrow: "跟进提醒", title: "不错过该推进的客户", subtitle: "下一阶段将提供未回复提醒、行动建议与销售任务。" },
  admin: { eyebrow: "管理后台", title: "让知识持续可信", subtitle: "权限、数据质量、AI 日志和效果指标将在后续开放。" },
};

const quickQuestions = [
  "18W 黑色轨道灯，服装店用，今天能发吗？",
  "酒店餐厅适合哪款金色吊灯？",
  "推荐一款低眩光的办公室筒灯",
];

export function SalesHub() {
  const [view, setView] = useState<View>("overview");
  const [globalQuery, setGlobalQuery] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
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
            <button className="icon-button notification-button" aria-label="消息"><Inbox size={19} /><span /></button>
            <button className="primary-button compact" onClick={() => navigate("kit")}><Plus size={17} /> 新建资料包</button>
          </div>
        </header>

        <section className="page-wrap">
          <div className="page-heading">
            <div><span className="eyebrow">{meta.eyebrow}</span><h1>{meta.title}</h1><p>{meta.subtitle}</p></div>
            {view === "products" && <button className="outline-button"><Plus size={17} /> 新增产品</button>}
          </div>

          {view === "overview" && <Overview onNavigate={navigate} onProduct={setSelectedProduct} onAsk={(question) => { setGlobalQuery(question); navigate("assistant"); }} />}
          {view === "products" && <ProductsView initialQuery={globalQuery} onProduct={setSelectedProduct} />}
          {view === "assets" && <AssetsView onNavigate={navigate} />}
          {view === "assistant" && <AssistantView initialQuestion={globalQuery} onProduct={setSelectedProduct} onToast={showToast} />}
          {view === "kit" && <SalesKitView onProduct={setSelectedProduct} onToast={showToast} />}
          {(["customers", "quotation", "followup", "admin"] as View[]).includes(view) && <RoadmapView view={view} onNavigate={navigate} />}
        </section>
      </main>

      {selectedProduct && <ProductDrawer product={selectedProduct} onClose={() => setSelectedProduct(null)} onBuildKit={() => { setSelectedProduct(null); navigate("kit"); }} />}
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

function Overview({ onNavigate, onProduct, onAsk }: { onNavigate: (view: View) => void; onProduct: (product: Product) => void; onAsk: (question: string) => void }) {
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

function ProductsView({ initialQuery, onProduct }: { initialQuery: string; onProduct: (product: Product) => void }) {
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState("全部产品");
  const categories = ["全部产品", ...new Set(products.map((product) => product.category))];
  const results = useMemo(() => searchProducts(query).filter(({ product }) => category === "全部产品" || product.category === category), [query, category]);

  return (
    <div className="catalog-layout">
      <div className="catalog-toolbar">
        <div className="inline-search"><Search size={17} /><input data-testid="product-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索型号、SKU、功率、材质或场景" /><kbd>Enter</kbd></div>
        <button className="filter-button"><SlidersHorizontal size={16} /> 筛选 <span>2</span></button>
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

function AssetsView({ onNavigate }: { onNavigate: (view: View) => void }) {
  const [type, setType] = useState("全部资料");
  const [query, setQuery] = useState("");
  const assetTypes = ["全部资料", "图片", "参数表", "PDF", "证书", "案例"];
  const results = allAssets.filter((asset) => (type === "全部资料" || asset.type === type) && `${asset.name}${asset.productName}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="assets-layout">
      <section className="asset-summary-cards">
        <div><FileImage size={21} /><strong>7</strong><span>产品图片</span><small>全部已审核</small></div>
        <div><FileSpreadsheet size={21} /><strong>6</strong><span>参数资料</span><small>1 份本周更新</small></div>
        <div><ShieldCheck size={21} /><strong>4</strong><span>证书报告</span><small className="warning-text">3 份待补</small></div>
        <div><FileText size={21} /><strong>3</strong><span>案例与手册</span><small>可直接发送</small></div>
      </section>
      <section className="panel asset-browser">
        <div className="asset-toolbar">
          <div className="inline-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资料或产品" /></div>
          <button className="outline-button"><Plus size={16} /> 上传资料</button>
        </div>
        <div className="category-tabs compact-tabs">{assetTypes.map((item) => <button key={item} className={type === item ? "active" : ""} onClick={() => setType(item)}>{item}</button>)}</div>
        <div className="asset-table-wrap">
          <table className="asset-table">
            <thead><tr><th>资料名称</th><th>关联产品</th><th>类型</th><th>大小</th><th>状态</th><th /></tr></thead>
            <tbody>{results.map((asset) => <AssetRow key={asset.id} asset={asset} />)}</tbody>
          </table>
        </div>
        {results.length === 0 && <EmptyState icon={FolderOpen} title="没有找到资料" detail="换一个关键词或资料类型试试。" />}
      </section>
      <div className="asset-cta"><div><Sparkles size={20} /><span><strong>不用逐份挑选</strong><small>销售资料包会自动推荐与产品匹配的附件。</small></span></div><button onClick={() => onNavigate("kit")}>去组资料包 <ArrowRight size={15} /></button></div>
    </div>
  );
}

function AssetRow({ asset }: { asset: Asset & { productName: string } }) {
  const icon = asset.type === "图片" ? FileImage : asset.type === "证书" ? FileBadge : asset.type === "参数表" ? FileSpreadsheet : FileText;
  const Icon = icon;
  return <tr><td><span className="file-icon"><Icon size={17} /></span><strong>{asset.name}</strong></td><td>{asset.productName}</td><td><span className="type-pill">{asset.type}</span></td><td>{asset.size}</td><td><span className="ready-status"><Check size={12} /> 可发送</span></td><td><button className="icon-button" aria-label={`下载 ${asset.name}`}><Download size={16} /></button></td></tr>;
}

function AssistantView({ initialQuestion, onProduct, onToast }: { initialQuestion: string; onProduct: (product: Product) => void; onToast: (message: string) => void }) {
  const starter = initialQuestion && initialQuestion.length < 90 ? initialQuestion : quickQuestions[0];
  const [input, setInput] = useState(starter);
  const [question, setQuestion] = useState(starter);
  const result = useMemo(() => answerQuestion(question), [question]);

  async function copyAnswer() {
    await navigator.clipboard.writeText(result.answer);
    onToast("答案已复制，可以直接发给客户");
  }

  return (
    <div className="assistant-layout">
      <section className="assistant-main">
        <div className="chat-date"><span>今天</span></div>
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
            <div className="answer-actions"><button onClick={copyAnswer}><Copy size={15} /> 复制答案</button><button><Paperclip size={15} /> 加入资料包</button><button><History size={15} /> 查看依据</button></div>
          </div>
        </div>
        <div className="chat-input-wrap">
          <div className="chat-input"><Sparkles size={18} /><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (input.trim()) setQuestion(input); } }} aria-label="输入产品问题" placeholder="输入客户的问题…" /><button aria-label="发送问题" onClick={() => input.trim() && setQuestion(input)}><Send size={17} /></button></div>
          <small>Enter 发送 · Shift + Enter 换行</small>
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

function SalesKitView({ onProduct, onToast }: { onProduct: (product: Product) => void; onToast: (message: string) => void }) {
  const [productId, setProductId] = useState(products[0].id);
  const product = products.find((item) => item.id === productId) ?? products[0];
  const [selectedAssets, setSelectedAssets] = useState<string[]>(product.assets.map((asset) => asset.id));
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

  function downloadManifest() {
    const assets = product.assets.filter((asset) => selectedAssets.includes(asset.id));
    const content = `LumaFlow 销售资料包\n${"=".repeat(30)}\n\n${message}\n\n附件清单\n${assets.map((asset, index) => `${index + 1}. ${asset.name}（${asset.type}，${asset.size}）`).join("\n")}\n\n生成时间：${new Date().toLocaleString("zh-CN")}`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${product.model}-销售资料包清单.txt`;
    link.click();
    URL.revokeObjectURL(url);
    onToast("资料包清单已下载");
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
        <div className="step-head"><span>03</span><div><h2>发送方式</h2><p>首版支持复制话术与下载清单</p></div></div>
        <div className="send-options"><button className="selected"><Copy size={18} /><span><strong>复制并发送</strong><small>适合微信 / 邮件</small></span><CheckCircle2 size={16} /></button><button><Download size={18} /><span><strong>下载资料包</strong><small>生成交付清单</small></span></button></div>
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
        <div className="kit-actions"><button className="outline-button" onClick={copyMessage}><Copy size={16} /> 复制话术</button><button className="primary-button" onClick={downloadManifest}><Download size={16} /> 下载资料包</button></div>
        <p className="kit-footnote"><ShieldCheck size={14} /> 报价为参考区间，发送正式报价前需进入审批流程。</p>
      </aside>
    </div>
  );
}

function ProductDrawer({ product, onClose, onBuildKit }: { product: Product; onClose: () => void; onBuildKit: () => void }) {
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
          <Detail label="颜色" value={product.colors.join("、")} />
          <Detail label="起订量" value={`${product.moq} 件`} />
          <Detail label="库存与交期" value={`${product.stock} 件 · ${product.leadTime}`} />
          <Detail label="参考报价" value={product.priceRange} />
          <Detail label="供应商" value={product.supplier} />
        </div>
        <div className="drawer-section"><span>适用场景</span><div className="scenario-list">{product.scenarios.map((item) => <em key={item}>{item}</em>)}</div></div>
        <div className="drawer-section"><span>关联资料 · {product.assets.length}</span><div className="drawer-files">{product.assets.map((asset) => <div key={asset.id}><FileText size={16} /><p><strong>{asset.name}</strong><small>{asset.type} · {asset.size}</small></p><CheckCircle2 size={15} /></div>)}</div></div>
        <div className="drawer-actions"><button className="outline-button"><MessageCircleMore size={16} /> 问产品问题</button><button className="primary-button" onClick={onBuildKit}><BriefcaseBusiness size={16} /> 生成资料包</button></div>
      </aside>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function RoadmapView({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  const map: Record<string, { phase: string; icon: LucideIcon; items: string[] }> = {
    customers: { phase: "第二阶段 · 3–4 周", icon: UsersRound, items: ["客户消息接入与意图识别", "客户档案和会话上下文", "从知识库生成待审回复"] },
    quotation: { phase: "第三阶段", icon: CircleDollarSign, items: ["价格库与数量阶梯", "折扣权限和审批流程", "报价 PDF 与版本管理"] },
    followup: { phase: "第二阶段 · 3–4 周", icon: Clock3, items: ["未回复客户提醒", "自动生成下一步话术", "销售任务与状态跟踪"] },
    admin: { phase: "持续建设", icon: BarChart3, items: ["用户与角色权限", "知识质量和过期提醒", "使用统计与效果评估"] },
  };
  const item = map[view];
  const Icon = item.icon;
  return (
    <section className="roadmap-card">
      <div className="roadmap-icon"><Icon size={28} /></div><span>{item.phase}</span><h2>这个模块有清晰计划，<br />但不伪装成已经完成。</h2><p>首版先让产品资料、搜索、问答和资料包形成真实闭环，再接入需要权限、消息渠道或价格审批的数据。</p>
      <div className="roadmap-items">{item.items.map((text, index) => <div key={text}><span>{String(index + 1).padStart(2, "0")}</span><strong>{text}</strong><em>规划中</em></div>)}</div>
      <button className="primary-button" onClick={() => onNavigate("overview")}><ArrowLeft size={16} /> 返回已上线功能</button>
    </section>
  );
}

function EmptyState({ icon: Icon, title, detail, action, onClick }: { icon: LucideIcon; title: string; detail: string; action?: string; onClick?: () => void }) {
  return <div className="empty-state"><span><Icon size={22} /></span><strong>{title}</strong><p>{detail}</p>{action && <button onClick={onClick}>{action}</button>}</div>;
}
