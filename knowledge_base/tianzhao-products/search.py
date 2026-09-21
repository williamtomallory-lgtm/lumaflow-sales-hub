from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


DB = Path(__file__).with_name("tianzhao_products.sqlite")


def fts_query(text: str) -> str:
    tokens = [token.strip().replace('"', '""') for token in text.split() if token.strip()]
    return " AND ".join(f'"{token}"*' for token in tokens)


def main():
    parser = argparse.ArgumentParser(description="搜索天昭灯网产品知识库")
    parser.add_argument("query", help="型号、商品编码、名称、类别、材质、规格或 OCR 文字")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--images", action="store_true", help="搜索图片 OCR 索引")
    args = parser.parse_args()

    connection = sqlite3.connect(DB)
    connection.row_factory = sqlite3.Row
    if args.images:
        rows = connection.execute(
            """
            SELECT i.image_name, i.image_path, i.ocr_path, i.owners_json, bm25(images_fts) AS score
            FROM images_fts JOIN images i ON i.id = images_fts.rowid
            WHERE images_fts MATCH ? ORDER BY score LIMIT ?
            """,
            (fts_query(args.query), args.limit),
        ).fetchall()
    else:
        rows = connection.execute(
            """
            SELECT p.model, p.product_code, p.name, p.category, p.style, p.material,
                   p.price, p.unit, p.availability_status, p.json_path,
                   p.image_paths_json, p.ocr_paths_json, bm25(products_fts) AS score
            FROM products_fts JOIN products p ON p.id = products_fts.rowid
            WHERE products_fts MATCH ? ORDER BY score LIMIT ?
            """,
            (fts_query(args.query), args.limit),
        ).fetchall()
    connection.close()

    results = []
    for row in rows:
        item = dict(row)
        for key in ("image_paths_json", "ocr_paths_json", "owners_json"):
            if key in item:
                item[key.removesuffix("_json")] = json.loads(item.pop(key))
        results.append(item)
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
