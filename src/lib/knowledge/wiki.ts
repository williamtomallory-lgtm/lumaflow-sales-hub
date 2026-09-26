import "server-only";

import { del, get, put } from "@vercel/blob";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getKnowledgeOwner } from "@/lib/server/knowledge-scope";
import { knowledgeCategorySchema, type StoredKnowledgeRecord } from "./contracts";
import { listKnowledgeRecords } from "./store";

export type WikiPageKind = "index" | "topic" | "source" | "log" | "schema" | "lint";
export type WikiPage = { path: string; title: string; kind: WikiPageKind; markdown: string };
export type WikiSearchMatch = {
  path: string;
  title: string;
  kind: WikiPageKind;
  excerpt: string;
  score: number;
};

const wikiDirectory = path.join(process.cwd(), ".local-data", "knowledge", "wiki");
const WIKI_SOURCE_EXCERPT_CHARS = 1_800;

function safeInline(text: string) { return text.replace(/[\r\n\[\]<>`()]/g, " ").trim(); }
function cloudPath(page: string) { return `lumaflow-knowledge/v1/${getKnowledgeOwner()}/wiki/${page}`; }

function markdownText(markdown: string) {
  return markdown
    .replace(/!?(\[([^\]]+)\])\([^)]*\)/g, "$2")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*_`>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownPageTarget(fromPath: string, destination: string) {
  const cleanDestination = destination.split(/[?#]/, 1)[0]?.trim() || "";
  if (!cleanDestination || cleanDestination.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(cleanDestination)) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), cleanDestination));
  if (target === ".." || target.startsWith("../") || !target.endsWith(".md")) return null;
  return target;
}

function markdownPageReferences(page: WikiPage) {
  const references: string[] = [];
  for (const match of page.markdown.matchAll(/\]\(([^)]+)\)/g)) {
    const target = markdownPageTarget(page.path, match[1]);
    if (target) references.push(target);
  }
  return references;
}

function buildMaintenanceMarkdown(records: StoredKnowledgeRecord[], basePages: WikiPage[]) {
  const knownPaths = new Set([...basePages.map((page) => page.path), "lint.md"]);
  const referenced = new Map<string, number>();
  const brokenLinks: string[] = [];
  for (const page of basePages) {
    for (const target of markdownPageReferences(page)) {
      if (!knownPaths.has(target)) brokenLinks.push(`${page.path} → ${target}`);
      referenced.set(target, (referenced.get(target) ?? 0) + 1);
    }
  }

  const orphanPages = basePages
    .filter((page) => page.path !== "index.md" && !referenced.has(page.path))
    .map((page) => page.path);
  const names = new Map<string, StoredKnowledgeRecord[]>();
  for (const record of records) names.set(record.originalName, [...(names.get(record.originalName) ?? []), record]);
  const nameConflicts = [...names.entries()]
    .map(([name, entries]) => ({ name, entries }))
    .filter(({ entries }) => new Set(entries.map((entry) => entry.sha256)).size > 1);
  const needsReview = records.filter((record) => record.classificationSource !== "manual" && record.hasText);
  const withoutText = records.filter((record) => !record.hasText);

  return [
    "# 知识维基维护检查",
    "",
    `来源：${records.length} 份；Wiki 页面：${basePages.length + 1} 页。`,
    `待人工确认：${needsReview.length} 份；无可读正文：${withoutText.length} 份。`,
    `失效 Wiki 链接：${brokenLinks.length} 条；孤立页面：${orphanPages.length} 页；同名不同原件：${nameConflicts.length} 组。`,
    "",
    "## 待人工确认",
    ...(needsReview.length ? needsReview.map((record) => `- [${safeInline(record.originalName)}](sources/${record.id}.md)`) : ["- 无"]),
    "",
    "## 无可读正文",
    ...(withoutText.length ? withoutText.map((record) => `- [${safeInline(record.originalName)}](sources/${record.id}.md)`) : ["- 无"]),
    "",
    "## 失效 Wiki 链接",
    ...(brokenLinks.length ? brokenLinks.map((reference) => `- ${safeInline(reference)}`) : ["- 无"]),
    "",
    "## 孤立页面",
    ...(orphanPages.length ? orphanPages.map((page) => `- ${safeInline(page)}`) : ["- 无"]),
    "",
    "## 同名不同原件",
    ...(nameConflicts.length
      ? nameConflicts.map(({ name, entries }) => `- ${safeInline(name)}：${entries.map((entry) => `[${entry.sha256Prefix}](sources/${entry.id}.md)`).join("、")}`)
      : ["- 无"]),
  ].join("\n");
}

export function compileWiki(records: StoredKnowledgeRecord[]): WikiPage[] {
  const ordered = [...records].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const groups = new Map<string, StoredKnowledgeRecord[]>();
  for (const record of ordered) {
    const key = record.category || "待整理";
    groups.set(key, [...(groups.get(key) || []), record]);
  }
  const topics = [...groups.entries()].map(([category, entries]): WikiPage => ({
    path: `topics/${String(Math.max(0, knowledgeCategorySchema.options.indexOf(category as typeof knowledgeCategorySchema.options[number]) + 1)).padStart(2, "0")}.md`,
    title: category,
    kind: "topic",
    markdown: [
      `# ${safeInline(category)}`,
      "",
      "此页是来源记录中摘要的可重建汇编，不是跨文档 LLM 综合。模型建议尚未人工确认的内容不能当作已核实事实。",
      "",
      ...entries.flatMap((entry) => [
        `## [${safeInline(entry.title)}](../sources/${entry.id}.md)`,
        "",
        `${safeInline(entry.summary)} [来源：${safeInline(entry.originalName)}](../sources/${entry.id}.md)`,
        `状态：${entry.classificationSource === "manual" ? "人工确认" : entry.classificationStatus === "classified" ? "模型建议待确认" : "待整理"}`,
        "",
      ]),
    ].join("\n"),
  }));
  const sources = ordered.map((record): WikiPage => ({
    path: `sources/${record.id}.md`,
    title: record.originalName,
    kind: "source",
    markdown: (() => {
      const excerpt = record.extractedText?.slice(0, WIKI_SOURCE_EXCERPT_CHARS).trim() || "";
      const excerptText = excerpt
        ? `${safeInline(excerpt)}${record.extractedText && record.extractedText.length > WIKI_SOURCE_EXCERPT_CHARS ? "…（已截断）" : ""}`
        : "当前没有可读取的原件解析正文。";
      return [
      `# ${safeInline(record.originalName)}`,
      "",
      `- 原件：[下载原始文件](${record.downloadUrl})`,
      `- 上传时间：${record.uploadedAt}`,
      `- SHA-256 前缀：${record.sha256Prefix}`,
      `- SHA-256：${record.sha256 || record.sha256Prefix}`,
      `- 记录版本：${record.version}`,
      `- 记录标题：${safeInline(record.title)}`,
      `- 标签：${(record.tags ?? []).map(safeInline).join("、") || "无"}`,
      `- 分类状态：${record.classificationSource === "manual" ? "人工确认" : record.classificationStatus === "classified" ? "模型建议待确认" : "待整理或仅归档"}`,
      `- 解析状态：${record.parseStatus}`,
      "",
      "## 整理摘要",
      "",
      safeInline(record.summary),
      "",
      "摘要、标题、标签与分类是衍生内容；如与原件冲突，以原件为准。此页不替代原始文件。",
      "",
      "## 原件解析节选",
      "",
      "以下内容来自上传原件的解析文本，仅用于检索提示；可能截断且未经人工核实，不能替代原件。",
      "",
      excerptText,
    ].join("\n");
    })(),
  }));
  const index: WikiPage = {
    path: "index.md", title: "知识维基索引", kind: "index",
    markdown: [
      "# LumaFlow 知识维基",
      "",
      "原始文件只读保存，Wiki 是可重建的整理层。先核对来源，再采用模型建议；当前版本不会自动生成跨文档综合结论。",
      "",
      `共 ${ordered.length} 份来源、${topics.length} 个主题。`,
      "",
      "## 独立知识源",
      "",
      "- [天昭灯网产品快照](/?knowledge=1)：结构化产品档案、详情页截图与 OCR 的独立目录；它与本 Wiki 的私人上传原件分开维护。具体型号、商品编码和规格需回查原始 JSON 与截图。",
      "",
      "## 主题",
      "",
      ...topics.map((topic) => `- [${safeInline(topic.title)}](${topic.path})：${groups.get(topic.title)?.length || 0} 份来源`),
      "",
      "## 最近来源",
      "",
      ...sources.slice(0, 30).map((source) => `- [${safeInline(source.title)}](${source.path})`),
      "",
      "[处理记录](log.md)",
      "[维护检查](lint.md) · [整理规则](schema.md)",
    ].join("\n"),
  };
  const log: WikiPage = {
    path: "log.md", title: "处理记录", kind: "log",
    markdown: [
      "# 知识维基处理记录",
      "",
      "以下 ingest 时间线按原件记录可重建。每行只使用上传时的稳定字段；后续分类或人工确认不会改写历史 ingest 行。",
      "",
      ...[...ordered].reverse().flatMap((record) => [
        `## [${record.uploadedAt.slice(0, 10)}] ingest | ${safeInline(record.originalName)}`,
        `source: ${record.id} · sha256: ${record.sha256 || record.sha256Prefix}`,
        "",
      ]),
    ].join("\n"),
  };
  const schema: WikiPage = {
    path: "schema.md", title: "整理规则", kind: "schema",
    markdown: [
      "# LumaFlow Wiki 整理规则",
      "",
      "1. 原件是不修改的来源层。下载链接与 SHA-256 前缀用于回查，不能用模型摘要替代原件。",
      "2. 来源页、主题页和索引是可重建的 Markdown 整理层。每项摘要都指向来源页；当前版本不声称已经完成跨文档 LLM 综合。",
      "3. 模型分类只是建议。人工确认后，才允许把该分类用于智能检索。",
      "4. 无可读正文的文件仅归档，不宣称模型已经理解。OCR 结果可能有误，具体型号和规格需核对原始 JSON 与截图。",
      "5. 新来源上传后更新来源页、主题页、索引和处理记录；维护检查列出待确认与不可解析的材料。",
      "6. 回答具体问题时先读索引和相关主题，再核对来源原件；存在冲突时展示各来源，不自行消除分歧。",
      "7. 天昭灯网产品快照是独立的结构化目录，不复制进私人上传 Wiki；引用其具体字段时仍需核对原始 JSON 与截图。",
    ].join("\n"),
  };
  const basePages = [index, ...topics, ...sources, log, schema];
  const lint: WikiPage = {
    path: "lint.md", title: "维护检查", kind: "lint",
    markdown: buildMaintenanceMarkdown(ordered, basePages),
  };
  return [index, ...topics, ...sources, log, lint, schema];
}

export function searchWikiPages(pages: WikiPage[], query: string, limit = 20): WikiSearchMatch[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const matches: WikiSearchMatch[] = [];
  for (const page of pages) {
    const title = page.title.toLocaleLowerCase();
    const pagePath = page.path.toLocaleLowerCase();
    const plain = markdownText(page.markdown);
    const plainLower = plain.toLocaleLowerCase();
    const haystack = `${title} ${pagePath} ${plainLower}`;
    if (!haystack.includes(normalizedQuery) && !terms.every((term) => haystack.includes(term))) continue;
    let score = 0;
    if (title.includes(normalizedQuery)) score += 100;
    if (pagePath.includes(normalizedQuery)) score += 40;
    for (const term of terms) {
      if (title.includes(term)) score += 20;
      if (plainLower.includes(term)) score += 5;
    }
    const firstTerm = terms.find((term) => plainLower.includes(term)) ?? normalizedQuery;
    const position = Math.max(0, plainLower.indexOf(firstTerm));
    const start = Math.max(0, position - 70);
    const excerpt = `${start > 0 ? "…" : ""}${plain.slice(start, start + 220)}${start + 220 < plain.length ? "…" : ""}`;
    matches.push({ path: page.path, title: page.title, kind: page.kind, excerpt, score });
  }
  return matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).slice(0, safeLimit);
}

export async function saveWikiPages(pages: WikiPage[]) {
  if (process.env.VERCEL === "1") {
    if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) throw new Error("Private Blob store is not configured.");
    for (const page of pages) {
      await put(cloudPath(page.path), page.markdown, { access: "private", allowOverwrite: true, contentType: "text/markdown; charset=utf-8" });
    }
    return;
  }
  for (const page of pages) {
    const target = path.join(wikiDirectory, page.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, page.markdown, "utf8");
  }
}

async function removeWikiPage(page: string) {
  if (process.env.VERCEL === "1") {
    if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) throw new Error("Private Blob store is not configured.");
    await del(cloudPath(page));
    return;
  }
  await rm(path.join(wikiDirectory, page), { force: true });
}

export async function readWikiPage(page: string) {
  if (page.includes("..") || !/^(index|log|lint|schema|topics\/\d{2}|sources\/[0-9a-f-]{36})\.md$/i.test(page)) return null;
  if (process.env.VERCEL === "1") {
    if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) return null;
    const blob = await get(cloudPath(page), { access: "private", useCache: false });
    return blob?.statusCode === 200 ? new Response(blob.stream).text() : null;
  }
  return readFile(path.join(wikiDirectory, page), "utf8").catch(() => null);
}

export async function refreshWiki(changedSourceId?: string) {
  const pages = compileWiki(await listKnowledgeRecords());
  const candidates = pages.filter((page) => page.kind !== "source" || page.path === `sources/${changedSourceId}.md`);
  const changedPages = (await Promise.all(candidates.map(async (page) => ({
    page,
    current: await readWikiPage(page.path),
  })))).filter(({ page, current }) => current !== page.markdown).map(({ page }) => page);
  if (changedPages.length) await saveWikiPages(changedPages);
  // A deleted source has no page in the freshly compiled Wiki. Remove its
  // generated source page so local disk and the private Blob archive agree.
  if (changedSourceId && !pages.some((page) => page.path === `sources/${changedSourceId}.md`)) {
    await removeWikiPage(`sources/${changedSourceId}.md`);
  }
  return pages;
}
