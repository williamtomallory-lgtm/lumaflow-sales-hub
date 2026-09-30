import type { FileUIPart } from "ai";

export type ImageOperation = "generate" | "edit" | "analyze";

export type ImageOperationIntent = {
  operation: ImageOperation;
  /** True when the prompt itself explicitly asks for an image operation. */
  explicit: boolean;
};

export type ImageOperationIntentInput = {
  prompt: string;
  images?: readonly FileUIPart[];
  /** The user selected the 生图 mode in the add menu. */
  enabled?: boolean;
};

// Keep routing deterministic. This is a small UI convenience classifier; it
// does not inspect image pixels or send private attachments to a remote model.
const generatePattern = /(?:生图|图片生成|生成(?:一张|一个)?(?:[^\s，。,.]{0,20})?(?:图片|图像|海报|封面|效果图|插画|照片|头像)|画(?:一张|个)?(?:[^\s，。,.]{0,12})?(?:图片|图像|海报|封面|效果图|插画)|绘制(?:[^\s，。,.]{0,12})?(?:图片|图像|海报|封面|效果图)|创作(?:[^\s，。,.]{0,12})?(?:图片|图像|海报|封面|效果图)|制作(?:一张|个)?(?:图片|图像|海报|封面|效果图)|设计(?:一张|个)?(?:图片|图像|海报|封面|效果图)|做(?:一张|个)?(?:[^\s，。,.]{0,8})?(?:图片|图像|海报|封面|效果图)|出图|generate\s+(?:an?\s+)?(?:image|picture|poster|illustration)|create\s+(?:an?\s+)?(?:image|picture|poster|illustration)|draw\s+(?:an?\s+)?(?:image|picture|poster|illustration)|render\s+(?:an?\s+)?(?:image|picture|poster|illustration))/iu;
const editPattern = /(?:编辑|修改|修图|改图|重绘|重制|变换|替换|移除|删除|添加|加上|换成|改成|调整|美化|抠图|扩图|放大|缩小|edit|retouch|inpaint|remove|replace|add|change|transform|upscale)/iu;
const analyzePattern = /(?:分析|识别|描述|查看|看看|解读|提取文字|ocr|analy[sz]e|describe|inspect|read\s+(?:the\s+)?image)/iu;
const imageNounPattern = /(?:图片|图像|照片|海报|封面|效果图|插画|头像|image|picture|poster|illustration|photo)/iu;

/**
 * Resolve the local image endpoint operation from explicit user wording,
 * attachments, and the optional 生图 toggle.
 *
 * The rules intentionally keep the user's words in charge:
 * - an explicit generate/edit request with an image is an edit;
 * - an explicit generate/edit request without an image is a generate;
 * - an image by itself is an analyze request;
 * - selecting 生图 forces the image endpoint, while a plain prompt with an
 *   attached image still defaults to analyze until the user asks to change it.
 */
export function resolveImageOperationIntent({ prompt, images = [], enabled = false }: ImageOperationIntentInput): ImageOperationIntent | null {
  const text = prompt.trim();
  const hasImages = images.length > 0;
  const explicitGenerate = generatePattern.test(text);
  const explicitEdit = editPattern.test(text) && (hasImages || imageNounPattern.test(text));
  const explicitAnalyze = analyzePattern.test(text);

  if (enabled) {
    if (hasImages) {
      if (explicitGenerate || explicitEdit) return { operation: "edit", explicit: true };
      return { operation: "analyze", explicit: explicitAnalyze };
    }
    return { operation: "generate", explicit: explicitGenerate || explicitEdit };
  }

  if (hasImages) {
    if (explicitGenerate || explicitEdit) return { operation: "edit", explicit: true };
    return { operation: "analyze", explicit: explicitAnalyze };
  }
  if (explicitGenerate || explicitEdit) return { operation: "generate", explicit: true };
  return null;
}

export function isImageOperationPrompt(prompt: string): boolean {
  return resolveImageOperationIntent({ prompt }) !== null;
}
