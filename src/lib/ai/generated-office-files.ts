import JSZip from "jszip";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type GeneratedOfficeFile = {
  filename: string;
  mimeType: string;
  data: Uint8Array;
};

export type MarkdownTable = {
  headers: string[];
  rows: string[][];
};

export type GeneratedOfficeOptions = {
  /** The file name may include an extension. Unsafe path characters are replaced. */
  filename?: string;
  /** Used as the document title and as the fallback file name. */
  title?: string;
};

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeFileBase(value: string, fallback: string) {
  const base = value
    .trim()
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return (base || fallback).slice(0, 96);
}

function fileName(options: GeneratedOfficeOptions | undefined, extension: "docx" | "xlsx") {
  const fallback = extension === "docx" ? "AI生成文档" : "AI生成表格";
  const base = safeFileBase(options?.filename ?? options?.title ?? "", fallback);
  return `${base}.${extension}`;
}

/** Convert a Uint8Array into a browser-downloadable Blob without SharedArrayBuffer typing issues. */
export function officeFileToBlob(file: GeneratedOfficeFile) {
  const copy = new Uint8Array(file.data.byteLength);
  copy.set(file.data);
  return new Blob([copy.buffer], { type: file.mimeType });
}

function splitMarkdownRow(line: string) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

function isTableDelimiter(line: string) {
  const cells = splitMarkdownRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function hasTablePipe(line: string) {
  let escaped = false;
  for (const character of line) {
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === "|") return true;
  }
  return false;
}

/**
 * Parse GitHub-Flavored Markdown tables. A table starts with a header row and a
 * delimiter row containing at least three dashes per column. Escaped pipes are
 * kept as literal pipe characters in the returned cells.
 */
export function parseMarkdownTables(markdown: string): MarkdownTable[] {
  const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const tables: MarkdownTable[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!hasTablePipe(lines[index]) || !isTableDelimiter(lines[index + 1])) continue;
    const headers = splitMarkdownRow(lines[index]);
    const delimiter = splitMarkdownRow(lines[index + 1]);
    if (headers.length < 1 || delimiter.length !== headers.length) continue;

    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].trim() && hasTablePipe(lines[cursor])) {
      const row = splitMarkdownRow(lines[cursor]);
      if (row.length === headers.length) rows.push(row);
      cursor += 1;
    }
    tables.push({ headers, rows });
    index = cursor - 1;
  }
  return tables;
}

function tableLineIndexes(markdown: string) {
  const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const skipped = new Set<number>();
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!hasTablePipe(lines[index]) || !isTableDelimiter(lines[index + 1])) continue;
    const width = splitMarkdownRow(lines[index]).length;
    if (!width) continue;
    skipped.add(index);
    skipped.add(index + 1);
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].trim() && hasTablePipe(lines[cursor])) {
      if (splitMarkdownRow(lines[cursor]).length === width) skipped.add(cursor);
      cursor += 1;
    }
    index = cursor - 1;
  }
  return { lines, skipped };
}

type DocxBlock =
  | { kind: "paragraph" | "heading" | "bullet" | "ordered" | "code" | "quote"; text: string; level?: number }
  | { kind: "table"; table: MarkdownTable };

function markdownBlocks(markdown: string): DocxBlock[] {
  const { lines, skipped } = tableLineIndexes(markdown);
  const blocks: DocxBlock[] = [];
  const tables = parseMarkdownTables(markdown);
  const tableByStart = new Map<number, MarkdownTable>();
  let tableIndex = 0;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (hasTablePipe(lines[index]) && isTableDelimiter(lines[index + 1])) {
      tableByStart.set(index, tables[tableIndex]);
      tableIndex += 1;
      while (index + 1 < lines.length && skipped.has(index + 1) && lines[index + 1].trim() && hasTablePipe(lines[index + 1])) index += 1;
    }
  }

  let inCode = false;
  let codeLanguage = "";
  let codeLines: string[] = [];
  const flushCode = () => {
    if (!codeLines.length) return;
    blocks.push({ kind: "code", text: `${codeLanguage ? `[${codeLanguage}]\n` : ""}${codeLines.join("\n")}` });
    codeLines = [];
    codeLanguage = "";
  };

  for (let index = 0; index < lines.length; index += 1) {
    if (tableByStart.has(index)) {
      if (inCode) flushCode();
      blocks.push({ kind: "table", table: tableByStart.get(index)! });
      while (index + 1 < lines.length && skipped.has(index + 1)) index += 1;
      continue;
    }
    if (skipped.has(index)) continue;
    const line = lines[index];
    const fence = /^\s*(```+|~~~+)\s*([^ ]*)\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
        codeLanguage = fence[2] ?? "";
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", text: heading[2], level: heading[1].length });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      blocks.push({ kind: "bullet", text: bullet[1] });
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      blocks.push({ kind: "ordered", text: ordered[1] });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push({ kind: "quote", text: quote[1] });
      continue;
    }
    blocks.push({ kind: "paragraph", text: line });
  }
  if (inCode) flushCode();
  return blocks;
}

function textRun(text: string, props = "") {
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t${preserve}>${escapeXml(text)}</w:t></w:r>`;
}

function inlineRuns(value: string) {
  const runs: string[] = [];
  const pattern = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+)`/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) runs.push(textRun(value.slice(cursor, index)));
    if (match[2]) runs.push(textRun(match[2], "<w:b/>") );
    else if (match[4]) runs.push(textRun(match[4], "<w:i/>") );
    else if (match[5]) runs.push(textRun(match[5], '<w:rStyle w:val="CodeChar"/>'));
    cursor = index + match[0].length;
  }
  if (cursor < value.length) runs.push(textRun(value.slice(cursor)));
  return runs.join("") || textRun("");
}

function paragraphXml(block: Extract<DocxBlock, { kind: "paragraph" | "heading" | "bullet" | "ordered" | "code" | "quote" }>) {
  let pPr = "";
  if (block.kind === "heading") pPr = `<w:pStyle w:val="Heading${Math.min(block.level ?? 1, 6)}"/>`;
  if (block.kind === "code") pPr = '<w:pStyle w:val="CodeBlock"/>';
  if (block.kind === "quote") pPr = '<w:pStyle w:val="Quote"/>';
  if (block.kind === "bullet") return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="420" w:hanging="210"/></w:pPr>${textRun("• ")}${inlineRuns(block.text)}</w:p>`;
  if (block.kind === "ordered") return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="420" w:hanging="210"/></w:pPr>${textRun("1. ")}${inlineRuns(block.text)}</w:p>`;
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${block.kind === "code" || block.kind === "quote" ? textRun(block.text) : inlineRuns(block.text)}</w:p>`;
}

function tableXml(table: MarkdownTable) {
  const rows = [table.headers, ...table.rows].map((row, rowIndex) => `<w:tr>${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/>${rowIndex === 0 ? "<w:shd w:fill=\"EAF4EF\"/>" : ""}</w:tcPr><w:p>${rowIndex === 0 ? inlineRuns(`**${cell}**`) : inlineRuns(cell)}</w:p></w:tc>`).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="C9D9D0"/><w:left w:val="single" w:sz="4" w:color="C9D9D0"/><w:bottom w:val="single" w:sz="4" w:color="C9D9D0"/><w:right w:val="single" w:sz="4" w:color="C9D9D0"/><w:insideH w:val="single" w:sz="4" w:color="C9D9D0"/><w:insideV w:val="single" w:sz="4" w:color="C9D9D0"/></w:tblBorders></w:tblPr>${rows}</w:tbl>`;
}

function docxDocumentXml(title: string, markdown: string) {
  const blocks = markdownBlocks(markdown);
  const body = blocks.length ? blocks.map((block) => block.kind === "table" ? tableXml(block.table) : paragraphXml(block)).join("") : "<w:p><w:r><w:t></w:t></w:r></w:p>";
  return `${XML_HEADER}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${textRun(title)}</w:p>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

function docxStylesXml() {
  return `${XML_HEADER}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="等线"/><w:sz w:val="22"/><w:lang w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="145A44"/></w:rPr></w:style>${[1, 2, 3, 4, 5, 6].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:outlineLvl w:val="${level - 1}"/><w:rPr><w:b/><w:sz w:val="${Math.max(22, 34 - level * 2)}"/><w:color w:val="145A44"/></w:rPr></w:style>`).join("")}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:jc w:val="left"/></w:pPr><w:rPr><w:i/><w:color w:val="52645A"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:fill="F3F6F4"/><w:spacing w:before="80" w:after="80"/></w:pPr><w:rPr><w:rFonts w:ascii="Cascadia Mono" w:hAnsi="Cascadia Mono"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Character"/><w:rPr><w:rFonts w:ascii="Cascadia Mono" w:hAnsi="Cascadia Mono"/><w:shd w:fill="F3F6F4"/></w:rPr></w:style></w:styles>`;
}

function corePropertiesXml(title: string) {
  return `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>LumaFlow</dc:creator><cp:lastModifiedBy>LumaFlow</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created></cp:coreProperties>`;
}

function appPropertiesXml() {
  return `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>LumaFlow</Application><AppVersion>1.0</AppVersion></Properties>`;
}

function docxContentTypesXml() {
  return `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
}

/** Build a valid OOXML Word document from ordinary Markdown and GFM tables. */
export async function createDocxFromMarkdown(markdown: string, options?: GeneratedOfficeOptions): Promise<GeneratedOfficeFile> {
  const title = options?.title?.trim() || safeFileBase(options?.filename ?? "", "AI生成文档");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", docxContentTypesXml());
  zip.file("_rels/.rels", `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  zip.file("word/document.xml", docxDocumentXml(title, markdown));
  zip.file("word/styles.xml", docxStylesXml());
  zip.file("word/_rels/document.xml.rels", `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file("docProps/core.xml", corePropertiesXml(title));
  zip.file("docProps/app.xml", appPropertiesXml());
  const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { filename: fileName(options, "docx"), mimeType: DOCX_MIME, data };
}

function columnName(index: number) {
  let current = index + 1;
  let name = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function worksheetXml(table: MarkdownTable) {
  const rows = [table.headers, ...table.rows];
  const maxColumns = Math.max(1, ...rows.map((row) => row.length));
  const cells = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${Array.from({ length: maxColumns }, (_, columnIndex) => {
    const value = row[columnIndex] ?? "";
    const style = rowIndex === 0 ? ' s="1"' : "";
    return `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }).join("")}</row>`).join("");
  return `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${columnName(maxColumns - 1)}${rows.length}"/><sheetViews><sheetView workbookViewId="0" showGridLines="1"/></sheetViews><cols>${Array.from({ length: maxColumns }, (_, index) => `<col min="${index + 1}" max="${index + 1}" width="18" customWidth="1"/>`).join("")}</cols><sheetData>${cells}</sheetData><autoFilter ref="A1:${columnName(maxColumns - 1)}${rows.length}"/></worksheet>`;
}

function workbookXml(sheetNames: string[]) {
  return `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="18000" windowHeight="12000"/></bookViews><sheets>${sheetNames.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`;
}

function xlsxContentTypesXml(sheetCount: number) {
  return `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${Array.from({ length: sheetCount }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`;
}

function xlsxStylesXml() {
  return `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="2"><font><sz val="11"/><name val="Aptos"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="145A44"/><name val="Aptos"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="EAF4EF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

/** Build a valid OOXML Excel workbook. Each Markdown table becomes one worksheet. */
export async function createXlsxFromMarkdown(markdown: string, options?: GeneratedOfficeOptions): Promise<GeneratedOfficeFile> {
  const tables = parseMarkdownTables(markdown);
  // A prose-only answer still gets a useful workbook: each non-empty source
  // line is placed in a single "内容" column. Markdown tables remain the
  // preferred path and each table becomes its own worksheet.
  const workbookTables = tables.length ? tables : [{
    headers: ["内容"],
    rows: markdown
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => [line]),
  }];
  const sheetNames = workbookTables.map((_, index) => tables.length ? `表格${index + 1}` : "内容");
  const title = options?.title?.trim() || safeFileBase(options?.filename ?? "", "AI生成表格");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", xlsxContentTypesXml(workbookTables.length));
  zip.file("_rels/.rels", `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", workbookXml(sheetNames));
  zip.file("xl/styles.xml", xlsxStylesXml());
  zip.file("xl/_rels/workbook.xml.rels", `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookTables.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${workbookTables.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  workbookTables.forEach((table, index) => zip.file(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(table)));
  zip.file("docProps/core.xml", corePropertiesXml(title));
  zip.file("docProps/app.xml", appPropertiesXml());
  const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { filename: fileName(options, "xlsx"), mimeType: XLSX_MIME, data };
}

/** UI-facing Word export: return a browser-downloadable Blob with a stable MIME type. */
export async function createWordDocument(markdown: string, options?: GeneratedOfficeOptions) {
  return officeFileToBlob(await createDocxFromMarkdown(markdown, options));
}

/** UI-facing Excel export: Markdown tables become sheets; prose falls back to one "内容" column. */
export async function createExcelWorkbook(markdown: string, options?: GeneratedOfficeOptions) {
  return officeFileToBlob(await createXlsxFromMarkdown(markdown, options));
}
