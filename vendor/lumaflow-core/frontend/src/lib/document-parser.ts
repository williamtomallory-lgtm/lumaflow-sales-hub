import { extractText, getDocumentProxy } from "unpdf";
import { parseOfficeText } from "./office-text";

export type ParsedDocument = {
  text: string;
  characters: number;
  pages?: number;
  truncated: boolean;
};

const MAX_TEXT = 20_000;

export async function parseDocumentBuffer(name: string, mimeType: string, buffer: ArrayBuffer): Promise<ParsedDocument> {
  const extension = name.split(".").pop()?.toLowerCase();
  let rawText = "";
  let pages: number | undefined;
  let truncated = false;

  if (["txt", "csv", "tsv", "md", "markdown", "json", "jsonl", "log", "xml", "html", "htm"].includes(extension ?? "") || mimeType.startsWith("text/") || mimeType === "application/json") {
    rawText = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (rawText.includes("\0")) throw new Error("文件含二进制内容，不能按文本解析");
  } else if (extension === "xlsx" || extension === "pptx") {
    const result = await parseOfficeText(buffer, extension);
    rawText = result.text;
    truncated = result.truncated;
  } else if (extension === "docx" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await parseOfficeText(buffer, "docx");
    rawText = result.text;
    truncated = result.truncated;
  } else if (extension === "pdf" || mimeType === "application/pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(buffer), { maxImageSize: 16_777_216 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (pdf.numPages > 100) throw new Error("PDF 最多支持 100 页");
      const result = await Promise.race([
        extractText(pdf, { mergePages: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PDF 解析超时")), 15_000); }),
      ]);
      rawText = String(result.text);
      pages = result.totalPages;
    } finally {
      clearTimeout(timer);
      await pdf.loadingTask.destroy();
    }
  } else {
    throw new Error("暂不支持此文件正文解析；可解析 UTF-8 文本、JSON、CSV、PDF、DOCX、XLSX 或 PPTX；其他格式仅归档");
  }

  const normalized = rawText.replace(/\0/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) throw new Error("没有提取到可读文本；扫描版 PDF 需要接入 OCR");
  return {
    text: normalized.slice(0, MAX_TEXT),
    characters: normalized.length,
    pages,
    truncated: truncated || normalized.length > MAX_TEXT,
  };
}
