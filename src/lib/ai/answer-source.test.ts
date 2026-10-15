// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { chooseAnswerSource } from "./answer-source";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("evidence source routing", () => {
  it.each([['18W 黑色轨道灯，服装店用，今天能发吗？','local'],['读取知识库里的合同付款条件','local'],['今天去北京最便宜的机票','web'],['查询加拿大今日新闻','web'],['查询微软Edge最新稳定版官方发布说明','web'],['计算17*23','direct'],['写一个Python脚本整理灯具资料','direct'],['我们库存有货吗，另查北京天气','mixed'],['网上查灯具行业最新消息','web']] as const)("routes %s to %s", async (text, source) => { expect(await chooseAnswerSource({ text })).toBe(source); });
  it("keeps selected and isolated project documents local", async () => {
    expect(await chooseAnswerSource({ text: '总结内容', selectedDocuments: true })).toBe('local');
    expect(await chooseAnswerSource({ text: '网上找合同模板', projectOnly: true })).toBe('local');
  });
  it("never asks a cloud judge to relax an internal inventory requirement", async () => {
    vi.stubEnv('TYPESAFE_WORK_ROUTING','true');vi.stubEnv('TYPESAFE_API_KEY','test');
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    expect(await chooseAnswerSource({ text:'公司现货，今天能发吗' })).toBe('local');
    expect(fetch).not.toHaveBeenCalled();
  });
});
