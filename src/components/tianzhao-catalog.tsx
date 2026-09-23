"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Download, ExternalLink, FileSpreadsheet, Search } from "lucide-react";
import styles from "./tianzhao-catalog.module.css";

type Product = {
  id: string; name: string; model: string; productCode: string; category: string; style: string;
  materialTag: string; priceCny: number | null; priceScope: string; unit: string;
  selectedSpecification: string; specifications: string[]; color: string; colorOptions: string[];
  dimensions: string; lightSource: string; material: string; applicableArea: string; scene: string;
  availabilityStatus: string; reviewStatus: string; reviewNote: string;
};
type Metadata = {
  snapshotDate: string; productCount: number; imageCount: number; ocrSidecarCount: number;
  sourceAudit: string; exportAudit: string; imageNotice: string; dataNotice: string;
  archiveUrl: string; releaseUrl: string; spreadsheetUrl: string;
  categories: Array<{ name: string; count: number }>;
};
type CatalogResponse = { data: Product[]; meta: { total: number; offset: number; limit: number; knowledgeBase: Metadata } };

const pageSize = 24;
function known(value: string) { return value.trim() || "暂无可靠资料"; }

export function TianzhaoCatalog() {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<CatalogResponse | null>(null);
  const [selected, setSelected] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
    if (query) params.set("q", query);
    if (category) params.set("category", category);
    fetch(`/api/v1/knowledge/tianzhao?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error?.message ?? `目录读取失败（${response.status}）`);
        if (!Array.isArray(payload?.data) || !Number.isInteger(payload?.meta?.total) || !payload?.meta?.knowledgeBase?.archiveUrl) {
          throw new Error("产品目录返回格式不完整");
        }
        return payload as CatalogResponse;
      })
      .then((payload) => { setResult(payload); setError(""); setSelected(null); })
      .catch((caught) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "目录读取失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, category, page]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true); setPage(0); setQuery(draft.trim());
  }
  function chooseCategory(next: string) { setLoading(true); setCategory(next); setPage(0); }
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
    <div className={styles.categories} aria-label="天昭灯网产品分类">
      <button type="button" aria-pressed={!category} onClick={() => chooseCategory("")}>全部</button>
      {metadata?.categories.slice(0, 16).map((item) => <button type="button" key={item.name} aria-pressed={category === item.name} onClick={() => chooseCategory(item.name)}>{item.name} <small>{item.count}</small></button>)}
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.summary}>{loading ? "正在读取产品目录…" : `找到 ${result?.meta.total.toLocaleString() ?? 0} 款产品；第 ${page + 1} 页`}</div>
    <div className={styles.layout}>
      <div className={styles.list}>
        {!loading && result?.data.map((product) => <button type="button" className={styles.product} key={product.id} aria-pressed={selected?.id === product.id} onClick={() => setSelected(product)}>
          <span><strong>{product.name || product.model || "未命名产品"}</strong><small>{product.model || "型号未识别"} · {product.productCode || "商品编码未识别"}</small></span>
          <em>{product.category || "未分类"}</em>
        </button>)}
        {!loading && !result?.data.length && <p className={styles.empty}>当前条件没有匹配的产品。可换型号、商品编码或清除分类重试。</p>}
      </div>
      <aside className={styles.detail} aria-label="天昭灯网产品详情">
        {selected ? <><small>快照产品详情</small><h3>{selected.name || selected.model}</h3><p>{selected.model || "型号未识别"} · {selected.productCode || "商品编码未识别"}</p>
          <dl>
            <div><dt>品类 / 风格</dt><dd>{known(selected.category)} / {known(selected.style)}</dd></div>
            <div><dt>选中规格</dt><dd>{known(selected.selectedSpecification)}</dd></div>
            <div><dt>规格选项</dt><dd>{selected.specifications.join("、") || "暂无可靠资料"}</dd></div>
            <div><dt>颜色</dt><dd>{selected.colorOptions.join("、") || known(selected.color)}</dd></div>
            <div><dt>尺寸 / 光源</dt><dd>{known(selected.dimensions)} / {known(selected.lightSource)}</dd></div>
            <div><dt>材质 / 场景</dt><dd>{known(selected.material)} / {known(selected.scene || selected.applicableArea)}</dd></div>
            <div><dt>截图展示价</dt><dd>{selected.priceCny === null ? "暂无可靠资料" : `¥${selected.priceCny}${selected.unit ? ` / ${selected.unit}` : ""}`}</dd></div>
          </dl>
          {selected.reviewNote && <p className={styles.review}>{selected.reviewNote}</p>}
          <p className={styles.caution}>数据来自小程序详情截图及 OCR；具体参数请与原始 JSON 和截图核对。图片不是商家原始图片。</p>
          <a href={metadata?.archiveUrl} target="_blank" rel="noreferrer">查看原始记录与截图 <ExternalLink size={14} /></a>
        </> : <p className={styles.empty}>选择左侧产品查看规格。完整 1,887 款产品、图片和 OCR 文件可从上方资料包下载。</p>}
      </aside>
    </div>
    <nav className={styles.pagination} aria-label="天昭灯网目录分页"><button type="button" disabled={loading || page === 0} onClick={() => changePage(page - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil((result?.meta.total ?? 0) / pageSize))}</span><button type="button" disabled={loading || !result || (page + 1) * pageSize >= result.meta.total} onClick={() => changePage(page + 1)}>下一页</button></nav>
    {metadata && <p className={styles.source}>来源：<a href={metadata.releaseUrl} target="_blank" rel="noreferrer">GitHub Release · {metadata.snapshotDate}</a>。{metadata.dataNotice}</p>}
  </section>;
}
