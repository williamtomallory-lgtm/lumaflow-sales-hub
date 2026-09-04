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

export const products: Product[] = [
  {
    id: "arc-t18",
    name: "Arc 轨道射灯",
    model: "ARC T18",
    sku: "LT-ARC-T18-BK",
    category: "轨道灯",
    family: "商业照明",
    status: "在售",
    power: "18W",
    lumens: "1,620 lm",
    colorTemp: "3000K / 4000K",
    material: "压铸铝",
    dimensions: "Ø62 × H138 mm",
    colors: ["曜石黑", "珍珠白"],
    scenarios: ["服装店", "展厅", "画廊"],
    supplier: "朗曜光电",
    cost: 128,
    priceRange: "¥239–289",
    moq: 10,
    stock: 126,
    leadTime: "现货 24 小时内发",
    warranty: "3 年质保",
    description: "高显色窄光束轨道射灯，适合需要重点陈列与真实还原色彩的商业空间。",
    gradient: "linear-gradient(145deg, #1f2937 0%, #111827 55%, #c9a96e 56%, #efddbd 100%)",
    accent: "#c89b52",
    assets: [
      { id: "arc-image", name: "ARC T18 场景图（黑色）", type: "图片", size: "2.4 MB", version: "v3.1", updatedAt: "今天" },
      { id: "arc-spec", name: "ARC T18 技术参数表", type: "参数表", size: "486 KB", version: "v3.2", updatedAt: "今天" },
      { id: "arc-size", name: "ARC T18 安装尺寸图", type: "尺寸图", size: "820 KB", version: "v2.0", updatedAt: "9 月 1 日" },
      { id: "arc-cert", name: "CCC & CE 证书", type: "证书", size: "1.1 MB", version: "v2.1", updatedAt: "8 月 28 日" },
      { id: "arc-case", name: "NOVA 服装店照明案例", type: "案例", size: "3.8 MB", version: "v1.0", updatedAt: "8 月 22 日" },
      { id: "arc-video", name: "ARC T18 调焦演示", type: "视频", size: "18.2 MB", version: "v1.0", updatedAt: "8 月 20 日" },
    ],
  },
  {
    id: "halo-p36",
    name: "Halo 环形吊灯",
    model: "HALO P36",
    sku: "LP-HALO-P36-GD",
    category: "吊灯",
    family: "装饰照明",
    status: "在售",
    power: "36W",
    lumens: "2,880 lm",
    colorTemp: "2700K–4000K",
    material: "铝合金 + 亚克力",
    dimensions: "Ø600 × H80 mm / 吊线 1.5 m",
    colors: ["香槟金", "哑光黑"],
    scenarios: ["餐厅", "酒店", "办公区"],
    supplier: "璟华灯饰",
    cost: 426,
    priceRange: "¥759–899",
    moq: 5,
    stock: 42,
    leadTime: "现货 48 小时内发",
    warranty: "3 年质保",
    description: "轻量化环形吊灯，支持无级调光调色，适合挑高公共空间与现代餐饮场景。",
    gradient: "radial-gradient(circle at 50% 44%, transparent 0 21%, #e8c989 22% 28%, transparent 29%), linear-gradient(155deg, #f2eadb, #cab994)",
    accent: "#b9853b",
    assets: [
      { id: "halo-image", name: "HALO P36 空间应用图", type: "图片", size: "3.1 MB" },
      { id: "halo-spec", name: "HALO P36 规格书", type: "参数表", size: "572 KB" },
      { id: "halo-pdf", name: "HALO 系列产品册", type: "PDF", size: "5.6 MB" },
      { id: "halo-manual", name: "HALO P36 安装说明书", type: "说明书", size: "1.4 MB", version: "v1.3", updatedAt: "8 月 24 日" },
    ],
  },
  {
    id: "line-l24",
    name: "Line 磁吸线条灯",
    model: "LINE L24",
    sku: "ML-LINE-L24-BK",
    category: "磁吸灯",
    family: "无主灯",
    status: "在售",
    power: "24W",
    lumens: "2,160 lm",
    colorTemp: "3000K / 4000K",
    material: "6063 铝型材",
    dimensions: "L600 × W22 × H45 mm",
    colors: ["曜石黑"],
    scenarios: ["办公室", "住宅", "精品店"],
    supplier: "朗曜光电",
    cost: 166,
    priceRange: "¥299–349",
    moq: 10,
    stock: 89,
    leadTime: "现货 24 小时内发",
    warranty: "5 年质保",
    description: "低眩光磁吸线条灯，模块化安装，适合连续基础照明和极简空间。",
    gradient: "linear-gradient(165deg, #dedbd2 0 44%, #25272a 45% 52%, #f3d17d 53% 58%, #45484c 59% 100%)",
    accent: "#e0b448",
    assets: [
      { id: "line-image", name: "LINE L24 安装效果图", type: "图片", size: "2.8 MB" },
      { id: "line-spec", name: "LINE L24 参数表", type: "参数表", size: "441 KB" },
      { id: "line-cert", name: "CE / RoHS 证书", type: "证书", size: "968 KB" },
      { id: "line-video", name: "LINE 磁吸系统安装视频", type: "视频", size: "24.6 MB", version: "v2.0", updatedAt: "8 月 30 日" },
    ],
  },
  {
    id: "veil-w12",
    name: "Veil 洗墙灯",
    model: "VEIL W12",
    sku: "WL-VEIL-W12-WH",
    category: "洗墙灯",
    family: "商业照明",
    status: "低库存",
    power: "12W",
    lumens: "960 lm",
    colorTemp: "3000K",
    material: "压铸铝 + 光学玻璃",
    dimensions: "L168 × W45 × H72 mm",
    colors: ["珍珠白", "曜石黑"],
    scenarios: ["博物馆", "画廊", "走廊"],
    supplier: "光域科技",
    cost: 198,
    priceRange: "¥369–429",
    moq: 6,
    stock: 8,
    leadTime: "现货售完后 12 天",
    warranty: "3 年质保",
    description: "非对称配光洗墙灯，墙面亮度均匀，适用于展陈与建筑立面细节照明。",
    gradient: "linear-gradient(110deg, #d8d5cc 0 46%, #fffdf4 47% 62%, #a9a69f 63% 100%)",
    accent: "#83765d",
    assets: [
      { id: "veil-image", name: "VEIL W12 洗墙实拍", type: "图片", size: "2.1 MB" },
      { id: "veil-spec", name: "VEIL W12 配光参数", type: "参数表", size: "620 KB" },
    ],
  },
  {
    id: "moss-o8",
    name: "Moss 户外壁灯",
    model: "MOSS O8",
    sku: "OW-MOSS-O8-GR",
    category: "户外灯",
    family: "户外照明",
    status: "预售",
    power: "8W",
    lumens: "640 lm",
    colorTemp: "3000K",
    material: "铝合金 + 钢化玻璃",
    dimensions: "L180 × W92 × H55 mm",
    colors: ["苔藓绿", "深空灰"],
    scenarios: ["民宿", "庭院", "露台"],
    supplier: "北辰户外",
    cost: 151,
    priceRange: "¥289–329",
    moq: 12,
    stock: 0,
    leadTime: "预计 9 月 18 日到仓",
    warranty: "3 年质保 / IP65",
    description: "双向出光 IP65 户外壁灯，以克制的轮廓光塑造入口、庭院与露台氛围。",
    gradient: "linear-gradient(155deg, #9fac91 0 38%, #53604d 39% 69%, #d9c29c 70% 100%)",
    accent: "#69785e",
    assets: [
      { id: "moss-image", name: "MOSS O8 户外场景图", type: "图片", size: "3.4 MB" },
      { id: "moss-spec", name: "MOSS O8 防护参数", type: "参数表", size: "530 KB" },
      { id: "moss-cert", name: "IP65 检测报告", type: "证书", size: "1.4 MB" },
    ],
  },
  {
    id: "beam-s30",
    name: "Beam 深防眩筒灯",
    model: "BEAM S30",
    sku: "DL-BEAM-S30-WH",
    category: "筒灯",
    family: "基础照明",
    status: "在售",
    power: "30W",
    lumens: "2,700 lm",
    colorTemp: "3000K / 4000K / 5000K",
    material: "压铸铝 + PC",
    dimensions: "Ø145 × H118 mm / 开孔 Ø125 mm",
    colors: ["珍珠白"],
    scenarios: ["商场", "办公室", "酒店"],
    supplier: "光域科技",
    cost: 96,
    priceRange: "¥169–219",
    moq: 20,
    stock: 214,
    leadTime: "现货 24 小时内发",
    warranty: "3 年质保",
    description: "UGR<19 深防眩筒灯，兼顾高光效与视觉舒适度，适合大面积基础照明。",
    gradient: "radial-gradient(circle at 50% 48%, #4b4c4d 0 15%, #f5f1e8 16% 29%, #c7c4bc 30% 36%, transparent 37%), linear-gradient(145deg, #e3dfd7, #a7a49e)",
    accent: "#6f7b83",
    assets: [
      { id: "beam-image", name: "BEAM S30 产品图", type: "图片", size: "1.9 MB" },
      { id: "beam-spec", name: "BEAM S30 参数表", type: "参数表", size: "398 KB" },
      { id: "beam-pdf", name: "BEAM 安装说明", type: "说明书", size: "1.2 MB", version: "v1.6", updatedAt: "8 月 18 日" },
    ],
  },
];

export const allAssets = products.flatMap((product) =>
  product.assets.map((asset) => ({ ...asset, productId: product.id, productName: product.name })),
);

export const knowledgeArticles = [
  { id: "k1", category: "销售话术", title: "客户在意价格时，如何说明高显色的价值？", reads: 128 },
  { id: "k2", category: "产品知识", title: "轨道灯光束角：24° 与 36° 怎么选", reads: 96 },
  { id: "k3", category: "安装指南", title: "磁吸系统下单前的 5 项确认", reads: 84 },
  { id: "k4", category: "政策", title: "样品、退换与质保处理标准", reads: 71 },
];
