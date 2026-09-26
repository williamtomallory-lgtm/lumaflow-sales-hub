"""Prepare one WeKnora manual knowledge entry per Tianzhao product.

The export includes structured product fields and every OCR line. Product
images remain on the LumaFlow detail page linked from each entry.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]
PRODUCTS = ROOT / "src/data/tianzhao-products.json"
OCR = ROOT / "src/data/tianzhao-ocr-index.json"
DEFAULT_OUTPUT = ROOT / ".local-data/tianzhao-weknora-import.jsonl"

FIELDS = (
    ("型号", "model"),
    ("商品编码", "productCode"),
    ("品类", "category"),
    ("风格", "style"),
    ("标签", "materialTag"),
    ("展示价格（元）", "priceCny"),
    ("价格适用范围", "priceScope"),
    ("单位", "unit"),
    ("所选规格", "selectedSpecification"),
    ("全部规格", "specifications"),
    ("颜色", "color"),
    ("全部颜色", "colorOptions"),
    ("尺寸", "dimensions"),
    ("光源", "lightSource"),
    ("材质", "material"),
    ("适用面积", "applicableArea"),
    ("适用场景", "scene"),
    ("供应状态", "availabilityStatus"),
    ("资料复核状态", "reviewStatus"),
    ("复核备注", "reviewNote"),
    ("OCR 型号说明", "ocrModelNote"),
    ("截图日期", "captureDate"),
    ("资料来源", "source"),
    ("原始记录文件", "jsonFile"),
)


def display(value: object) -> str:
    if isinstance(value, list):
        return "；".join(str(item) for item in value if str(item).strip())
    return "" if value is None else str(value).strip()


def render(product: dict, images: list[dict]) -> str:
    title = product["name"] or product["model"]
    url = f"https://lumaflow-sales-hub.vercel.app/knowledge/tianzhao/{quote(product['model'], safe='')}"
    lines = [f"# {title}", "", f"产品详情与全部截图：{url}", "", "## 产品档案", ""]
    for label, field in FIELDS:
        value = display(product.get(field))
        if value:
            lines.append(f"- {label}：{value}")
    if product.get("photoTextOcr"):
        lines.extend(("", "## 整理后的图片文字", ""))
        lines.extend(f"- {line}" for line in product["photoTextOcr"] if str(line).strip())
    lines.extend(("", "## 每张截图的 OCR 原文", "", "以下文字由图片自动识别，型号和规格需对照详情页截图核实。", ""))
    for image in images:
        lines.append(f"### {image['name']}")
        lines.append("")
        lines.extend(f"- {line}" for line in image.get("lines", []) if str(line).strip())
        if not image.get("lines"):
            lines.append("未生成 OCR 结果。")
        lines.append("")
    if product.get("extra"):
        lines.extend(("## 原始记录附加字段", "", "```json", json.dumps(product["extra"], ensure_ascii=False, indent=2), "```", ""))
    return "\n".join(lines).strip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    products = json.loads(PRODUCTS.read_text(encoding="utf-8"))["products"]
    ocr = json.loads(OCR.read_text(encoding="utf-8"))["products"]
    if len(products) != 1887 or len(ocr) != 1887:
        raise ValueError("Tianzhao product and OCR counts do not match the verified snapshot")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="\n") as stream:
        for product in products:
            record = {
                "title": product["name"] or product["model"],
                "content": render(product, ocr[product["id"]]),
                "status": "publish",
                "channel": "lumaflow-tianzhao-snapshot",
            }
            stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"entries={len(products)} bytes={args.output.stat().st_size} path={args.output}")


if __name__ == "__main__":
    main()
