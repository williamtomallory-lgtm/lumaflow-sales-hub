// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../server/data-repository", () => ({ getDataSnapshot: vi.fn(async () => ({ source: 'json', products: [], knowledgeEntries: [] })) }));
vi.mock("../knowledge/store", () => ({ getKnowledgeTextById: vi.fn(async () => '合同付款条件：验收完成后30天付款。') }));
vi.mock("./knowledge-retrieval", () => ({ searchConfirmedKnowledge: vi.fn(async () => [{ id: 'confirmed', citation: '人工确认合同原文' }]) }));
vi.mock("./tianzhao-knowledge", () => ({ getTianzhaoProduct: vi.fn(), searchTianzhaoProducts: vi.fn(() => ({ total: 0, products: [] })) }));
vi.mock("../server/web-search", () => ({ searchWeb: vi.fn(async () => [{ title: '航班官方页面', url: 'https://example.com/flight', content: '暂无票价' }]) }));
import { collectAnswerEvidence } from './answer-evidence';
import { getKnowledgeTextById } from '../knowledge/store';
import { getDataSnapshot } from '../server/data-repository';
import { searchConfirmedKnowledge } from './knowledge-retrieval';
import { searchWeb } from '../server/web-search';
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());
describe('mandatory evidence retrieval', () => {
  it('reads matched source text, instead of answering from just the search summary', async () => {
    const result=await collectAnswerEvidence({ text:'合同的付款条件',source:'local',documentIds:[] });
    expect(getKnowledgeTextById).toHaveBeenCalledWith('confirmed');
    expect(result?.instructions).toContain('验收完成后30天付款');
    expect(searchWeb).not.toHaveBeenCalled();
  });
  it('keeps selected documents within their exact authorized scope', async () => {
    await collectAnswerEvidence({ text:'汇总付款条件',source:'local',documentIds:['authorized'] });
    expect(getKnowledgeTextById).toHaveBeenCalledExactlyOnceWith('authorized');
    expect(getDataSnapshot).not.toHaveBeenCalled();expect(searchConfirmedKnowledge).not.toHaveBeenCalled();
  });
  it('never turns missing live inventory into a promised shipment', async () => {
    const result=await collectAnswerEvidence({ text:'18W黑色轨道灯今天能发吗，库存多少',source:'local',documentIds:[] });
    expect(result?.fallback).toContain('不能确认今天能发货');
    expect(result?.calls[0].output).toMatchObject({ queries:['18W黑色轨道灯今天能发吗，库存多少','轨道灯'],formalSource:'json' });
  });
  it('uses internet without reading private files for an unrelated flight query', async () => {
    const result=await collectAnswerEvidence({ text:'今天去北京的机票',source:'web',documentIds:[] });
    expect(searchWeb).toHaveBeenCalledExactlyOnceWith('今天去北京的机票');
    expect(getKnowledgeTextById).not.toHaveBeenCalled();expect(getDataSnapshot).not.toHaveBeenCalled();
    expect(result?.calls[0].toolName).toBe('webSearch');
  });
  it('keeps mixed private evidence out of automatic internet requests', async () => {
    await collectAnswerEvidence({ text:'合同付款金额和今天汇率',source:'mixed',documentIds:['authorized'] });
    expect(searchWeb).not.toHaveBeenCalled();expect(getKnowledgeTextById).toHaveBeenCalledWith('authorized');
  });
});
