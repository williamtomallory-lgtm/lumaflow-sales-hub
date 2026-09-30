"""Create real office deliverables without model-written shell commands."""
from pathlib import Path
import csv
import os
import re
import tempfile
from xml.sax.saxutils import escape

from agent.tools.base_tool import BaseTool, ToolResult


def create_document(args, workspace):
    root = Path(workspace).resolve()
    fmt = str(args.get("format") or "").lower()
    if fmt not in {"pdf", "docx", "xlsx", "pptx", "csv", "txt", "md", "html"}:
        raise ValueError("Unsupported document format")
    raw = args.get("path") or args.get("filename") or f"document.{fmt}"
    target = Path(raw).expanduser()
    target = (target if target.is_absolute() else root / target).resolve()
    if not target.is_relative_to(root) or target.suffix.lower() != f".{fmt}":
        raise ValueError("Document must be inside the workspace and have the requested extension")
    content = args.get("content")
    if not isinstance(content, str) or not content.strip() or len(content) > 1_000_000:
        raise ValueError("Document content is empty or too large")
    if target.exists() and not args.get("overwrite"):
        raise ValueError("File exists; choose a new filename or explicitly set overwrite")
    title = str(args.get("title") or target.stem)[:200]
    lines = content.splitlines()
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(suffix=f".{fmt}", dir=target.parent)
    os.close(handle)
    try:
        if fmt == "pdf":
            from reportlab.pdfbase import pdfmetrics
            from reportlab.pdfbase.cidfonts import UnicodeCIDFont
            from reportlab.lib.styles import getSampleStyleSheet
            from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
            pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
            styles = getSampleStyleSheet()
            for style in styles.byName.values():
                style.fontName = "STSong-Light"
                style.wordWrap = "CJK"
            story = [Paragraph(escape(title), styles["Title"]), Spacer(1, 12)]
            for line in lines:
                style = styles["Heading2"] if line.startswith("#") else styles["BodyText"]
                story.extend([Paragraph(escape(line.lstrip("# ")) or "&#160;", style), Spacer(1, 6)])
            SimpleDocTemplate(temporary, title=title).build(story)
        elif fmt == "docx":
            from docx import Document
            document = Document()
            document.add_heading(title, 0)
            for line in lines:
                if line.startswith("#"):
                    document.add_heading(line.lstrip("# "), min(len(line) - len(line.lstrip("#")), 3))
                else:
                    document.add_paragraph(line)
            document.save(temporary)
        elif fmt in {"xlsx", "csv"}:
            rows = args.get("rows")
            if rows is None:
                rows = [list(csv.reader([line.strip().strip("|")], delimiter="|"))[0] for line in lines if "|" in line]
                rows = [[cell.strip() for cell in row] for row in rows if not all(set(cell.strip()) <= set("-: ") for cell in row)]
                rows = rows or [[line] for line in lines]
                if fmt == "xlsx":
                    def typed_cell(value):
                        if len(value.replace(".", "").lstrip("+-")) <= 15 and re.fullmatch(r"[+-]?(?:0|[1-9]\d*)(?:\.\d+)?", value):
                            return float(value) if "." in value else int(value)
                        return value
                    rows = [[typed_cell(cell) for cell in row] for row in rows]
            if not isinstance(rows, list) or len(rows) > 10000 or any(not isinstance(row, list) or len(row) > 200 for row in rows):
                raise ValueError("Invalid table rows")
            if fmt == "xlsx":
                from openpyxl import Workbook
                workbook = Workbook()
                sheet = workbook.active
                sheet.title = "Data"
                for row in rows:
                    sheet.append(row)
                sheet.freeze_panes = "A2"
                sheet.auto_filter.ref = sheet.dimensions
                workbook.save(temporary)
            else:
                with open(temporary, "w", encoding="utf-8-sig", newline="") as stream:
                    csv.writer(stream).writerows(rows)
        elif fmt == "pptx":
            from pptx import Presentation
            from pptx.util import Pt
            slides = args.get("slides")
            if slides is None:
                slides = []
                for line in lines:
                    if line.startswith("#") or not slides:
                        slides.append({"title": line.lstrip("# ") or title, "content": ""})
                    else:
                        slides[-1]["content"] += line + "\n"
            if not isinstance(slides, list) or not 1 <= len(slides) <= 100:
                raise ValueError("Provide between 1 and 100 slides")
            presentation = Presentation()
            for data in slides:
                slide = presentation.slides.add_slide(presentation.slide_layouts[1])
                slide.shapes.title.text = str(data.get("title") or title)
                slide.placeholders[1].text = str(data.get("content") or "")
                for paragraph in slide.placeholders[1].text_frame.paragraphs:
                    paragraph.font.size = Pt(20)
            presentation.save(temporary)
        else:
            Path(temporary).write_text(content, encoding="utf-8")
        if Path(temporary).stat().st_size == 0:
            raise ValueError("Generated file is empty")
        if not args.get("overwrite"):
            # Exclusive creation avoids clobbering a concurrently generated file.
            with target.open("xb") as output, open(temporary, "rb") as source:
                import shutil
                shutil.copyfileobj(source, output)
        else:
            os.replace(temporary, target)
        return {"path": str(target), "filename": target.name, "format": fmt,
                "bytes": target.stat().st_size, "saved": True}
    finally:
        Path(temporary).unlink(missing_ok=True)


class CreateDocument(BaseTool):
    name = "create_document"
    description = "Create a real PDF, Word DOCX, Excel XLSX, PowerPoint PPTX, CSV, text or HTML file in the workspace. Supply actual content; no Python availability check is needed. After creation use send to deliver the file. Report success only after the tool returns saved=true."
    params = {"type": "object", "properties": {
        "format": {"type": "string", "enum": ["pdf", "docx", "xlsx", "pptx", "csv", "txt", "md", "html"]},
        "path": {"type": "string"}, "content": {"type": "string"}, "title": {"type": "string"},
        "overwrite": {"type": "boolean"},
        "rows": {"type": "array", "items": {"type": "array", "items": {}}},
        "slides": {"type": "array", "items": {"type": "object", "properties": {"title": {"type": "string"}, "content": {"type": "string"}}}},
    }, "required": ["format", "path", "content"]}

    def execute(self, args):
        try:
            return ToolResult.success(create_document(args, self.cwd or os.getcwd()))
        except (ValueError, OSError, ImportError, TypeError, KeyError) as exc:
            return ToolResult.fail(str(exc))
