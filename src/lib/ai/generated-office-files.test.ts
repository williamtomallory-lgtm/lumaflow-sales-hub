import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  DOCX_MIME,
  XLSX_MIME,
  createExcelWorkbook,
  createDocxFromMarkdown,
  createWordDocument,
  createXlsxFromMarkdown,
  officeFileToBlob,
  parseMarkdownTables,
} from "./generated-office-files";

const markdown = `# 客户跟进报告

本周需要继续跟进 **华东项目**，预计下周确认。

| 客户 | 阶段 | 金额 |
| --- | :---: | ---: |
| 明亮照明 | 报价 | 12,500 |
| 星河空间 | 方案评审 | 8,000 |

## 下一步

- 周二发送报价单
- 周四确认交期

\`\`\`ts
const ready = true;
\`\`\``;

describe("generated office files", () => {
  it("parses GFM tables, including escaped pipes and alignment markers", () => {
    const tables = parseMarkdownTables("| 名称 | 备注 |\n| --- | --- |\n| A | 支持 \\| 分隔符 |");
    expect(tables).toEqual([{ headers: ["名称", "备注"], rows: [["A", "支持 | 分隔符"]] }]);
  });

  it("creates a readable DOCX package for prose, Markdown formatting and tables", async () => {
    const file = await createDocxFromMarkdown(markdown, { title: "客户跟进报告" });
    expect(file.filename).toBe("客户跟进报告.docx");
    expect(file.mimeType).toBe(DOCX_MIME);
    expect(file.data.byteLength).toBeGreaterThan(500);

    const zip = await JSZip.loadAsync(file.data);
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/styles.xml",
      "word/_rels/document.xml.rels",
      "docProps/core.xml",
      "docProps/app.xml",
    ]));
    const documentXml = await zip.file("word/document.xml")!.async("string");
    expect(documentXml).toContain("华东项目");
    expect(documentXml).toContain("明亮照明");
    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).toContain("<w:b/>");
    expect(documentXml).toContain("const ready = true;");
    expect(documentXml).not.toContain("<w:t># 客户");
  });

  it("creates one XLSX worksheet for every Markdown table", async () => {
    const source = `${markdown}\n\n| 地区 | 数量 |\n| --- | ---: |\n| 华东 | 2 |`;
    const file = await createXlsxFromMarkdown(source, { filename: "销售数据.xlsx" });
    expect(file.filename).toBe("销售数据.xlsx");
    expect(file.mimeType).toBe(XLSX_MIME);

    const zip = await JSZip.loadAsync(file.data);
    const workbook = await zip.file("xl/workbook.xml")!.async("string");
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    const sheet2 = await zip.file("xl/worksheets/sheet2.xml")!.async("string");
    expect(workbook).toContain('sheet name="表格1"');
    expect(workbook).toContain('sheet name="表格2"');
    expect(sheet).toContain("明亮照明");
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain('s="1"');
    expect(sheet2).toContain("华东");
    expect(sheet2).toContain("<autoFilter");
    expect(await zip.file("[Content_Types].xml")!.async("string")).toContain("sheet2.xml");
  });

  it("falls back to one prose column and exposes the UI Blob exports", async () => {
    const fallback = await createXlsxFromMarkdown("第一段正文\n\n第二段正文");
    const fallbackZip = await JSZip.loadAsync(fallback.data);
    const fallbackWorkbook = await fallbackZip.file("xl/workbook.xml")!.async("string");
    const fallbackSheet = await fallbackZip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(fallbackWorkbook).toContain('sheet name="内容"');
    expect(fallbackSheet).toContain("第一段正文");
    expect(fallbackSheet).toContain("第二段正文");
    const file = await createDocxFromMarkdown("正文", { filename: "报告.docx" });
    const blob = officeFileToBlob(file);
    expect(blob.type).toBe(DOCX_MIME);
    expect(blob.size).toBe(file.data.byteLength);
    const wordBlob = await createWordDocument("正文");
    const excelBlob = await createExcelWorkbook("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(wordBlob.type).toBe(DOCX_MIME);
    expect(excelBlob.type).toBe(XLSX_MIME);
    expect(wordBlob.size).toBeGreaterThan(500);
    expect(excelBlob.size).toBeGreaterThan(500);
  });
});
