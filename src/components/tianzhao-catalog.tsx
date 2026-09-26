"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Download, FileSpreadsheet, Image as ImageIcon, Search, X } from "lucide-react";
import styles from "./tianzhao-catalog.module.css";

type Product = {
  id: string; name: string; model: string; productCode: string; category: string; style: string;
  materialTag: string; priceCny: number | null; priceScope: string; unit: string;
  selectedSpecification: string; specifications: string[]; color: string; colorOptions: string[];
  dimensions: string; lightSource: string; material: string; applicableArea: string; scene: string;
  availabilityStatus: string; reviewStatus: string; reviewNote: string;
  photoTextOcr: string[]; evidence: string[]; jsonFile: string;
  previewImages: PreviewImage[];
};
type PreviewImage = { url: string; name: string; kind: string; top: number; height: number; width: number; totalHeight: number };
type Metadata = {
  snapshotDate: string; productCount: number; imageCount: number; ocrSidecarCount: number;
  sourceAudit: string; exportAudit: string; imageNotice: string; dataNotice: string;
  archiveUrl: string; releaseUrl: string; spreadsheetUrl: string;
  categories: Array<{ name: string; count: number; group: string }>;
  groups: Array<{ name: string; count: number }>;
};
type CatalogResponse = { data: Product[]; meta: { total: number; offset: number; limit: number; knowledgeBase: Metadata } };

const pageSize = 24;
function imageKind(kind: string) {
  return ({ cover: "首页", product: "产品", details: "详情", overview: "列表", screenshot: "截图" } as Record<string, string>)[kind] ?? "截图";
}
function PreviewFrame({ item, alt, className }: { item: PreviewImage; alt: string; className?: string }) {
  return <span className={`${styles.previewFrame} ${className ?? ""}`} style={{ aspectRatio: `${item.width} / ${item.height}` }}>
    <img src={item.url} alt={alt} loading="lazy" style={{ transform: `translateY(-${item.top / item.totalHeight * 100}%)` }} />
  </span>;
}

export function ProductGallery({ product }: { product: Pick<Product, "name" | "model" | "previewImages"> }) {
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    if (!zoom) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setZoom(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [zoom]);
  const images = product.previewImages ?? [];
  const selected = images[Math.min(active, images.length - 1)];
  return <section className={styles.gallery} aria-label="产品截图预览">
    <div className={styles.galleryHeading}><strong><ImageIcon size={17} /> 详情截图</strong><span>{images.length ? `${active + 1} / ${images.length}` : "暂无截图"}</span></div>
    {selected ? <>
      <button className={styles.mainImage} type="button" onClick={() => setZoom(true)} aria-label={`放大查看${imageKind(selected.kind)}截图`}>
        <PreviewFrame item={selected} alt={`${product.name || product.model}的微信小程序${imageKind(selected.kind)}截图`} />
        <span>点击放大</span>
      </button>
      <div className={styles.thumbnails} aria-label="切换产品截图">
        {images.map((item, index) => <button key={`${item.url}-${index}`} type="button" aria-pressed={active === index} onClick={() => setActive(index)} title={item.name}>
          <PreviewFrame item={item} alt="" /><span>{imageKind(item.kind)}</span>
        </button>)}
      </div>
    </> : <p className={styles.noImage}>这款产品没有可预览截图；如需核对，请查看资料包中的原始记录。</p>}
    {zoom && selected && <div className={styles.zoomBackdrop} role="presentation" onClick={() => setZoom(false)}>
      <div className={styles.zoomDialog} role="dialog" aria-modal="true" aria-label={`${product.name || product.model}截图`} onClick={(event) => event.stopPropagation()}>
        <button type="button" className={styles.zoomClose} aria-label="关闭大图" onClick={() => setZoom(false)}><X size={22} /></button>
        <PreviewFrame item={selected} alt={`${product.name || product.model}的微信小程序${imageKind(selected.kind)}截图`} />
        <p>{imageKind(selected.kind)} · {selected.name} · 网页预览为压缩截图，原图在完整资料包中。</p>
      </div>
    </div>}
  </section>;
}

export function TianzhaoCatalog() {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [group, setGroup] = useState("");
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
    if (query) params.set("q", query);
    if (category) params.set("category", category);
    if (group) params.set("group", group);
    fetch(`/api/v1/knowledge/tianzhao?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error?.message ?? `目录读取失败（${response.status}）`);
        if (!Array.isArray(payload?.data) || !Number.isInteger(payload?.meta?.total) || !payload?.meta?.knowledgeBase?.archiveUrl) {
          throw new Error("产品目录返回格式不完整");
        }
        return payload as CatalogResponse;
      })
      .then((payload) => { setResult(payload); setError(""); })
      .catch((caught) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "目录读取失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, category, group, page]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true); setPage(0); setQuery(draft.trim());
  }
  function chooseCategory(next: string) { setLoading(true); setCategory(next); if (next) setGroup(""); setPage(0); }
  function chooseGroup(next: string) { setLoading(true); setGroup(next); setCategory(""); setPage(0); }
  function changePage(next: number) { setLoading(true); setPage(next); }

  const metadata = result?.meta.knowledgeBase;
  return <section className={styles.root} aria-label="天昭灯网产品知识库">
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>2026-09-20 产品快照</span><h2>天昭灯网 · {metadata?.productCount ?? "1,887"} 款产品</h2>
        <p>型号、商品编码、规格与截图 OCR 的可检索索引。展示价和可用状态来自快照，不代表实时库存或正式报价。</p></div>
      <div className={styles.links}>
        <a href={metadata?.spreadsheetUrl} target="_blank" rel="noreferrer" aria-label="下载天昭灯网1887款Excel产品表"><FileSpreadsheet size={16} /> 下载完整 Excel</a>
        <a href={metadata?.archiveUrl} target="_blank" rel="noreferrer" aria-label="下载天昭灯网完整知识库压缩包"><Download size={16} /> 完整资料包</a>
      </div>
    </header>
    <div className={styles.stats}>
      <span><strong>{metadata?.productCount?.toLocaleString() ?? "1,887"}</strong> 产品记录</span>
      <span><strong>{metadata?.imageCount?.toLocaleString() ?? "7,674"}</strong> 详情截图</span>
      <span><strong>{metadata?.ocrSidecarCount?.toLocaleString() ?? "7,645"}</strong> OCR 结果</span>
      <span><strong>{metadata?.sourceAudit === "PASS" && metadata?.exportAudit === "PASS" ? "已核对" : "待核对"}</strong> 数据快照</span>
    </div>
    <form className={styles.search} onSubmit={search}><Search size={18} /><input value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="搜索天昭灯网型号或商品编码" placeholder="搜索型号、商品编码、品类或规格…" /><button type="submit">搜索</button></form>
    <div className={styles.filterHeading}><strong>按灯具类型浏览</strong><span>归并相近品类用于查找；商品的原始分类仍在详情中保留。</span></div>
    <div className={styles.groups} aria-label="灯具类型">
      <button type="button" aria-pressed={!group && !category} onClick={() => chooseGroup("")}>全部产品 <small>{metadata?.productCount ?? 1887}</small></button>
      {metadata?.groups.map((item) => <button type="button" key={item.name} aria-pressed={group === item.name} onClick={() => chooseGroup(item.name)}>{item.name} <small>{item.count}</small></button>)}
    </div>
    <div className={styles.categorySelect}><label htmlFor="tianzhao-category">原始分类</label><select id="tianzhao-category" value={category} onChange={(event) => chooseCategory(event.target.value)}><option value="">全部原始分类（{metadata?.categories.length ?? 139} 类）</option>{metadata?.groups.map((item) => <optgroup key={item.name} label={item.name}>{metadata.categories.filter((entry) => entry.group === item.name).map((entry) => <option key={entry.name} value={entry.name}>{entry.name}（{entry.count}）</option>)}</optgroup>)}</select>{(query || category || group) && <button type="button" onClick={() => { setDraft(""); setQuery(""); setCategory(""); setGroup(""); setPage(0); }}>清除筛选</button>}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.summary}>{loading ? "正在读取产品目录…" : `找到 ${result?.meta.total.toLocaleString() ?? 0} 款产品；第 ${page + 1} 页`}</div>
    <div className={styles.list} aria-label="天昭灯网产品目录">
      {!loading && result?.data.map((product) => <a className={styles.product} key={product.id} href={`/knowledge/tianzhao/${encodeURIComponent(product.model)}`}>
        {product.previewImages?.[0] ? <PreviewFrame className={styles.productThumb} item={product.previewImages[0]} alt="" /> : <span className={styles.productThumbPlaceholder}><ImageIcon size={18} /></span>}
        <span className={styles.productText}><strong>{product.name || product.model || "未命名产品"}</strong><small>{product.model || "型号未识别"} · {product.productCode || "商品编码未识别"}</small><small>{product.previewImages?.length ?? 0} 张截图 · 点击查看完整资料</small></span>
        <em>{product.category || "未分类"}</em>
      </a>)}
      {!loading && !result?.data.length && <p className={styles.empty}>当前条件没有匹配的产品。可换型号、商品编码或清除分类重试。</p>}
    </div>
    <nav className={styles.pagination} aria-label="天昭灯网目录分页"><button type="button" disabled={loading || page === 0} onClick={() => changePage(page - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil((result?.meta.total ?? 0) / pageSize))}</span><button type="button" disabled={loading || !result || (page + 1) * pageSize >= result.meta.total} onClick={() => changePage(page + 1)}>下一页</button></nav>
    {metadata && <p className={styles.source}>来源：<a href={metadata.releaseUrl} target="_blank" rel="noreferrer">GitHub Release · {metadata.snapshotDate}</a>。{metadata.dataNotice}</p>}
  </section>;
}
