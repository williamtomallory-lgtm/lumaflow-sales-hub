"""Build deployable WebP previews and a public-safe Tianzhao image index.

The source export keeps the original screenshots outside the Next.js tree and
the knowledge-base JSONL files point at them with absolute Windows paths. This
script turns those references into small, static WebP files and emits an index
that contains URLs only. It is intentionally deterministic so it can be rerun
after the source export is refreshed.

Usage:
    python scripts/build-tianzhao-previews.py

Requires Pillow (``python -m pip install pillow``).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_IMAGES = REPO_ROOT / "knowledge_base" / "tianzhao-products" / "images.jsonl"
SOURCE_PRODUCTS = REPO_ROOT / "knowledge_base" / "tianzhao-products" / "products.jsonl"
SOURCE_MANIFEST = REPO_ROOT / "knowledge_base" / "tianzhao-products" / "manifest.json"
OUTPUT_ROOT = REPO_ROOT / "public" / "tianzhao-previews"
INDEX_PATH = REPO_ROOT / "src" / "data" / "tianzhao-image-index.json"


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON in {path} line {line_number}: {exc}") from exc
            if not isinstance(row, dict):
                raise ValueError(f"Expected an object in {path} line {line_number}")
            rows.append(row)
    return rows


def slug(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return value or "product"


def product_folder(model: str, product_code: str) -> str:
    identity = f"{model}\0{product_code}"
    digest = hashlib.sha1(identity.encode("utf-8")).hexdigest()[:10]
    return f"{slug(model)[:56]}-{digest}"


def kind_for(filename: str) -> str:
    lower = filename.lower()
    if "-top" in lower or lower.startswith("01-") or "-home" in lower:
        return "cover"
    if "-photo" in lower or "-product" in lower:
        return "product"
    if "-fields" in lower or "-detail" in lower or "-parameter" in lower:
        return "details"
    if "list" in lower or "row" in lower:
        return "overview"
    return "screenshot"


KIND_ORDER = {"cover": 0, "product": 1, "details": 2, "overview": 3, "screenshot": 4}


def image_sort_key(item: dict[str, str]) -> tuple[int, str]:
    return KIND_ORDER.get(item["kind"], 99), item["name"]


def encode_webp(source: Path, destination: Path, quality: int, max_width: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as original:
        image = ImageOps.exif_transpose(original)
        # The source export consists of 507x951 screenshots. A 300px preview
        # keeps the static deployment below the Vercel Hobby upload budget;
        # the original screenshots remain available in the source release.
        if max_width > 0 and image.width > max_width:
            height = round(image.height * max_width / image.width)
            image = image.resize((max_width, height), Image.Resampling.LANCZOS)
        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGBA" if "transparency" in image.info else "RGB")
        image.save(destination, format="WEBP", quality=quality, method=4)


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, separators=(",", ": ")) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def build(*, quality: int, max_width: int, clean: bool) -> dict[str, Any]:
    if not SOURCE_IMAGES.is_file():
        raise FileNotFoundError(SOURCE_IMAGES)
    if not SOURCE_PRODUCTS.is_file():
        raise FileNotFoundError(SOURCE_PRODUCTS)

    images = read_jsonl(SOURCE_IMAGES)
    products = read_jsonl(SOURCE_PRODUCTS)
    manifest: dict[str, Any] = {}
    if SOURCE_MANIFEST.is_file():
        manifest = json.loads(SOURCE_MANIFEST.read_text(encoding="utf-8"))
    snapshot_date = (
        manifest.get("exported_at")
        or (manifest.get("source_audit") or {}).get("exported_at")
        or "2026-09-20"
    )
    if clean and OUTPUT_ROOT.exists():
        # Only this generated directory is ever removed; the source export is
        # outside the target and remains untouched.
        shutil.rmtree(OUTPUT_ROOT)
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

    by_id: dict[str, list[dict[str, str]]] = defaultdict(list)
    by_model: dict[str, list[dict[str, str]]] = defaultdict(list)
    missing: list[str] = []
    failures: list[dict[str, str]] = []
    seen_source_hashes: dict[str, str] = {}
    duplicate_source_mappings: list[dict[str, str]] = []

    for row in images:
        source_path = Path(str(row.get("image_path", "")))
        image_name = str(row.get("image_name", ""))
        owners = row.get("owners") or []
        if not source_path.is_file():
            missing.append(str(source_path))
            continue
        if len(owners) != 1:
            failures.append({"image": image_name, "reason": "expected exactly one owner"})
            continue

        owner = owners[0]
        model = str(owner.get("model", "")).strip()
        product_code = str(owner.get("product_code", "")).strip()
        if not model:
            failures.append({"image": image_name, "reason": "owner model is blank"})
            continue

        folder = product_folder(model, product_code)
        output_name = f"{Path(image_name).stem}.webp"
        destination = OUTPUT_ROOT / folder / output_name
        try:
            encode_webp(source_path, destination, quality, max_width)
        except (OSError, ValueError) as exc:
            failures.append({"image": image_name, "reason": str(exc)})
            continue

        source_hash = str(row.get("sha256", ""))
        if source_hash:
            previous = seen_source_hashes.get(source_hash)
            if previous and previous != image_name:
                duplicate_source_mappings.append({"first": previous, "duplicate": image_name})
            seen_source_hashes[source_hash] = image_name

        item = {
            "filename": output_name,
            "url": f"/tianzhao-previews/{folder}/{output_name}",
            "name": image_name,
            "kind": kind_for(image_name),
        }
        product_id = f"tianzhao:{model}"
        by_id[product_id].append(item)
        by_model[model].append(item)

    # Make ordering stable even if the JSONL export order changes.
    for image_list in [*by_id.values(), *by_model.values()]:
        image_list.sort(key=image_sort_key)

    source_product_models = {
        str(product.get("model", "")).strip()
        for product in products
        if str(product.get("model", "")).strip()
    }
    indexed_models = set(by_model)
    metadata = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": {
            "snapshotDate": str(snapshot_date)[:10],
            "productCount": len(products),
            "imageCount": len(images),
            "imageNotice": "图片为微信小程序产品详情页截图，不是商家原始产品图片。",
        },
        "counts": {
            "products": len(products),
            "productsWithPreviews": len(by_model),
            "images": len(images),
            "previews": sum(len(items) for items in by_model.values()),
            "missing": len(missing),
            "failures": len(failures),
            "duplicateSourceMappings": len(duplicate_source_mappings),
        },
        "products": dict(sorted(by_id.items())),
        "models": dict(sorted(by_model.items())),
    }
    write_json(INDEX_PATH, metadata)

    result = {
        "source_products": len(products),
        "source_images": len(images),
        "indexed_models": len(indexed_models),
        "previews": sum(len(items) for items in by_model.values()),
        "missing": missing,
        "failures": failures,
        "duplicate_source_mappings": duplicate_source_mappings,
        "output_root": str(OUTPUT_ROOT),
        "index_path": str(INDEX_PATH),
        "quality": quality,
        "max_width": max_width,
        "source_models_without_images": sorted(source_product_models - indexed_models),
    }
    return result


def reorder_existing_index() -> dict[str, Any]:
    """Apply the stable kind order without recompressing existing previews."""
    if not INDEX_PATH.is_file():
        raise FileNotFoundError(INDEX_PATH)
    data = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    for key in ("products", "models"):
        for image_list in data.get(key, {}).values():
            image_list.sort(key=image_sort_key)
    write_json(INDEX_PATH, data)
    return {
        "index_path": str(INDEX_PATH),
        "products": len(data.get("products", {})),
        "models": len(data.get("models", {})),
        "images": sum(len(items) for items in data.get("models", {}).values()),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quality", type=int, default=58, help="WebP quality (default: 58)")
    parser.add_argument("--max-width", type=int, default=300, help="Maximum preview width in pixels (default: 300)")
    parser.add_argument("--clean", action="store_true", help="Remove the generated preview directory first")
    parser.add_argument("--reorder-index", action="store_true", help="Reorder an existing index without recompressing images")
    args = parser.parse_args()
    if args.reorder_index:
        print(json.dumps(reorder_existing_index(), ensure_ascii=False, indent=2))
        return
    if not 1 <= args.quality <= 100:
        parser.error("--quality must be between 1 and 100")
    if args.max_width < 0:
        parser.error("--max-width must be zero or greater")
    result = build(quality=args.quality, max_width=args.max_width, clean=args.clean)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
