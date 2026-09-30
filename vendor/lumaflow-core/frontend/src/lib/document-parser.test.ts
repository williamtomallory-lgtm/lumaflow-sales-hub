import { describe, expect, it } from "vitest";
import { parseDocumentBuffer } from "./document-parser";
import JSZip from "jszip";

describe("document parser", () => {
  it("extracts and normalizes UTF-8 text", async () => {
    const bytes = new TextEncoder().encode("产品知识   \n\n\nARC T18：18W 轨道灯");
    const result = await parseDocumentBuffer("catalog.txt", "text/plain", bytes.buffer);
    expect(result.text).toBe("产品知识\n\nARC T18：18W 轨道灯");
    expect(result.characters).toBeGreaterThan(10);
    expect(result.truncated).toBe(false);
  });

  it("rejects unsupported formats honestly", async () => {
    const bytes = new TextEncoder().encode("data");
    await expect(parseDocumentBuffer("archive.zip", "application/zip", bytes.buffer)).rejects.toThrow("暂不支持");
  });

  it("extracts a generated text PDF and releases its loading task", async () => {
    const { jsPDF } = await import("jspdf");
    const document = new jsPDF();
    document.text("Local knowledge sample: 30 black lights", 10, 10);
    const result = await parseDocumentBuffer("sample.pdf", "application/pdf", document.output("arraybuffer"));
    expect(result.text).toContain("30 black lights");
    expect(result.pages).toBe(1);
  });

  it("extracts XLSX shared strings, inline strings and cached values without running formulas", async () => {
    const zip = new JSZip();
    zip.file("xl/sharedStrings.xml", '<sst><si><t>客户需求</t></si></sst>');
    zip.file("xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>黑色轨道灯</t></is></c><c r="C1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>');
    const result = await parseDocumentBuffer("跟进.xlsx", "application/octet-stream", await zip.generateAsync({ type: "arraybuffer" }));
    expect(result.text).toContain("A1: 客户需求 | B1: 黑色轨道灯 | C1: 2");
    expect(result.text).toContain("只读取已缓存的值");
  });

  it("extracts DOCX and PPTX paragraphs while keeping XML as text only", async () => {
    for (const kind of ["docx", "pptx"]) {
      const zip = new JSZip();
      zip.file(kind === "docx" ? "word/document.xml" : "ppt/slides/slide1.xml", '<w:document><w:p><w:r><w:t>产品 &amp; 客户</w:t></w:r></w:p></w:document>');
      const result = await parseDocumentBuffer(`sample.${kind}`, "application/octet-stream", await zip.generateAsync({ type: "arraybuffer" }));
      expect(result.text).toContain("产品 & 客户");
    }
  });

  it("does not claim to understand image-only slides, binary text, or XML entity declarations", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", '<p:sld><p:pic /></p:sld>');
    await expect(parseDocumentBuffer("image.pptx", "", await zip.generateAsync({ type: "arraybuffer" }))).rejects.toThrow("没有提取");
    zip.file("ppt/slides/slide1.xml", '<!DOCTYPE x><p:sld><a:t>text</a:t></p:sld>');
    await expect(parseDocumentBuffer("entity.pptx", "", await zip.generateAsync({ type: "arraybuffer" }))).rejects.toThrow("实体");
    await expect(parseDocumentBuffer("fake.txt", "text/plain", new Uint8Array([0, 1, 2]).buffer)).rejects.toThrow("二进制");
  });

  it("enforces actual decompressed XML byte limits", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "x".repeat(3 * 1024 * 1024 + 1));
    await expect(parseDocumentBuffer("large.docx", "", await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" }))).rejects.toThrow("安全限制");
  });
});
