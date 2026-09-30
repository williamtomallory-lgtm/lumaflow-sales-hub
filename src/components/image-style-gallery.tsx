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
  /** Source crop coordinates in the supplied 1073 × 1029 sprite. */
  x: string;
  y: string;
};

const spriteUrl = "/image-style-presets/popular-style-sprite.png";

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
];

export function ImageStyleGallery({ onUpload, onSelect, disabled = false, category = "hot", showHeading = true }: ImageStyleGalleryProps) {
  const visiblePresets = category === "templates"
    ? presets.filter((preset) => ["desk", "animal-infographic", "beauty-guide", "section-diagram", "app-design", "anime-comic"].includes(preset.id))
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
        <span className={styles.visual} style={{ "--sprite-x": preset.x, "--sprite-y": preset.y, "--sprite-url": `url(${spriteUrl})` } as React.CSSProperties} aria-hidden="true" />
        <span className={styles.cardLabel}>{preset.label}</span>
      </button>)}
    </div>
  </section>;
}
