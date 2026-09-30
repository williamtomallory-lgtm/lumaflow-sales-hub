import type { Product } from "./catalog";
import type { KnowledgeEntry } from "./knowledge/contracts";

export function csvCell(value: string | number) {
  const text = String(value);
  return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
}

/** Fetch only explicitly selected originals. A failed attachment fails the whole export. */
export async function buildSalesKitArchive(product: Product, message: string, entries: KnowledgeEntry[]) {
  const { default: JSZip } = await import("jszip");
  if (entries.some((entry) => entry.source !== "uploaded")) throw new Error("仅可打包知识库真实上传原件");
  if (entries.reduce((total, entry) => total + entry.sizeBytes, 0) > 100 * 1024 * 1024) throw new Error("单次资料包附件不能超过 100 MB，请减少选择");
  const zip = new JSZip();
  zip.file("01-客户推荐话术.txt", message);
  const fields = { 产品: product.name, 型号: product.model, SKU: product.sku, 功率: product.power, 光通量: product.lumens, 色温: product.colorTemp, 材质: product.material, 尺寸: product.dimensions, 颜色: product.colors.join("、"), 场景: product.scenarios.join("、"), 参考价格: product.priceRange, 质保: product.warranty };
  zip.file("02-产品参数.csv", "\uFEFF" + Object.entries(fields).map((row) => row.map(csvCell).join(",")).join("\r\n"));
  for (const [index, entry] of entries.entries()) {
    const response = await fetch(`/api/v1/knowledge/${encodeURIComponent(entry.id)}/download`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${entry.originalName} 下载失败（${response.status}），未生成资料包`);
    const data = await response.arrayBuffer();
    if (data.byteLength !== entry.sizeBytes) throw new Error(`${entry.originalName} 文件大小已变更，请刷新知识库后重试`);
    const safeName = entry.originalName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "_");
    zip.file(`附件/${index + 1}-${safeName}`, data);
  }
  zip.file("03-附件清单.txt", entries.length ? entries.map((entry) => `${entry.originalName} · ${entry.sizeLabel} · ${entry.category ?? "未分类"}`).join("\n") : "未选择任何上传原件。产品目录中的附件名称仅是元数据，不代表本包包含原件。");
  zip.file("README.txt", "本包包含推荐话术、产品参数以及你明确选择的知识库原件。请在发送前检查价格、个人信息、客户聊天记录和内部资料。参考价格不构成正式报价；所有产品字段均需对照真实业务来源核实。未自动发送到微信。\n");
  return zip;
}
