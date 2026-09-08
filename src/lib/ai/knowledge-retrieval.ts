import "server-only";
import { listKnowledgeRecords } from "../knowledge/store";

/** Automatically uploaded/classified files are not silently published to every Agent. */
export async function searchConfirmedKnowledge(query: string) {
  const terms = [...new Set(query.toLowerCase().split(/[\s，。？！、/\\\-_:：；;（）()]+/).filter((value) => value.length >= 2))];
  const records = await listKnowledgeRecords();
  return records.filter((record) => record.classificationSource === "manual" && record.classificationStatus === "classified" && record.extractedText)
    .map((record) => {
      const text = `${record.title} ${record.tags.join(" ")} ${record.extractedText}`.toLowerCase();
      return { record, score: terms.filter((term) => text.includes(term)).length };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ record, score }) => {
      const body = record.extractedText ?? "";
      const match = terms.map((term) => body.toLowerCase().indexOf(term)).find((index) => index >= 0) ?? 0;
      return {
        id: record.id, title: record.title, category: record.category ?? "文档解析", excerpt: body.slice(Math.max(0, match - 200), Math.max(0, match - 200) + 1000),
        version: record.version, updatedAt: record.updatedAt, score,
        citation: `${record.originalName} · 本地文件 · 人工确认分类 · 正文节选`,
      };
    });
}
