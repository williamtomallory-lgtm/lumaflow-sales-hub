import { products, type Product } from "./catalog";

export type SearchResult = {
  product: Product;
  score: number;
  matches: string[];
};

const fieldLabels: Array<[keyof Product, string, number]> = [
  ["sku", "SKU", 10],
  ["model", "型号", 9],
  ["name", "产品名", 8],
  ["power", "功率", 8],
  ["material", "材质", 5],
  ["colors", "颜色", 5],
  ["scenarios", "适用场景", 6],
  ["category", "品类", 6],
  ["description", "产品说明", 2],
];

function normalize(value: string) {
  return value.toLowerCase().replace(/[\s，。？！、/\-]+/g, "");
}

function terms(query: string) {
  const compact = normalize(query);
  const latin = query.toLowerCase().match(/[a-z]+\d*|\d+w|\d+k/g) ?? [];
  const chinesePhrases = [
    "轨道灯", "吊灯", "磁吸灯", "线条灯", "洗墙灯", "户外灯", "壁灯", "筒灯",
    "服装店", "展厅", "画廊", "餐厅", "酒店", "办公室", "住宅", "精品店", "庭院", "露台", "商场",
    "黑色", "白色", "金色", "绿色", "压铸铝", "铝合金", "现货", "发货", "质保", "价格", "库存", "参数", "证书",
  ].filter((term) => compact.includes(normalize(term)));
  return [...new Set([...latin.map(normalize), ...chinesePhrases.map(normalize)])];
}

function aliases(value: string) {
  return normalize(value)
    .replaceAll("曜石黑", "黑色")
    .replaceAll("哑光黑", "黑色")
    .replaceAll("珍珠白", "白色")
    .replaceAll("香槟金", "金色")
    .replaceAll("苔藓绿", "绿色");
}

export function searchProducts(query: string, source: Product[] = products): SearchResult[] {
  if (!query.trim()) return source.map((product) => ({ product, score: 0, matches: [] }));
  const searchTerms = terms(query);
  const normalizedQuery = normalize(query);

  return source
    .map((product) => {
      let score = 0;
      const matches: string[] = [];
      for (const [field, label, weight] of fieldLabels) {
        const raw = Array.isArray(product[field]) ? (product[field] as string[]).join(" ") : String(product[field]);
        const normalizedField = aliases(raw);
        const hitCount = searchTerms.filter((term) => normalizedField.includes(aliases(term))).length;
        const directHit = normalizedField.includes(aliases(normalizedQuery));
        if (hitCount || directHit) {
          score += hitCount * weight + (directHit ? weight * 2 : 0);
          matches.push(label);
        }
      }
      if (normalizedQuery.includes("今天") && product.leadTime.includes("24 小时")) {
        score += 4;
        matches.push("发货时效");
      }
      if (normalizedQuery.includes("现货") && product.stock > 0) {
        score += 4;
        matches.push("库存");
      }
      return { product, score, matches: [...new Set(matches)] };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || b.product.stock - a.product.stock);
}

export function answerQuestion(query: string): { answer: string; product: Product | null; confidence: number } {
  const results = searchProducts(query);
  const product = results[0]?.product ?? null;
  if (!product) {
    return {
      answer: "暂时没有找到完全匹配的产品。建议补充品类、功率、颜色或使用场景，我可以继续缩小范围。",
      product: null,
      confidence: 0,
    };
  }

  const shipping = product.stock > 0 ? `当前库存 ${product.stock} 件，${product.leadTime}` : `当前为预售，${product.leadTime}`;
  const answer = `有，建议 ${product.name}（${product.model}）。${product.power}，${product.material}，可选${product.colors.join("、")}，适合${product.scenarios.join("、")}。${shipping}。参考报价 ${product.priceRange}，${product.warranty}。`;
  return {
    answer,
    product,
    confidence: Math.min(98, 68 + results[0].matches.length * 5),
  };
}

export function buildSalesMessage(product: Product) {
  return `您好，根据您的使用场景，为您推荐 ${product.name}（${product.model}）。\n\n• 功率/亮度：${product.power} / ${product.lumens}\n• 材质：${product.material}\n• 色温：${product.colorTemp}\n• 颜色：${product.colors.join("、")}\n• 适用：${product.scenarios.join("、")}\n• 库存：${product.stock > 0 ? `${product.stock} 件，${product.leadTime}` : product.leadTime}\n• 参考报价：${product.priceRange}（起订量 ${product.moq} 件）\n• 售后：${product.warranty}\n\n我同时附上了产品图、参数表与相关证明资料，您可以直接查看。如需按现场尺寸进一步选型，我也可以继续协助。`;
}
