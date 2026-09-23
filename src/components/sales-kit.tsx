"use client";

import { useState } from "react";
import { Check, Copy, Download, FileText, Send, ShieldCheck } from "lucide-react";
import type { Product } from "@/lib/catalog";
import type { KnowledgeEntry } from "@/lib/knowledge/contracts";
import { buildSalesMessage } from "@/lib/search";
import { buildSalesKitArchive } from "@/lib/sales-kit";

export function SalesKit({ products, entries, initialProductId, onProduct, onToast }: { products: Product[]; entries: KnowledgeEntry[]; initialProductId?: string; onProduct?: (product: Product) => void; onToast: (message: string) => void }) {
  const [productId, setProductId] = useState(initialProductId ?? products[0]?.id ?? "");
  const product = products.find((item) => item.id === productId) ?? products[0];
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editedMessage, setEditedMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  if (!product) return <section className="panel"><h2>销售资料包</h2><p>请先在知识资料中添加产品档案，再选择上传原件生成资料包。</p></section>;
  const message = editedMessage ?? buildSalesMessage(product).replace("我同时附上了产品图、参数表与相关证明资料，您可以直接查看。", "相关原件请以本次实际发送的附件为准。");
  const selected = entries.filter((entry) => selectedIds.includes(entry.id));
  const visible = entries.filter((entry) => `${entry.originalName} ${entry.title} ${entry.category ?? ""}`.toLowerCase().includes(query.toLowerCase()));

  async function run(action: "copy" | "share" | "download") {
    if (!product) return;
    setBusy(true); setError("");
    try {
      if (action === "download") {
        const zip = await buildSalesKitArchive(product, message, selected);
        const url = URL.createObjectURL(await zip.generateAsync({ type: "blob" }));
        const link = document.createElement("a");
        link.href = url; link.download = `${product.model.replace(/[<>:"/\\|?*]/g, "_")}-销售资料包.zip`;
        document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        onToast(`资料包已下载，包含 ${selected.length} 份真实原件`);
      } else if (action === "share" && navigator.share) {
        await navigator.share({ title: `${product.name} 销售资料`, text: message });
        onToast("分享操作完成；附件请通过下载 ZIP 交付");
      } else {
        await navigator.clipboard.writeText(message);
        onToast(action === "share" ? "浏览器不支持分享，话术已复制；未自动发送" : "推荐话术已复制");
      }
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "操作失败，请重试");
    } finally { setBusy(false); }
  }

  return <div className="kit-layout" aria-label="知识库销售资料包">
    <section className="kit-builder panel">
      <div className="step-head"><span>01</span><div><h2>选择产品</h2><p>产品参数来自知识库中的结构化档案</p></div></div>
      <div className="select-wrap"><select aria-label="资料包产品" value={product.id} onChange={(event) => { setProductId(event.target.value); setEditedMessage(null); setSelectedIds([]); }}>{products.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></div>
      <button className="selected-product-row" disabled={!onProduct} onClick={() => onProduct?.(product)}><span><strong>{product.name}</strong><em>{product.sku} · {product.power}</em></span></button>
      <div className="step-divider" />
      <div className="step-head"><span>02</span><div><h2>选择知识库原件</h2><p>仅选择可发给客户的资料；聊天记录和内部成本不会自动勾选。</p></div><em>{selected.length} 已选</em></div>
      <div className="select-wrap"><input aria-label="搜索资料包附件" placeholder="搜索文件名称或分类" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="kit-assets">{visible.map((entry) => <label key={entry.id} className={selectedIds.includes(entry.id) ? "selected" : ""}><input type="checkbox" checked={selectedIds.includes(entry.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, entry.id] : current.filter((id) => id !== entry.id))} /><span className="custom-check">{selectedIds.includes(entry.id) && <Check size={13} />}</span><FileText size={17} /><span><strong>{entry.originalName}</strong><small>{entry.category ?? "未分类"} · {entry.sizeLabel} · {entry.classificationSource === "manual" ? "已人工确认" : "发送前请审核"}</small></span></label>)}</div>
      {!visible.length && <p>没有匹配的上传原件。请回到“知识资料”上传文件；产品目录中的附件清单不等于原件。</p>}
    </section>
    <aside className="kit-preview panel">
      <div className="preview-head"><div><span>编辑与预览</span><strong>客户推荐话术</strong></div></div>
      <textarea className="kit-message-editor" aria-label="编辑资料包话术" value={message} onChange={(event) => setEditedMessage(event.target.value)} rows={12} />
      <p>将包含 {selected.length} 份原文件、产品参数 CSV 和上方话术。</p>
      <ul>{selected.map((entry) => <li key={entry.id}>{entry.originalName}</li>)}</ul>
      {error && <p role="alert">{error}</p>}
      <div className="kit-actions"><button className="outline-button" disabled={busy} onClick={() => void run("copy")}><Copy size={16} />复制话术</button><button className="outline-button" disabled={busy} onClick={() => void run("share")}><Send size={16} />分享话术</button><button className="primary-button" disabled={busy} onClick={() => void run("download")}><Download size={16} />{busy ? "处理中…" : "下载 ZIP"}</button></div>
      <p className="kit-footnote"><ShieldCheck size={14} />仅生成交付包，不会自动发送或发布。发送前请核实价格与资料授权。</p>
    </aside>
  </div>;
}
