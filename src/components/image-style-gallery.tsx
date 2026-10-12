"use client";

import { ImagePlus, Plus } from "lucide-react";
import styles from "./image-style-gallery.module.css";

export type ImageStyleGalleryProps = {
  /** Opens the composer file picker so the user can provide a source image. */
  onUpload: () => void;
  /** Puts a complete, ready-to-run image prompt into the active composer. */
  onSelect: (prompt: string) => void;
  disabled?: boolean;
  category?: "hot" | "templates";
  showHeading?: boolean;
};

type StylePreset = {
  id: string;
  label: string;
  prompt: string;
  /** Crop coordinates relative to a 230 × 289 card in the supplied sprites. */
  x: string;
  y: string;
  sprite?: string;
};

const spriteUrl = "/image-style-presets/popular-style-sprite.png";
const extendedSpriteUrl = "/image-style-presets/extended-style-sprite.png";

const presets: StylePreset[] = [
  {
    id: "disco",
    label: "迪斯科风",
    prompt: "生成一张迪斯科风格的图片：保留主体的关键外形和身份特征，使用镜面亮片、银色金属反光、舞台聚光灯和彩色霓虹背景，画面充满闪耀颗粒与复古舞厅氛围，主体清晰、构图完整、细节丰富。若已上传图片，请以原图主体为基础进行风格化编辑。",
    x: "131.30%",
    y: "36.99%",
  },
  {
    id: "desk",
    label: "优化桌面布置",
    prompt: "生成一张优化后的桌面布置图：保留原有物品的主要功能和识别特征，整理成整洁、舒适、真实可用的现代工作空间，加入自然光、木质桌面、显示器、绿植和合理收纳，采用室内设计摄影质感，比例协调、光影自然。若已上传图片，请对原图场景进行桌面空间优化。",
    x: "237.00%",
    y: "36.99%",
  },
  {
    id: "faraway",
    label: "远方情结",
    prompt: "生成一张带有远方情结的旅行叙事图片：保留主体的核心形象，将画面设计成温暖、略带怀旧的旅行记忆拼贴，包含远景风光、手写便签、照片边角和自然材质，使用柔和夕阳与胶片颗粒，画面有故事感、层次清楚且文字保持可读。若已上传图片，请以原图主体融入这组旅行记忆。",
    x: "342.60%",
    y: "36.99%",
  },
  {
    id: "doodle",
    label: "涂鸦",
    prompt: "把主体变成一张轻松可爱的手绘涂鸦插画：保留人物或物体的主要轮廓与动作，使用粗细不一的黑色线条、随手涂色、纸张纹理和明亮的绿色与粉色，构图简洁、表情生动、像儿童画与街头涂鸦的结合。若已上传图片，请根据原图主体完成涂鸦风格改绘。",
    x: "25.65%",
    y: "141.18%",
  },
  {
    id: "animal-infographic",
    label: "动物信息图",
    prompt: "生成一张专业又易懂的动物信息图：以主体动物为视觉中心，补充清晰的侧面轮廓、栖息地、食物链和关键知识点，用深蓝色海洋或自然背景、信息卡片、细线标注和简洁图表组织内容，版式整齐、插画写实、中文标题清晰可读。若已上传图片，请以原图中的动物为信息图主体。",
    x: "131.30%",
    y: "141.18%",
  },
  {
    id: "chibi-sticker",
    label: "Chibi贴纸",
    prompt: "把主体绘制成一张可爱的 Chibi 贴纸：头大身小、圆润线条、明亮粉色背景，加入夸张但自然的表情、爱心和小装饰，使用干净的卡通上色、柔和高光与白色贴纸边缘，主体完整居中、适合直接做聊天贴纸。若已上传图片，请保留原图主体的发型、服装或主要特征。",
    x: "237.00%",
    y: "141.18%",
  },
  {
    id: "beauty-guide",
    label: "美妆指南",
    prompt: "生成一张清晰的美妆指南图：以主体人物为中心，展示自然干净的妆容，并在顶部排列眉形、眼妆、底妆和唇妆等局部示意，采用柔和棚拍光、真实肤质和高级美容杂志排版，局部细节清楚，文字与标签简洁可读。若已上传图片，请以原图人物为编辑对象并保持面部身份特征。",
    x: "342.60%",
    y: "141.18%",
  },
  {
    id: "section-diagram",
    label: "剖面图",
    prompt: "生成一张精确的产品剖面图：保留主体的外观比例和结构关系，使用干净的蓝灰色工程插画背景，展示内部层次、材料、连接件与剖切面，加入细线引出标注和清晰标题，技术绘图风格、边缘锐利、信息层级明确。若已上传图片，请以原图对象为基础制作剖面图。",
    x: "25.65%",
    y: "245.67%",
  },
  {
    id: "app-design",
    label: "应用设计",
    prompt: "生成一张现代应用设计展示图：把主体内容整理到三张并排的移动端界面中，使用清楚的导航、卡片、按钮和留白，配色明快但协调，像完成度高的产品设计提案，保证界面层级、对齐和中文文字清晰可读。若已上传图片，请把原图主体或内容自然转化为应用界面素材。",
    x: "131.30%",
    y: "245.67%",
  },
  {
    id: "anime-comic",
    label: "动漫漫画",
    prompt: "把主体创作为黑白动漫漫画分镜：保留人物或动物的动作关系，使用清晰的墨线、网点阴影、漫画格、对白气泡和有节奏的表情变化，画面像一页完成度高的连载漫画，构图易读、情绪鲜明、细节稳定。若已上传图片，请围绕原图主体编排漫画分镜。",
    x: "237.00%",
    y: "245.67%",
  },
  {
    id: "mini-me",
    label: "迷你分身",
    prompt: "生成一张有趣的迷你分身照片：保留主体人物的面部特征、发型和服装，把多个微缩分身安排在同一真实场景中进行互动，使用自然摄影光线、细腻材质和轻松幽默的构图，比例关系可信、画面清晰、主体不变形。若已上传图片，请以原图人物作为所有迷你分身的来源。",
    x: "342.60%",
    y: "245.67%",
  },
  { id: "bobblehead", label: "你的摇头娃娃", prompt: "把主体制作成一款真实的摇头娃娃收藏公仔：保留脸部身份、发型和服装特征，头部夸张放大，身体小巧，颈部连接弹簧，采用手绘树脂材质和精致底座。以真实街景为背景，浅景深产品摄影，完整展示公仔。若已上传照片，请依据原图人物制作。", x: "127.83%", y: "12.80%", sprite: extendedSpriteUrl },
  { id: "photo-enhance", label: "增强照片", prompt: "修复并增强上传的照片：保持原有人物身份、表情、姿势、构图和真实场景，改善清晰度、曝光、色彩与对比度，减少噪点、划痕和模糊，保留自然肤质和原有年代感，不随意增添或删除对象。若未上传照片，请生成一张温暖自然的家庭庆生纪实照片，作为增强照片质感的示例。", x: "22.17%", y: "116.61%", sprite: extendedSpriteUrl },
  { id: "night-flash", label: "夜拍闪光", prompt: "创作一张夜间直闪摄影图片：主体近距离清晰突出，使用相机直射闪光灯，呈现明亮细节、自然硬阴影，背景保留暗夜街景和远处点状灯光，带轻微胶片颗粒与抓拍感，构图活泼真实。若已上传图片，保持原图主体身份、外形和姿态，将场景转为夜拍闪光效果。", x: "233.48%", y: "116.61%", sprite: extendedSpriteUrl },
  { id: "blueprint", label: "蓝图海报", prompt: "把主体制作成蓝图风格工程海报：使用深蓝网格纸、精细白色线稿、正视图和局部剖面，配以清楚的尺寸线、编号和中文标注，保持原图外形与结构比例，排版精确且留白合理。没有实际测量数据时，将尺寸明确标为示意，避免虚构真实规格。", x: "339.13%", y: "116.61%", sprite: extendedSpriteUrl },
  { id: "color-analysis", label: "色彩分析", prompt: "制作一张人物穿搭色彩对照图：保持同一人物的面部身份、发型、姿势和光线，将服装与背景依次替换为冷蓝、柔紫、米白、暖棕、橄榄绿和深蓝，排列成整齐的六宫格，呈现真实布料、自然肤色与统一构图，用简洁中文标识颜色，便于比较搭配效果。若已上传照片，请以原图人物为主体。", x: "22.17%", y: "220.76%", sprite: extendedSpriteUrl },
  { id: "comic", label: "漫画", prompt: "将主体改绘为色彩鲜明的漫画插画：保留主要轮廓、动作和可识别特征，采用黑色粗轮廓、明亮纯色、夸张表情与简洁背景，加入少量对白气泡或拟声词，画面有幽默感，构图完整、文字清楚。若已上传图片，围绕原图主体进行漫画化创作。", x: "127.83%", y: "220.76%", sprite: extendedSpriteUrl },
  { id: "fantasy-newspaper", label: "奇幻报纸", prompt: "将主体设计成一张奇幻世界报纸头版：保留主体身份特征，以复古黑白肖像或场景作为主图，搭配有故事感的中文大标题、清楚的分栏、装饰衬线字、旧纸纹理与细边框，营造魔法世界新闻氛围。所有报道应为明显的虚构故事，排版完整、标题可读。", x: "339.13%", y: "220.76%", sprite: extendedSpriteUrl },
  { id: "film-strip", label: "胶片条", prompt: "创作一组胶片条形式的电影画面：保留主体身份、服装和环境的一致性，用三幅相连镜头展示一个连贯动作或小故事，加入胶片边框、细颗粒、柔和高光、略带褪色的色调与自然镜头感，画面细节真实，分镜有节奏。若已上传图片，请以原图场景为第一镜延展。", x: "22.17%", y: "324.91%", sprite: extendedSpriteUrl },
  { id: "macro-wallpaper", label: "超写实壁纸", prompt: "生成一张超写实微距壁纸：以主体的纹理、形态和材质作为视觉中心，展示细腻真实的表面结构、自然露珠或柔和高光，使用浅景深与简洁背景，色彩自然、构图有呼吸感，适合高清桌面壁纸。若已上传图片，请依据原图主体制作微距风格画面。", x: "127.83%", y: "324.91%", sprite: extendedSpriteUrl },
  { id: "palm-map", label: "看手相", prompt: "把手部照片制作成手掌线条示意图：保留原图手掌比例和真实纹理，以细线沿可见掌纹标出位置，使用干净米色背景、简洁中文标签与清晰的信息图布局。标注说明仅为娱乐性的传统掌纹示意，不推断真实命运、健康、寿命或个人特征。若未上传手部照片，请生成一张通用手掌示意图。", x: "233.48%", y: "324.91%", sprite: extendedSpriteUrl },
];

export function ImageStyleGallery({ onUpload, onSelect, disabled = false, category = "hot", showHeading = true }: ImageStyleGalleryProps) {
  const visiblePresets = category === "templates"
    ? presets.filter((preset) => ["desk", "animal-infographic", "beauty-guide", "section-diagram", "app-design", "anime-comic", "photo-enhance", "blueprint", "color-analysis", "fantasy-newspaper", "film-strip", "palm-map"].includes(preset.id))
    : presets;
  return <section className={styles.root} aria-label="热门图片风格">
    {showHeading && <div className={styles.heading}>
      <span className={styles.hotTag}>热门</span>
      <span className={styles.hint}>选择风格，填入图片提示词</span>
    </div>}
    <div className={styles.grid}>
      <button type="button" className={`${styles.card} ${styles.uploadCard}`} onClick={onUpload} disabled={disabled} aria-label="上传照片">
        <span className={styles.uploadVisual}><Plus size={29} strokeWidth={1.5} aria-hidden="true" /></span>
        <span className={styles.cardLabel}>上传照片</span>
        <ImagePlus className={styles.uploadMark} size={15} aria-hidden="true" />
      </button>
      {visiblePresets.map((preset) => <button key={preset.id} type="button" className={styles.card} onClick={() => onSelect(preset.prompt)} disabled={disabled} aria-label={`使用${preset.label}风格`}>
        <span className={styles.visual} style={{ "--sprite-x": preset.x, "--sprite-y": preset.y, "--sprite-url": `url(${preset.sprite || spriteUrl})`, "--sprite-width": preset.sprite ? "515.65%" : "466.52%", "--sprite-height": preset.sprite ? "426.30%" : "345.33%" } as React.CSSProperties} aria-hidden="true" />
        <span className={styles.cardLabel}>{preset.label}</span>
      </button>)}
    </div>
  </section>;
}
