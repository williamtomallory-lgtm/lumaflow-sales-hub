import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

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

  if (["txt", "csv", "md"].includes(extension ?? "") || mimeType.startsWith("text/")) {
    rawText = new TextDecoder("utf-8").decode(buffer);
  } else if (extension === "docx" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
    rawText = result.value;
  } else if (extension === "pdf" || mimeType === "application/pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(buffer), { maxImageSize: 16_777_216 });
    if (pdf.numPages > 100) throw new Error("PDF 最多支持 100 页");
    const result = await Promise.race([
      extractText(pdf, { mergePages: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("PDF 解析超时")), 15_000)),
    ]);
    rawText = String(result.text);
    pages = result.totalPages;
  } else {
    throw new Error("暂不支持此文件格式；请上传 TXT、CSV、Markdown、PDF 或 DOCX");
  }

  const normalized = rawText.replace(/\0/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) throw new Error("没有提取到可读文本；扫描版 PDF 需要接入 OCR");
  return {
    text: normalized.slice(0, MAX_TEXT),
    characters: normalized.length,
    pages,
    truncated: normalized.length > MAX_TEXT,
  };
}
