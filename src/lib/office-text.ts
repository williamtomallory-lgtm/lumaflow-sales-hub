import JSZip from "jszip";
import type { Readable } from "node:stream";

// Read selected Office XML entries only. Never extract paths, macros, images or external links.
const MAX_XML_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT = 20_000;
function decodeXml(value: string) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (named[entity]) return named[entity];
    const code = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}
function textNodes(xml: string) {
  return [...xml.matchAll(/<(?:[\w-]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?t>/g)].map((match) => decodeXml(match[1])).join("");
}

export async function parseOfficeText(buffer: ArrayBuffer, kind: "xlsx" | "pptx" | "docx") {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  if (names.length > 5000) throw new Error("Office 文件包含过多条目，已停止解析");
  let total = 0;
  async function xml(name: string) {
    const entry = zip.file(name);
    if (!entry) return "";
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = entry.nodeStream("nodebuffer") as Readable;
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        total += chunk.length;
        if (size > MAX_XML_BYTES || total > MAX_TOTAL_XML_BYTES) {
          stream.pause();
          stream.destroy();
          reject(new Error("Office 解压正文超过安全限制，已停止解析"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      stream.once("end", resolve);
      stream.once("error", reject);
    });
    const result = Buffer.concat(chunks).toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(result)) throw new Error("Office XML 含不支持的实体声明");
    return result;
  }
  const output: string[] = [];
  let outputSize = 0;
  let truncated = false;
  let contentFound = false;
  const append = (value: string) => {
    output.push(value);
    outputSize += value.length + 1;
    if (outputSize > MAX_OUTPUT) truncated = true;
  };
  if (kind === "xlsx") {
    const shared = [...(await xml("xl/sharedStrings.xml")).matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((match) => textNodes(match[1]));
    const sheets = names.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (sheets.length > 100) throw new Error("工作簿超过 100 个工作表");
    for (const sheet of sheets) {
      if (truncated) break;
      append(`[工作表 ${sheet.split("/").pop()}；公式只读取已缓存的值；不读取图片或批注]`);
      const sheetXml = await xml(sheet);
      for (const row of sheetXml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
        const cells = [...row[1].matchAll(/<c(\s[^>]*?)?>([\s\S]*?)<\/c>/g)].map((cell) => {
          const attr = cell[1] ?? "";
          const position = /\br="([^"]+)"/.exec(attr)?.[1] ?? "?";
          const type = /\bt="([^"]+)"/.exec(attr)?.[1];
          const value = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? "";
          const text = type === "s" ? shared[Number(value)] ?? "[共享字符串缺失]" : type === "inlineStr" ? textNodes(cell[2]) : decodeXml(value);
          if (text.trim()) contentFound = true;
          return `${position}: ${text || (/<f[\s>]/.test(cell[2]) ? "[公式无缓存值]" : "")}`;
        });
        if (cells.length) append(cells.join(" | "));
        if (truncated) break;
      }
    }
  } else {
    const documents = kind === "docx" ? ["word/document.xml"] : names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (documents.length > 200) throw new Error("演示文稿超过 200 页");
    for (const name of documents) {
      if (truncated) break;
      if (kind === "pptx") append(`[幻灯片 ${name.split("/").pop()}；仅提取文字，不读取图片]`);
      for (const paragraph of (await xml(name)).matchAll(/<(?:[\w-]+:)?p(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?p>/g)) {
        const text = textNodes(paragraph[1]);
        if (text) { contentFound = true; append(text); }
        if (truncated) break;
      }
    }
  }
  return { text: contentFound ? output.join("\n").slice(0, MAX_OUTPUT) : "", truncated };
}
