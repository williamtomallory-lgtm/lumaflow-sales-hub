from __future__ import annotations

import hashlib
import json
import sqlite3
from collections import defaultdict
from datetime import datetime
from pathlib import Path


SOURCE = Path(
    r"E:\DataDocument\ChatGPT\NewProject\outputs\01a0b6ce-ef4f-70c1-a93f-356639863e1d\天昭灯网现有资料_719款_20260919"
)
HERE = Path(__file__).resolve().parent
PRODUCT_DIR = SOURCE / "原始产品记录"
IMAGE_DIR = SOURCE / "产品图片"
OCR_DIR = SOURCE / "OCR原始结果"
MANIFEST_SOURCE = SOURCE / "导出清单.json"


def strings(value):
    if value is None:
        return
    if isinstance(value, str):
        if value.strip():
            yield value.strip()
        return
    if isinstance(value, (int, float, bool)):
        yield str(value)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from strings(item)
        return
    if isinstance(value, list):
        for item in value:
            yield from strings(item)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def normalize(raw: dict) -> dict:
    nested = isinstance(raw.get("product"), dict)
    product = raw["product"] if nested else raw
    if nested:
        evidence = [x.get("path") for x in as_list((raw.get("images") or {}).get("page_screenshots")) if isinstance(x, dict)]
        evidence += [x.get("path") for x in as_list((raw.get("source") or {}).get("source_files")) if isinstance(x, dict)]
        source_text = "；".join(
            x for x in [str((raw.get("source") or {}).get("platform") or ""), str((raw.get("source") or {}).get("access_context") or "")] if x
        )
        capture_date = (raw.get("source") or {}).get("captured_on")
    else:
        evidence = as_list(raw.get("evidence"))
        source_text = raw.get("source") or ""
        capture_date = raw.get("capture_date")

    evidence = list(dict.fromkeys(str(x) for x in evidence if x))
    return {
        "name": product.get("name") or "",
        "model": product.get("model") or "",
        "product_code": product.get("product_code") or "",
        "category": product.get("category") or "",
        "style": product.get("style") or "",
        "material": product.get("material") or product.get("tag") or product.get("material_tag") or "",
        "price": product.get("display_price_cny", product.get("price_amount")),
        "unit": product.get("unit") or product.get("measurement_unit") or "",
        "availability_status": product.get("availability_status") or "详情可用",
        "capture_date": capture_date or "",
        "source": source_text,
        "review_status": product.get("review_status") or "",
        "evidence": evidence,
        "nested_schema": nested,
        "search_text": "\n".join(strings(raw)),
    }


def main():
    HERE.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST_SOURCE.read_text(encoding="utf-8-sig"))
    manifest_map = {item["json_file"]: item for item in manifest["products"]}

    products = []
    image_owners = defaultdict(list)
    for json_path in sorted(PRODUCT_DIR.glob("product-*.json"), key=lambda p: p.name.casefold()):
        raw = json.loads(json_path.read_text(encoding="utf-8-sig"))
        item = normalize(raw)
        canonical = manifest_map.get(json_path.name, {})
        evidence = list(dict.fromkeys(canonical.get("evidence") or item["evidence"]))
        image_paths = [str((IMAGE_DIR / name).resolve()) for name in evidence]
        ocr_paths = [str((OCR_DIR / f"{name}.ocr.json").resolve()) for name in evidence if (OCR_DIR / f"{name}.ocr.json").exists()]
        item.update(
            {
                "json_file": json_path.name,
                "json_path": str(json_path.resolve()),
                "image_files": evidence,
                "image_paths": image_paths,
                "ocr_paths": ocr_paths,
                "raw": raw,
            }
        )
        products.append(item)
        for image_name in evidence:
            image_owners[image_name].append(
                {"model": item["model"], "product_code": item["product_code"], "json_file": json_path.name}
            )

    images = []
    for image_name, owners in sorted(image_owners.items(), key=lambda pair: pair[0].casefold()):
        image_path = IMAGE_DIR / image_name
        ocr_path = OCR_DIR / f"{image_name}.ocr.json"
        if not image_path.exists():
            raise FileNotFoundError(image_path)
        ocr_raw = None
        ocr_text = ""
        if ocr_path.exists():
            ocr_raw = json.loads(ocr_path.read_text(encoding="utf-8-sig"))
            ocr_text = "\n".join(strings(ocr_raw))
        images.append(
            {
                "image_name": image_name,
                "image_path": str(image_path.resolve()),
                "size_bytes": image_path.stat().st_size,
                "sha256": sha256(image_path),
                "ocr_path": str(ocr_path.resolve()) if ocr_path.exists() else "",
                "ocr_text": ocr_text,
                "owners": owners,
            }
        )

    products_jsonl = HERE / "products.jsonl"
    images_jsonl = HERE / "images.jsonl"
    products_jsonl.write_text(
        "".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n" for item in products),
        encoding="utf-8",
    )
    images_jsonl.write_text(
        "".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n" for item in images),
        encoding="utf-8",
    )

    db_path = HERE / "tianzhao_products.sqlite"
    if db_path.exists():
        db_path.unlink()
    connection = sqlite3.connect(db_path)
    connection.executescript(
        """
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        CREATE TABLE products (
            id INTEGER PRIMARY KEY,
            model TEXT NOT NULL,
            product_code TEXT,
            name TEXT,
            category TEXT,
            style TEXT,
            material TEXT,
            price REAL,
            unit TEXT,
            availability_status TEXT,
            capture_date TEXT,
            source TEXT,
            review_status TEXT,
            json_path TEXT NOT NULL,
            image_paths_json TEXT NOT NULL,
            ocr_paths_json TEXT NOT NULL,
            raw_json TEXT NOT NULL
        );
        CREATE UNIQUE INDEX products_model_unique ON products(model);
        CREATE INDEX products_code_index ON products(product_code);
        CREATE VIRTUAL TABLE products_fts USING fts5(
            model, product_code, name, category, style, material, search_text,
            tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TABLE images (
            id INTEGER PRIMARY KEY,
            image_name TEXT NOT NULL UNIQUE,
            image_path TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            ocr_path TEXT,
            owners_json TEXT NOT NULL,
            ocr_text TEXT
        );
        CREATE VIRTUAL TABLE images_fts USING fts5(
            image_name, owners, ocr_text,
            tokenize='unicode61 remove_diacritics 2'
        );
        """
    )
    for idx, item in enumerate(products, 1):
        connection.execute(
            "INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                idx,
                item["model"],
                item["product_code"],
                item["name"],
                item["category"],
                item["style"],
                item["material"],
                item["price"],
                item["unit"],
                item["availability_status"],
                item["capture_date"],
                item["source"],
                item["review_status"],
                item["json_path"],
                json.dumps(item["image_paths"], ensure_ascii=False),
                json.dumps(item["ocr_paths"], ensure_ascii=False),
                json.dumps(item["raw"], ensure_ascii=False),
            ),
        )
        connection.execute(
            "INSERT INTO products_fts(rowid,model,product_code,name,category,style,material,search_text) VALUES (?,?,?,?,?,?,?,?)",
            (idx, item["model"], item["product_code"], item["name"], item["category"], item["style"], item["material"], item["search_text"]),
        )
    for idx, item in enumerate(images, 1):
        owner_text = " ".join(f"{x['model']} {x['product_code']}" for x in item["owners"])
        connection.execute(
            "INSERT INTO images VALUES (?,?,?,?,?,?,?,?)",
            (
                idx,
                item["image_name"],
                item["image_path"],
                item["size_bytes"],
                item["sha256"],
                item["ocr_path"],
                json.dumps(item["owners"], ensure_ascii=False),
                item["ocr_text"],
            ),
        )
        connection.execute(
            "INSERT INTO images_fts(rowid,image_name,owners,ocr_text) VALUES (?,?,?,?)",
            (idx, item["image_name"], owner_text, item["ocr_text"]),
        )
    connection.commit()
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    connection.close()

    status_counts = defaultdict(int)
    for item in products:
        status_counts[item["availability_status"]] += 1
    kb_manifest = {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source_folder": str(SOURCE.resolve()),
        "product_count": len(products),
        "image_count": len(images),
        "ocr_sidecar_count": sum(bool(item["ocr_path"]) for item in images),
        "status_counts": dict(sorted(status_counts.items())),
        "source_audit": json.loads((SOURCE / "导出核对结果.json").read_text(encoding="utf-8-sig")),
        "database_integrity": integrity,
        "knowledge_files": ["tianzhao_products.sqlite", "products.jsonl", "images.jsonl", "README.md", "search.py"],
        "image_storage": "Images stay in the canonical export folder and are indexed by absolute path; no duplicate image copy is stored here.",
    }
    (HERE / "manifest.json").write_text(json.dumps(kb_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(kb_manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
