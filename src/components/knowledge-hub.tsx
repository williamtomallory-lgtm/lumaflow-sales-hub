"use client";

import Image from "next/image";

import {
  Archive,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Download,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { KnowledgeCategory } from "@/lib/business";
import type { Asset, Product } from "@/lib/catalog";
import { createProductViaApi } from "@/lib/client/backend-api";
import type { DataSourceKind } from "@/lib/data-snapshot";
import { KNOWLEDGE_MAX_FILE_BYTES, knowledgeListResponseSchema, type KnowledgeEntry } from "@/lib/knowledge/contracts";
import { useModelCatalog } from "@/hooks/use-model-catalog";
import { useModelHealth } from "@/hooks/use-model-health";
import styles from "./knowledge-hub.module.css";
import { ModelRuntimeControls } from "./model-runtime-controls";
import { SalesKit } from "./sales-kit";
import { AgentKnowledgeLibrary } from "./agent-knowledge-library";
import { TianzhaoCatalog } from "./tianzhao-catalog";
import { KnowledgeWiki } from "./knowledge-wiki";

export type KnowledgeHubProps = {
  products?: Product[];
  assets?: Array<Asset & { productId: string; productName: string }>;
  dataSource?: DataSourceKind;
  initialQuery?: string;
  section?: "library" | "kit";
  onSectionChange?: (section: "library" | "kit") => void;
  kitProductId?: string;
  onOpenProduct?: (product: Product) => void;
  onToast: (message: string) => void;
  onWork?: () => void;
};

type ApiError = { error?: { message?: string } };
type KnowledgeCategoryFilter = "全部" | KnowledgeCategory;

const categories: Array<KnowledgeCategoryFilter> = [
  "全部", "产品档案", "产品图片", "尺寸图", "参数表", "PDF资料", "证书", "案例", "视频", "说明书", "聊天记录",
  "FAQ", "销售话术", "产品知识", "公司知识", "政策", "文档解析",
];

function assetCategory(type: Asset["type"]): KnowledgeCategory {
  if (type === "图片") return "产品图片";
  if (type === "PDF") return "PDF资料";
  return type;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatUploadedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
}

function statusLabel(entry: KnowledgeEntry) {
  if (entry.classificationStatus === "classified" && entry.classificationSource === "manual") return "已人工确认";
  if (entry.classificationError) return entry.category ? "已有分类 · 重试失败" : "待分类 · 可重试";
  if (entry.parseStatus !== "parsed") return "已归档 · 未理解";
  if (entry.classificationStatus === "classified") return "LLMWiki 已更新 · 待确认";
  if (entry.classificationStatus === "pending") return "LLMWiki 理解中";
  return "已保存 · 待理解";
}

export function KnowledgeHub({ products = [], assets = [], dataSource = "json", initialQuery = "", section: controlledSection, onSectionChange, kitProductId, onOpenProduct, onToast, onWork }: KnowledgeHubProps) {
  const [localSection, setLocalSection] = useState<"library" | "kit">("library");
  const section = controlledSection ?? localSection;
  const changeSection = (next: "library" | "kit") => { setLocalSection(next); onSectionChange?.(next); };
  const [uploaded, setUploaded] = useState<KnowledgeEntry[]>([]);
  const [summary, setSummary] = useState<ReturnType<typeof emptySummary>>(emptySummary());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [archiveAvailable, setArchiveAvailable] = useState(true);
  const [requiresLogin, setRequiresLogin] = useState(false);
  const [wikiRevision, setWikiRevision] = useState(0);
  const [uploadLimitBytes, setUploadLimitBytes] = useState(KNOWLEDGE_MAX_FILE_BYTES);
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState<KnowledgeCategoryFilter>("全部");
  const [selectedId, setSelectedId] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [retryingId, setRetryingId] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const [catalogProducts, setCatalogProducts] = useState(products);
  const [creatingProduct, setCreatingProduct] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { models, modelProfileId, selectedModel, selectModel, loading: loadingModels, error: modelError, refresh: refreshModels } = useModelCatalog();
  const { health, checking: checkingHealth, refresh: refreshHealth } = useModelHealth(modelProfileId);

  async function loadKnowledge() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/v1/knowledge?limit=200", { cache: "no-store", headers: { Accept: "application/json" } });
      const payload: unknown = await response.json();
      if (response.status === 401) {
        setRequiresLogin(true);
        setArchiveAvailable(false);
        setUploaded([]);
        setSummary(emptySummary());
        return;
      }
      if (!response.ok) throw new Error((payload as ApiError)?.error?.message || `知识库返回 ${response.status}`);
      setRequiresLogin(false);
      const parsed = knowledgeListResponseSchema.parse(payload);
      setArchiveAvailable(parsed.meta.archiveAvailable);
      setUploadLimitBytes(parsed.meta.uploadLimitBytes);
      const entries = [...parsed.data];
      for (let offset = 200; offset < Math.min(parsed.summary.total, 500); offset += 200) {
        const page = await fetch(`/api/v1/knowledge?limit=200&offset=${offset}`, { cache: "no-store", headers: { Accept: "application/json" } });
        if (!page.ok) throw new Error(`知识库后续页面返回 ${page.status}`);
        entries.push(...knowledgeListResponseSchema.parse(await page.json()).data);
      }
      setUploaded([...new Map(entries.map((entry) => [entry.id, entry])).values()]);
      setSummary(parsed.summary);
      setWikiRevision((current) => current + 1);
      setSelectedId((current) => current && entries.some((entry) => entry.id === current) ? current : entries[0]?.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "知识库读取失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadKnowledge(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const selected = uploaded.find((entry) => entry.id === selectedId) ?? uploaded[0];
  const visibleEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return uploaded.filter((entry) => {
      const categoryMatch = category === "全部" || entry.category === category;
      const queryMatch = !normalized || `${entry.originalName} ${entry.title} ${entry.summary} ${entry.tags.join(" ")}`.toLowerCase().includes(normalized);
      return categoryMatch && queryMatch;
    });
  }, [category, query, uploaded]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleProducts = useMemo(() => catalogProducts.filter((product) => {
    if (category !== "全部" && category !== "产品档案" && category !== "产品知识") return false;
    return !normalizedQuery || `${product.name} ${product.model} ${product.sku} ${product.category} ${product.family} ${product.power} ${product.material} ${product.dimensions} ${product.scenarios.join(" ")} ${product.supplier}`.toLowerCase().includes(normalizedQuery);
  }), [catalogProducts, category, normalizedQuery]);
  const visibleAssets = useMemo(() => assets.filter((asset) => {
    if (category !== "全部" && assetCategory(asset.type) !== category) return false;
    return !normalizedQuery || `${asset.name} ${asset.productName} ${asset.type}`.toLowerCase().includes(normalizedQuery);
  }), [assets, category, normalizedQuery]);
  const maxCategoryCount = Math.max(1, ...summary.byCategory.map((item) => item.count));
  const populatedCategories = categories.slice(1).map((item) => ({
    category: item,
    count: summary.byCategory.find((row) => row.category === item)?.count ?? 0,
  })).filter((item) => item.count > 0);
  const healthLabel = checkingHealth ? "检测中" : health?.reachable ? health.connectionKind === "protocol-mock" ? "协议模拟" : "已连接" : selectedModel?.configured ? "未连接" : "未配置";

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    let completed = 0;
    let understood = 0;
    let wikiFailed = 0;
    try {
      for (const file of Array.from(files)) {
        if (file.size > uploadLimitBytes) throw new Error(`${file.name} 超过当前站点单文件 ${Math.round(uploadLimitBytes / 1024 / 1024)} MB 的上传上限。`);
        const body = new FormData();
        body.append("file", file);
        body.append("modelProfileId", modelProfileId);
        const response = await fetch("/api/v1/knowledge", { method: "POST", body });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error((payload as ApiError)?.error?.message || `${file.name} 上传失败`);
        completed += 1;
        if ((payload as { meta?: { classified?: boolean } }).meta?.classified) understood += 1;
        if ((payload as { meta?: { wikiStatus?: string } }).meta?.wikiStatus === "failed") wikiFailed += 1;
      }
      const understanding = understood ? `LLMWiki 已理解 ${understood} 个` : "正文会显示为待理解状态";
      const wikiMessage = wikiFailed ? `，${wikiFailed} 个 Wiki 更新失败，可刷新后重试` : "，Wiki 已同步";
      onToast(`${completed} 个文件已保存，${understanding}${wikiMessage}；不可解析文件仅归档。`);
      await loadKnowledge();
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : "上传失败");
      await loadKnowledge();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function retryClassification(entry: KnowledgeEntry) {
    if (entry.source !== "uploaded" || !entry.hasText) return;
    setRetryingId(entry.id);
    try {
      const response = await fetch(`/api/v1/knowledge/${encodeURIComponent(entry.id)}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelProfileId }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error((payload as ApiError)?.error?.message || "分类重试失败");
      onToast((payload as { meta?: { classified?: boolean } }).meta?.classified ? "模型分类已更新" : "模型暂时不可用，文件已保留待重试");
      await loadKnowledge();
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : "分类重试失败");
    } finally {
      setRetryingId(undefined);
    }
  }

  async function confirmClassification(entry: KnowledgeEntry, nextCategory: string) {
    if (!nextCategory || entry.source !== "uploaded") return;
    try {
      const response = await fetch(`/api/v1/knowledge/${encodeURIComponent(entry.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: nextCategory, status: "classified" }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error((payload as ApiError)?.error?.message || "人工确认失败");
      onToast("分类已人工确认；确认后的正文才会进入智能搜索");
      await loadKnowledge();
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : "人工确认失败");
    }
  }

  async function deleteKnowledge(entry: KnowledgeEntry) {
    if (!window.confirm(`确定删除“${entry.originalName}”？原文件、元数据和对应 Wiki 来源页都会从本机移除。`)) return;
    setDeletingId(entry.id);
    try {
      const response = await fetch(`/api/v1/knowledge/${encodeURIComponent(entry.id)}`, {
        method: "DELETE",
        headers: { Accept: "application/json" },
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error((payload as ApiError)?.error?.message || "删除失败");
      const wikiStatus = (payload as { meta?: { wikiStatus?: string } }).meta?.wikiStatus;
      onToast(wikiStatus === "failed" ? `${entry.originalName} 已删除，Wiki 稍后需要重建` : `${entry.originalName} 已删除，LLMWiki 已同步`);
      await loadKnowledge();
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : "删除失败");
    } finally {
      setDeletingId(undefined);
    }
  }

  return (
    <div className={styles.knowledgeHub}>
      <div className={styles.categoryTabs} role="tablist" aria-label="知识库栏目">
        <button role="tab" aria-selected={section === "library"} className={section === "library" ? styles.activeTab : ""} onClick={() => changeSection("library")}>知识资料</button>
        <button role="tab" aria-selected={section === "kit"} className={section === "kit" ? styles.activeTab : ""} onClick={() => changeSection("kit")}>销售资料包</button>
        {onWork && <button type="button" onClick={onWork}>用 Work 处理文件 <ChevronRight size={14} /></button>}
      </div>
      {section === "kit" && <SalesKit key={kitProductId} products={catalogProducts} entries={uploaded} initialProductId={kitProductId} onProduct={onOpenProduct} onToast={onToast} />}
      <div hidden={section !== "library"}>
      <section className={styles.topPanel}>
        <div className={styles.topCopy}>
          <span className={styles.eyebrow}><Sparkles size={14} /> 本地知识资产</span>
          <h2>{requiresLogin ? "登录后管理你的私人知识库" : archiveAvailable ? "上传文件后由 LLMWiki 自动整理" : "天昭产品可在线检索；上传请使用本机站点"}</h2>
          <p>{requiresLogin ? "上传的原件与知识条目按账号隔离。登录后可以查看、上传和整理自己的资料。" : archiveAvailable ? "本地运行时，原件与 Wiki 保存在项目 .local-data/knowledge；能解析的正文会交给所选模型理解，并同步生成或更新 LLMWiki。图片和无法解析的文件会明确标记为“仅归档未理解”。" : "公开站点尚未配置持久文件存储。下方产品快照与 Excel 可以在线查看，私人文件请在本机站点上传。"}</p>
        </div>
        <div className={styles.modelControls}>
          <label><span>分类模型</span><select aria-label="知识库分类模型" value={modelProfileId} disabled={loadingModels || models.length === 0} onChange={(event) => selectModel(event.target.value)}>{models.length ? models.map((model) => <option value={model.id} key={model.id} disabled={model.installationStatus === "not-downloaded"}>{model.label} · {model.installationStatus === "not-downloaded" ? "未下载" : model.id === modelProfileId ? healthLabel : model.reachable ? "已连接" : model.configured ? "未连接" : "未配置"}</option>) : <option value={modelProfileId}>正在读取模型列表…</option>}</select></label>
          <button className={styles.refreshButton} onClick={() => { refreshModels(); refreshHealth(); }} aria-label="刷新分类模型连接" title="刷新模型连接"><RefreshCw size={15} /></button>
          <small className={health?.reachable ? styles.connected : styles.disconnected}>{healthLabel}</small>
        </div>
        {modelError && <p className={styles.inlineWarning}>{modelError}</p>}
      </section>

      <ModelRuntimeControls models={models} modelProfileId={modelProfileId} disabled={uploading || loadingModels} onModelChange={selectModel} />
      <TianzhaoCatalog />
      {archiveAvailable && !loading && <AgentKnowledgeLibrary documents={uploaded} onToast={onToast} />}
      {archiveAvailable && !loading && <KnowledgeWiki revision={wikiRevision} />}
      <section className={styles.unifiedToolbarPanel} aria-label="本机文件与自建档案筛选">
        <div className={styles.toolbar}>
          <div className={styles.searchBox}><Search size={16} /><input aria-label="搜索本机文件和自建档案" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索本机上传文件或自建产品档案…" /></div>
          <input ref={fileRef} aria-label="上传知识文件" type="file" multiple hidden disabled={!archiveAvailable || requiresLogin} onChange={(event) => void uploadFiles(event.target.files)} />
          <button className={styles.secondaryButton} onClick={() => void loadKnowledge()} disabled={loading || uploading}><RefreshCw size={15} /> 刷新</button>
          <button className={styles.primaryButton} title={`单文件上限 ${Math.round(uploadLimitBytes / 1024 / 1024)} MB`} onClick={() => fileRef.current?.click()} disabled={uploading || !archiveAvailable || requiresLogin}><Upload size={16} /> {requiresLogin ? "登录后上传" : archiveAvailable ? uploading ? "上传并分类中…" : "上传文件" : "仅本机可上传"}</button>
        </div>
        {requiresLogin && <p className={styles.loginNotice}>私人资料需要登录后访问。<a href="/auth/login?returnTo=/?knowledge=1">登录或注册</a></p>}
        <div className={styles.categoryTabs} role="tablist" aria-label="本机文件分类筛选">{categories.map((item) => <button role="tab" aria-selected={category === item} className={category === item ? styles.activeTab : ""} key={item} onClick={() => setCategory(item)}>{item}</button>)}</div>
      </section>
      {(catalogProducts.length > 0 || assets.length > 0) && <section className={styles.catalogPanel} aria-label="自建产品与关联资料目录">
        <div className={styles.sectionHead}><div><span>LOCAL CATALOG</span><h3>自建产品档案与关联资料</h3></div><div className={styles.catalogHeadActions}><span className={styles.sourceBadge}>{catalogProducts.length} 个自建产品 · {assets.length} 份资料</span><button className={styles.secondaryButton} onClick={() => setCreatingProduct(true)} disabled={!archiveAvailable && dataSource !== "postgres"}><Plus size={14} /> 新增产品档案</button></div></div>
        <p className={styles.catalogHint}>此处只展示手动新增的产品；上方天昭目录包含快照中的 1,887 款产品和全部截图。</p>
        <div className={styles.catalogColumns}>
          <div className={styles.productKnowledgeList}>
            <strong>产品档案 · {visibleProducts.length}</strong>
            {visibleProducts.length ? visibleProducts.map((product) => <button key={product.id} className={styles.productKnowledgeRow} onClick={() => onOpenProduct?.(product)} disabled={!onOpenProduct}>
              <span style={{ background: product.gradient }}>{product.model}</span>
              <span><strong>{product.name}</strong><small>{product.sku} · {product.power} · {product.material} · 库存 {product.stock}</small></span>
              <em>{product.status}</em><ChevronRight size={15} />
            </button>) : <div className={styles.catalogEmpty}>{catalogProducts.length ? "当前筛选下没有产品档案" : `后端尚未返回产品档案（当前来源：${dataSource === "postgres" ? "PostgreSQL" : "本地存储"}）`}</div>}
          </div>
          <div className={styles.assetKnowledgeList}>
            <strong>关联资料 · {visibleAssets.length}</strong>
            {visibleAssets.length ? visibleAssets.map((asset) => <div key={asset.id} className={styles.assetKnowledgeRow}>
              <span><CatalogFileIcon asset={asset} /></span>
              <span><strong>{asset.name}</strong><small>{asset.productName} · {asset.size} · {asset.version ?? "v1.0"}</small></span>
              <em>{assetCategory(asset.type)}</em>
            </div>) : <div className={styles.catalogEmpty}>{assets.length ? "当前筛选下没有关联资料" : "后端尚未返回产品关联资料；上传原件请使用下方文件区"}</div>}
          </div>
        </div>
      </section>}
      <section className={styles.metricGrid} aria-label="知识库真实统计">
        <Metric icon={FolderOpen} label="本地上传文件" value={String(summary.total)} detail={`${formatBytes(summary.storageBytes)} / ${formatBytes(summary.storageLimitBytes)}`} />
        <Metric icon={CheckCircle2} label="已分类文件" value={String(summary.classified)} detail="人工确认后可被智能搜索引用" />
        <Metric icon={LoaderCircle} label="待分类" value={String(summary.pending)} detail="模型失败也会保留原件" />
        <Metric icon={Archive} label="仅归档" value={String(summary.archived)} detail="当前版本未理解正文" />
      </section>

      <section className={styles.visualPanel} aria-label="知识分类可视化">
        <div className={styles.sectionHead}><div><span>后端文件数据</span><h3>分类分布</h3></div><span className={styles.sourceBadge}>仅统计真实上传</span></div>
        {populatedCategories.length === 0 ? <div className={styles.chartEmpty}><BarChart3 size={22} /><span>{summary.total === 0 ? "上传文件后，这里会按实际分类结果生成图表。" : "现有文件尚无分类结果；原件已保留。"}</span></div> : <div className={styles.barChart}>{populatedCategories.map(({ category: item, count }) => <div key={item} className={styles.barRow}><span>{item}</span><div><i style={{ width: `${Math.round((count / maxCategoryCount) * 100)}%` }} /></div><strong>{count}</strong></div>)}</div>}
      </section>

      <section className={styles.browserPanel}>
        <div className={styles.sectionHead}><div><span>UPLOADED FILES</span><h3>本地上传文件</h3></div><span className={styles.sourceBadge}>{visibleEntries.length} 个结果</span></div>
        {error && <div className={styles.errorBox} role="alert"><CircleAlert size={16} /> {error}<button onClick={() => void loadKnowledge()}>重试</button></div>}
        <div className={styles.browserGrid}>
          <div className={styles.entryList}>
            <div className={styles.listHeading}><span>真实上传 · {visibleEntries.length} 个文件</span><small>只展示后端返回的文件</small></div>
            {loading ? <div className={styles.emptyState}><LoaderCircle className={styles.spin} size={23} /><span>正在读取本地知识库…</span></div> : visibleEntries.length ? visibleEntries.map((entry) => <KnowledgeRow key={entry.id} entry={entry} selected={entry.id === selected?.id} onSelect={() => setSelectedId(entry.id)} />) : <div className={styles.emptyState}><FolderOpen size={23} /><strong>还没有真实上传文件</strong><span>可以上传 PDF、Excel、Word、图片、视频或任意其他文件。</span></div>}
          </div>
          <KnowledgeDetail key={selected?.id ?? "empty"} entry={selected} retryingId={retryingId} deletingId={deletingId} onRetry={(entry) => void retryClassification(entry)} onConfirm={(entry, next) => void confirmClassification(entry, next)} onDelete={(entry) => void deleteKnowledge(entry)} />
        </div>
      </section>

      {creatingProduct && <ProductKnowledgeForm onClose={() => setCreatingProduct(false)} onCreated={(product) => { setCatalogProducts((current) => [product, ...current]); setCreatingProduct(false); setCategory("产品档案"); setQuery(product.model); onToast(dataSource === "postgres" ? `${product.model} 已写入 PostgreSQL 并加入知识库` : `${product.model} 已写入后端本地存储`); }} />}
      </div>
    </div>
  );
}

function ProductKnowledgeForm({ onClose, onCreated }: { onClose: () => void; onCreated: (product: Product) => void }) {
  const [form, setForm] = useState({
    name: "", model: "", sku: "", category: "", family: "", status: "" as "" | Product["status"],
    power: "", lumens: "", colorTemp: "", material: "", dimensions: "", colors: "", scenarios: "",
    supplier: "", cost: "", priceRange: "", moq: "", stock: "", leadTime: "", warranty: "", description: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.status) return;
    const draft: Omit<Product, "id"> = {
      name: form.name.trim(), model: form.model.trim().toUpperCase(), sku: form.sku.trim().toUpperCase(), category: form.category.trim(), family: form.family.trim(),
      status: form.status, power: form.power.trim(), lumens: form.lumens.trim(), colorTemp: form.colorTemp.trim(), material: form.material.trim(),
      dimensions: form.dimensions.trim(), colors: form.colors.split(/[,，]/).map((value) => value.trim()).filter(Boolean), scenarios: form.scenarios.split(/[,，]/).map((value) => value.trim()).filter(Boolean),
      supplier: form.supplier.trim(), cost: Number(form.cost), priceRange: form.priceRange.trim(), moq: Number(form.moq), stock: Number(form.stock),
      leadTime: form.leadTime.trim(), warranty: form.warranty.trim(), description: form.description.trim(),
      gradient: "linear-gradient(145deg,#dfe5df,#81968a)", accent: "#a8c2b2", assets: [],
    };
    setSaving(true); setError("");
    try {
      onCreated(await createProductViaApi(draft));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存产品失败");
    } finally {
      setSaving(false);
    }
  }
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  return <div className={styles.modalLayer} role="dialog" aria-modal="true" aria-label="新增产品档案"><button className={styles.modalScrim} onClick={onClose} aria-label="关闭新增产品" /><form className={styles.productForm} onSubmit={submit}><div className={styles.productFormHead}><div><span>统一知识库</span><h3>新增真实产品档案</h3><p>所有业务字段必须由你填写，页面不会自动补造库存、价格或产品参数。</p></div><button type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><div className={styles.formGrid}>
    <label>产品名称<input required maxLength={160} value={form.name} onChange={(event) => update("name", event.target.value)} /></label><label>型号<input required maxLength={120} value={form.model} onChange={(event) => update("model", event.target.value)} /></label><label>SKU<input required maxLength={120} value={form.sku} onChange={(event) => update("sku", event.target.value)} /></label>
    <label>品类<input required maxLength={80} value={form.category} onChange={(event) => update("category", event.target.value)} /></label><label>产品系列<input required maxLength={120} value={form.family} onChange={(event) => update("family", event.target.value)} /></label><label>销售状态<select required value={form.status} onChange={(event) => update("status", event.target.value)}><option value="">请选择</option><option>在售</option><option>低库存</option><option>预售</option></select></label>
    <label>功率<input required maxLength={80} value={form.power} onChange={(event) => update("power", event.target.value)} /></label><label>光通量<input required maxLength={80} value={form.lumens} onChange={(event) => update("lumens", event.target.value)} /></label><label>色温<input required maxLength={120} value={form.colorTemp} onChange={(event) => update("colorTemp", event.target.value)} /></label>
    <label>材质<input required maxLength={160} value={form.material} onChange={(event) => update("material", event.target.value)} /></label><label>尺寸<input required maxLength={160} value={form.dimensions} onChange={(event) => update("dimensions", event.target.value)} /></label><label>颜色（逗号分隔）<input required value={form.colors} onChange={(event) => update("colors", event.target.value)} /></label>
    <label>适用场景（逗号分隔）<input required value={form.scenarios} onChange={(event) => update("scenarios", event.target.value)} /></label><label>供应商<input required maxLength={160} value={form.supplier} onChange={(event) => update("supplier", event.target.value)} /></label><label>内部成本<input required type="number" min="0" step="0.01" value={form.cost} onChange={(event) => update("cost", event.target.value)} /></label>
    <label>参考价格范围<input required maxLength={120} value={form.priceRange} onChange={(event) => update("priceRange", event.target.value)} placeholder="例如 ¥200–260" /></label><label>MOQ<input required type="number" min="0" step="1" value={form.moq} onChange={(event) => update("moq", event.target.value)} /></label><label>库存<input required type="number" min="0" step="1" value={form.stock} onChange={(event) => update("stock", event.target.value)} /></label>
    <label>交期<input required maxLength={180} value={form.leadTime} onChange={(event) => update("leadTime", event.target.value)} /></label><label>质保<input required maxLength={180} value={form.warranty} onChange={(event) => update("warranty", event.target.value)} /></label><label>产品说明<textarea required maxLength={2000} value={form.description} onChange={(event) => update("description", event.target.value)} /></label>
  </div>{error && <p className={styles.formError}>{error}</p>}<div className={styles.productFormActions}><button type="button" className={styles.secondaryButton} onClick={onClose}>取消</button><button className={styles.primaryButton} disabled={saving}>{saving ? "保存中…" : "保存产品档案"}</button></div></form></div>;
}

function emptySummary() {
  return { total: 0, classified: 0, pending: 0, archived: 0, byCategory: [] as Array<{ category: KnowledgeCategory; count: number }>, storageBytes: 0, storageLimitBytes: 2 * 1024 * 1024 * 1024, fileLimit: 500 };
}

function Metric({ icon: Icon, label, value, detail }: { icon: typeof FolderOpen; label: string; value: string; detail: string }) {
  return <div className={styles.metric}><span><Icon size={18} /></span><div><small>{label}</small><strong>{value}</strong><em>{detail}</em></div></div>;
}

function KnowledgeRow({ entry, selected, onSelect }: { entry: KnowledgeEntry; selected: boolean; onSelect: () => void }) {
  return <>
    <button className={`${styles.entryRow} ${selected ? styles.selectedRow : ""}`} aria-pressed={selected} onClick={onSelect}><span className={styles.fileIcon}><FileTypeIcon entry={entry} /></span><span className={styles.entryCopy}><strong>{entry.title}</strong><small>{entry.originalName} · {entry.sizeLabel}</small><span><i className={entry.classificationStatus === "pending" ? styles.pending : entry.classificationStatus === "archived" ? styles.archived : styles.ready}>{statusLabel(entry)}</i>{entry.category && <b>{entry.category}</b>}</span></span><ChevronRight size={16} /></button>
    {selected && <div className={styles.rowAttributes} role="region" aria-label="文件属性"><span><small>文件名</small><strong>{entry.originalName}</strong></span><span><small>类型</small><strong>{entry.mimeType || entry.extension || "未知"}</strong></span><span><small>大小</small><strong>{entry.sizeLabel}</strong></span><span><small>上传时间</small><strong>{formatUploadedAt(entry.uploadedAt)}</strong></span><span><small>状态</small><strong>{statusLabel(entry)}</strong></span><span><small>SHA-256</small><strong>{entry.sha256Prefix}…</strong></span></div>}
  </>;
}

function KnowledgeDetail({ entry, retryingId, deletingId, onRetry, onConfirm, onDelete }: { entry?: KnowledgeEntry; retryingId?: string; deletingId?: string; onRetry: (entry: KnowledgeEntry) => void; onConfirm: (entry: KnowledgeEntry, category: string) => void; onDelete: (entry: KnowledgeEntry) => void }) {
  const [category, setCategory] = useState(entry?.category ?? "");
  if (!entry) return <aside className={styles.detail}><div className={styles.emptyState}><FileText size={24} /><strong>选择一个文件</strong><span>查看分类、解析状态和可读正文预览。</span></div></aside>;
  const canRetry = entry.source === "uploaded" && entry.hasText && (entry.classificationStatus !== "classified" || Boolean(entry.classificationError));
  return <aside className={styles.detail} aria-label="知识文件详情"><div className={styles.detailTop}><span className={styles.detailType}>{entry.extension || "未知格式"}</span><span className={entry.classificationStatus === "archived" ? styles.archived : entry.classificationStatus === "pending" ? styles.pending : styles.ready}>{statusLabel(entry)}</span></div><h3>{entry.title}</h3><p className={styles.detailName}>{entry.originalName} · {entry.sizeLabel} · v{entry.version.replace(/^v/, "")}</p><p className={styles.detailSummary}>{entry.summary}</p>{entry.parseStatus !== "parsed" && <div className={styles.archiveNotice}><Archive size={17} /><div><strong>仅归档未理解</strong><span>{entry.parseError || "当前版本未提取可读正文；不会把文件名当成已理解内容。"}</span></div></div>}<FilePreview entry={entry} /><div className={styles.detailMeta}><span><small>分类来源</small><strong>{entry.classificationSource === "model" ? `模型自评 ${entry.confidence === null ? "—" : `${Math.round(entry.confidence * 100)}%`}` : entry.classificationSource === "manual" ? "人工确认" : "无"}</strong></span><span><small>正文字符</small><strong>{entry.characters.toLocaleString()}</strong></span><span><small>分类输入</small><strong>{entry.classificationCharacters.toLocaleString()} 字符</strong></span><span><small>标签</small><strong>{entry.tags.join("、") || "—"}</strong></span><span><small>SHA-256</small><strong>{entry.sha256Prefix}…</strong></span></div><div className={styles.detailActions}><a className={styles.secondaryButton} href={entry.downloadUrl}><Download size={15} /> 下载原件</a>{canRetry && <button className={styles.secondaryButton} disabled={retryingId === entry.id || deletingId === entry.id} onClick={() => onRetry(entry)}>{retryingId === entry.id ? <LoaderCircle className={styles.spin} size={15} /> : <RefreshCw size={15} />} 重试分类</button>}<button className={styles.dangerButton} disabled={deletingId === entry.id || retryingId === entry.id} onClick={() => onDelete(entry)}>{deletingId === entry.id ? <LoaderCircle className={styles.spin} size={15} /> : <Trash2 size={15} />} {deletingId === entry.id ? "删除中…" : "删除文件"}</button></div>{entry.hasText && entry.classificationSource !== "manual" && <div className={styles.confirmBox}><label>人工确认分类<select aria-label="人工确认知识分类" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">选择分类…</option>{categories.slice(1).map((item) => <option key={item} value={item}>{item}</option>)}</select></label><button className={styles.primaryButton} disabled={!category} onClick={() => onConfirm(entry, category)}><ShieldCheck size={15} /> 确认并纳入检索</button></div>}<p className={styles.detailFootnote}><ShieldCheck size={13} /> 新上传文件会先由 LLMWiki 解析和整理；人工确认分类后才会被销售角色引用。模型置信度只是模型自评，不是准确率保证；客户聊天记录请先确认隐私与权限。</p></aside>;
}

function FilePreview({ entry }: { entry: KnowledgeEntry }) {
  const previewUrl = `${entry.downloadUrl}?inline=1`;
  if (entry.mimeType.startsWith("image/")) {
    return <div className={styles.filePreview} role="region" aria-label="文件预览"><div className={styles.previewHeading}><span>文件预览</span><small>图片原件</small></div><Image className={styles.imagePreview} src={previewUrl} alt={entry.originalName} width={640} height={480} unoptimized /></div>;
  }
  if (entry.mimeType === "application/pdf" || entry.extension.toLowerCase() === "pdf") {
    return <div className={styles.filePreview} role="region" aria-label="文件预览"><div className={styles.previewHeading}><span>文件预览</span><small>PDF 原件</small></div><iframe className={styles.pdfPreview} src={previewUrl} title={`${entry.originalName} 预览`} /></div>;
  }
  if (entry.hasText) {
    return <div className={styles.filePreview} role="region" aria-label="文件预览"><div className={styles.previewHeading}><span>文件预览</span><small>已提取正文{entry.truncated ? " · 已截断" : ""}</small></div><pre className={styles.textPreview}>{entry.textPreview || "解析结果没有可展示的正文。"}</pre></div>;
  }
  return <div className={styles.filePreview} role="region" aria-label="文件预览"><div className={styles.previewHeading}><span>文件预览</span><small>暂不支持原生预览</small></div><div className={styles.previewEmpty}><FileText size={20} /><span>此文件已保存，可以下载原件查看。</span></div></div>;
}

function FileTypeIcon({ entry }: { entry: KnowledgeEntry }) {
  if (entry.mimeType.startsWith("image/")) return <FileImage size={18} />;
  if (["xlsx", "csv", "tsv"].includes(entry.extension)) return <FileSpreadsheet size={18} />;
  if (["zip", "rar", "7z"].includes(entry.extension)) return <FileArchive size={18} />;
  if (entry.hasText) return <FileText size={18} />;
  return <File size={18} />;
}

function CatalogFileIcon({ asset }: { asset: Asset }) {
  if (asset.type === "图片" || asset.type === "尺寸图") return <FileImage size={16} />;
  if (asset.type === "参数表") return <FileSpreadsheet size={16} />;
  if (asset.type === "PDF") return <FileText size={16} />;
  if (asset.type === "视频") return <File size={16} />;
  return <FileArchive size={16} />;
}
