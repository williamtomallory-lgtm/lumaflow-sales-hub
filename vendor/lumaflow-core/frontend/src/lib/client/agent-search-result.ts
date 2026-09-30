import type { SalesAgentUIMessage } from "../ai/sales-agent";
import type { SafeProductRecord } from "../ai/product-tooling";

export function projectAgentSearch(messages: SalesAgentUIMessage[]) {
  const products = new Map<string, SafeProductRecord>();
  const evidence = new Map<string, { title: string; detail: string }>();
  const sources = new Set<string>();
  const text: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "text") text.push(part.text);
      if (!("state" in part) || part.state !== "output-available") continue;
      if (part.output && typeof part.output === "object" && "source" in part.output && typeof part.output.source === "string") sources.add(part.output.source);
      if (part.type === "tool-searchProducts") {
        for (const product of part.output.products) {
          products.set(product.id, product);
          evidence.set(`product-${product.id}`, { title: product.sku, detail: "产品搜索工具返回" });
        }
      }
      if (part.type === "tool-getProductDetails" && part.output.found) {
        const product = part.output.product;
        products.set(product.id, product);
        evidence.set(`product-${product.id}`, { title: product.sku, detail: `产品详情 · ${product.model}` });
      }
      if (part.type === "tool-checkInventory" && part.output.found) {
        const inventory = part.output.inventory;
        evidence.set(`stock-${inventory.id}`, { title: `${inventory.sku} 库存 ${inventory.stock}`, detail: `核对时间：${inventory.checkedAt}` });
      }
      if (part.type === "tool-getProductAssets" && part.output.found) {
        for (const asset of part.output.assets) evidence.set(`asset-${asset.id}`, { title: asset.name, detail: `${asset.type} · ${asset.version ?? "版本未提供"} · ${asset.size}` });
      }
      if (part.type === "tool-searchKnowledge") {
        for (const entry of part.output.entries) evidence.set(`knowledge-${entry.id}`, { title: entry.title, detail: entry.citation });
      }
    }
  }
  return { text: text.join("\n").trim(), products: [...products.values()], evidence: [...evidence.values()], sources: [...sources] };
}
