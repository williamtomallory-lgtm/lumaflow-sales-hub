import { describe, expect, it } from "vitest";
import { isCurrentWeatherLookup, isSimpleBrowserLookup } from "./browser-intent";

describe("simple browser lookup routing", () => {
  it("routes direct current weather questions without treating weather coding as a lookup", () => {
    expect(isCurrentWeatherLookup("帮我查查我这里现在的天气")).toBe(true);
    expect(isCurrentWeatherLookup("今天Toronto天气怎么样")).toBe(true);
    expect(isCurrentWeatherLookup("写一个天气网页并保存文件")).toBe(false);
    expect(isCurrentWeatherLookup("分析去年天气历史数据")).toBe(false);
  });
  it("uses the bounded path for a read-only browser search", () => {
    expect(isSimpleBrowserLookup("现在打开我的 Chrome 浏览器搜索 Mississauga 今天的天气，只根据页面回答")).toBe(true);
  });

  it("keeps interactive and unrelated tasks on the full Work path", () => {
    expect(isSimpleBrowserLookup("打开网页，登录后填写并提交表单")).toBe(false);
    expect(isSimpleBrowserLookup("搜索产品库存并修改报价")).toBe(false);
    expect(isSimpleBrowserLookup("写一个关于天气的网页并保存文件")).toBe(false);
  });
});
