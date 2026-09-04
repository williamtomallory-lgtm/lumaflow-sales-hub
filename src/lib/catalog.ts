import catalogSeed from "../data/catalog.json";

export type Asset = {
  id: string;
  name: string;
  type: "图片" | "尺寸图" | "参数表" | "PDF" | "证书" | "案例" | "视频" | "说明书";
  size: string;
  version?: string;
  updatedAt?: string;
};

export type Product = {
  id: string;
  name: string;
  model: string;
  sku: string;
  category: string;
  family: string;
  status: "在售" | "低库存" | "预售";
  power: string;
  lumens: string;
  colorTemp: string;
  material: string;
  dimensions: string;
  colors: string[];
  scenarios: string[];
  supplier: string;
  cost: number;
  priceRange: string;
  moq: number;
  stock: number;
  leadTime: string;
  warranty: string;
  description: string;
  gradient: string;
  accent: string;
  assets: Asset[];
};

export type KnowledgeArticle = {
  id: string;
  category: string;
  title: string;
  reads: number;
};

export const products = catalogSeed.products as Product[];

export const allAssets = products.flatMap((product) =>
  product.assets.map((asset) => ({ ...asset, productId: product.id, productName: product.name })),
);

export const knowledgeArticles = catalogSeed.knowledgeArticles as KnowledgeArticle[];
