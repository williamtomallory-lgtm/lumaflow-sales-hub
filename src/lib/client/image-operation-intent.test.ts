import { describe, expect, it } from "vitest";
import { resolveImageOperationIntent } from "./image-operation-intent";

const image = { type: "file", mediaType: "image/png", filename: "product.png", url: "data:image/png;base64,AA==" } as const;

describe("resolveImageOperationIntent", () => {
  it("routes an uploaded image without an edit request to analysis", () => {
    expect(resolveImageOperationIntent({ prompt: "请看看这张图片", images: [image] })).toEqual({ operation: "analyze", explicit: true });
  });

  it("routes an uploaded image with an explicit edit request to edit", () => {
    expect(resolveImageOperationIntent({ prompt: "把背景换成白色", images: [image] })).toEqual({ operation: "edit", explicit: true });
  });

  it("routes an explicit generation request without an image to generate", () => {
    expect(resolveImageOperationIntent({ prompt: "生成一张暖色客厅效果图" })).toEqual({ operation: "generate", explicit: true });
  });

  it("lets the 生图 mode force the image endpoint", () => {
    expect(resolveImageOperationIntent({ prompt: "做一个产品海报", enabled: true })).toEqual({ operation: "generate", explicit: true });
    expect(resolveImageOperationIntent({ prompt: "请先看看细节", images: [image], enabled: true })).toEqual({ operation: "analyze", explicit: true });
  });

  it("keeps an ordinary text request on the text endpoint", () => {
    expect(resolveImageOperationIntent({ prompt: "查询这个产品的库存" })).toBeNull();
  });
});
