"""Export the text of every available OCR sidecar for product detail pages.

Only recognized text is published. Local file paths, bounding boxes and OCR
confidence estimates stay in the original source archive.
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / "knowledge_base/tianzhao-products/images.jsonl"
PRODUCTS = ROOT / "src/data/tianzhao-products.json"
OUTPUT = ROOT / "src/data/tianzhao-ocr-index.json"


def lines_from_sidecar(path: Path) -> list[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"Unexpected OCR sidecar format: {path.name}")
    return [item["text"].strip() for item in data if isinstance(item, dict) and isinstance(item.get("text"), str) and item["text"].strip()]


def main() -> None:
    products = json.loads(PRODUCTS.read_text(encoding="utf-8"))["products"]
    by_owner: dict[str, dict[str, list[str]]] = defaultdict(dict)
    sidecars = 0
    for line in IMAGES.read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        owners = record.get("owners") or []
        if len(owners) != 1:
            raise ValueError(f"Unexpected image owners: {record.get('image_name')}")
        product_id = f"tianzhao:{owners[0]['model']}"
        path = Path(record["ocr_path"]) if record.get("ocr_path") else None
        recognized = lines_from_sidecar(path) if path and path.is_file() else []
        if path and path.is_file():
            sidecars += 1
        by_owner[product_id][record["image_name"]] = recognized

    result = {}
    for product in products:
        image_text = by_owner[product["id"]]
        result[product["id"]] = [
            {"name": name, "lines": image_text.get(name, [])}
            for name in product["evidence"]
        ]
    image_count = sum(len(value) for value in result.values())
    if len(result) != 1887 or image_count != 7674 or sidecars != 7645:
        raise ValueError(f"OCR coverage mismatch: products={len(result)}, images={image_count}, sidecars={sidecars}")
    OUTPUT.write_text(json.dumps({"counts": {"products": len(result), "images": image_count, "sidecars": sidecars}, "products": result}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"products": len(result), "images": image_count, "sidecars": sidecars, "bytes": OUTPUT.stat().st_size}))


if __name__ == "__main__":
    main()
