import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductGallery } from "@/components/tianzhao-catalog";
import { getTianzhaoKnowledgeMetadata, getTianzhaoProduct } from "@/lib/ai/tianzhao-knowledge";
import styles from "./product-detail.module.css";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ model: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const product = getTianzhaoProduct((await params).model);
  return { title: product ? `${product.name || product.model} · 天昭灯网产品档案` : "未找到产品 · 天昭灯网" };
}

function shown(value: string | number | null | undefined) {
  return value === null || value === undefined || String(value).trim() === "" ? "暂无可靠资料" : String(value);
}

export default async function TianzhaoProductPage({ params }: Props) {
  const product = getTianzhaoProduct((await params).model);
  if (!product) notFound();
  const metadata = getTianzhaoKnowledgeMetadata();
  const fields: Array<[string, string]> = [
    ["型号", shown(product.model)],
    ["商品编码", shown(product.productCode)],
    ["原始品类", shown(product.category)],
    ["风格", shown(product.style)],
    ["材质标签", shown(product.materialTag)],
    ["截图展示价", product.priceCny === null ? "暂无可靠资料" : `¥${product.priceCny}${product.unit ? ` / ${product.unit}` : ""}`],
    ["价格范围说明", shown(product.priceScope)],
    ["选中规格", shown(product.selectedSpecification)],
    ["所有规格选项", product.specifications.join("、") || "暂无可靠资料"],
    ["颜色", shown(product.color)],
    ["颜色选项", product.colorOptions.join("、") || "暂无可靠资料"],
    ["尺寸", shown(product.dimensions)],
    ["光源", shown(product.lightSource)],
    ["材质", shown(product.material)],
    ["适用区域", shown(product.applicableArea)],
    ["场景", shown(product.scene)],
    ["资料状态", shown(product.availabilityStatus)],
    ["复核状态", shown(product.reviewStatus)],
    ["复核说明", shown(product.reviewNote)],
    ["OCR 型号说明", shown(product.ocrModelNote)],
    ["采集日期", shown(product.captureDate)],
    ["来源", shown(product.source)],
    ["原始记录文件", shown(product.jsonFile)],
  ];

  return <main className={styles.page}>
    <div className={styles.top}><Link href="/?knowledge=1">← 返回知识库产品目录</Link><span>天昭灯网 · 产品快照 {metadata.snapshotDate}</span></div>
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>{product.category || "未分类"} · {product.model}</span><h1>{product.name || product.model}</h1><p>商品编码：{shown(product.productCode)} · {product.previewImages.length} 张详情截图</p></div>
      <a href={metadata.archiveUrl} target="_blank" rel="noreferrer">下载原始资料包 ↗</a>
    </header>
    <p className={styles.notice}>展示价和状态来自 {metadata.snapshotDate} 快照；截图来自微信小程序详情页，并非商家原始产品图片。OCR 和规格请与原始截图核对。</p>
    <div className={styles.columns}>
      <section className={styles.imageCard}><h2>全部产品截图</h2><ProductGallery product={product} /><p>按缩略图切换，点击大图放大。原始高清文件见完整资料包。</p></section>
      <section className={styles.factCard}><h2>完整产品资料</h2><dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
    </div>
    <section className={styles.section}><h2>识别出的产品信息</h2>{product.photoTextOcr.length ? <ol>{product.photoTextOcr.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ol> : <p>目前没有可用的产品文字摘要。</p>}</section>
    <section className={styles.section}><h2>每张截图的完整 OCR 文字</h2><p>这些文字由图片自动识别，尚需对照截图核实。点击文件名展开查看。</p>{product.ocrImages.map((image) => <details className={styles.ocrItem} key={image.name}><summary>{image.name} · {image.lines.length ? `${image.lines.length} 条识别文字` : "无 OCR 结果"}</summary>{image.lines.length ? <ol>{image.lines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ol> : <p>这张截图没有生成可用的 OCR 结果。</p>}</details>)}</section>
    <section className={styles.section}><h2>截图与原始记录</h2><p>本产品关联 {product.evidence.length} 张原始截图；点击上方图库可预览所有可用截图。</p><ul className={styles.files}>{product.evidence.map((name) => <li key={name}>{name}</li>)}</ul><p>原始 JSON：{product.jsonFile}</p><a href={metadata.archiveUrl} target="_blank" rel="noreferrer">打开完整资料包 ↗</a></section>
    <details className={styles.raw}><summary>查看此商品的全部结构化字段</summary><pre>{JSON.stringify(product, null, 2)}</pre></details>
  </main>;
}
