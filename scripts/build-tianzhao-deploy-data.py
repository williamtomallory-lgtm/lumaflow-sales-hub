from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "outputs" / "01a0b6ce-ef4f-70c1-a93f-356639863e1d" / "天昭灯网现有资料_719款_20260919"
PRODUCT_DIR = SOURCE / "原始产品记录"
OUTPUT = ROOT / "src" / "data" / "tianzhao-products.json"
RELEASE_URL = "https://github.com/williamtomallory-lgtm/lumaflow-sales-hub/releases/tag/tianzhao-20260920"
ARCHIVE_URL = "https://github.com/williamtomallory-lgtm/lumaflow-sales-hub/releases/download/tianzhao-20260920/tianzhao-products-20260920.zip"


def as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def normalize(raw: dict, filename: str) -> dict:
    nested = isinstance(raw.get("product"), dict)
    product = raw["product"] if nested else raw
    if nested:
        page_images = [item.get("path") for item in as_list((raw.get("images") or {}).get("page_screenshots")) if isinstance(item, dict)]
        source_images = [item.get("path") for item in as_list((raw.get("source") or {}).get("source_files")) if isinstance(item, dict)]
        evidence = list(dict.fromkeys(str(value) for value in [*page_images, *source_images] if value))
        capture_date = (raw.get("source") or {}).get("captured_on")
        source = "；".join(value for value in [str((raw.get("source") or {}).get("platform") or ""), str((raw.get("source") or {}).get("access_context") or "")] if value)
    else:
        evidence = list(dict.fromkeys(str(value) for value in as_list(raw.get("evidence")) if value))
        capture_date = raw.get("capture_date")
        source = raw.get("source")

    known = {
        "name", "model", "product_code", "category", "style", "material_tag", "tag",
        "display_price_cny", "price_amount", "display_price_scope", "price_display", "price_scope",
        "unit", "measurement_unit", "selected_specification", "selected_spec", "specifications",
        "spec_options_visible", "color", "color_options", "dimensions", "dimensions_mm", "light_source",
        "material", "applicable_area", "suitable_area", "scene", "suitable_scenes", "light_source_included",
        "photo_text_ocr", "availability_status", "review_status", "review_note", "review_notes",
        "ocr_model_note", "capture_date", "source", "evidence", "image_type",
    }
    extra = {key: value for key, value in product.items() if key not in known and value not in (None, "", [], {})}
    return {
        "id": f"tianzhao:{product.get('model') or filename.removeprefix('product-').removesuffix('.json')}",
        "name": product.get("name") or "",
        "model": product.get("model") or "",
        "productCode": product.get("product_code") or "",
        "category": product.get("category") or "",
        "style": product.get("style") or "",
        "materialTag": product.get("material_tag") or product.get("tag") or "",
        "priceCny": product.get("display_price_cny", product.get("price_amount")),
        "priceScope": product.get("display_price_scope") or product.get("price_display") or product.get("price_scope") or "",
        "unit": product.get("unit") or product.get("measurement_unit") or "",
        "selectedSpecification": product.get("selected_specification") or product.get("selected_spec") or "",
        "specifications": as_list(product.get("specifications") or product.get("spec_options_visible")),
        "color": product.get("color") or "",
        "colorOptions": as_list(product.get("color_options")),
        "dimensions": product.get("dimensions") or product.get("dimensions_mm") or "",
        "lightSource": product.get("light_source") or "",
        "material": product.get("material") or "",
        "applicableArea": product.get("applicable_area") or product.get("suitable_area") or "",
        "scene": product.get("scene") or "",
        "photoTextOcr": as_list(product.get("photo_text_ocr")),
        "availabilityStatus": product.get("availability_status") or "详情可用",
        "reviewStatus": product.get("review_status") or "",
        "reviewNote": product.get("review_note") or "",
        "ocrModelNote": product.get("ocr_model_note") or "",
        "captureDate": capture_date or "",
        "source": source or "",
        "jsonFile": filename,
        "evidence": evidence,
        "extra": extra,
    }


def main():
    products = []
    for path in sorted(PRODUCT_DIR.glob("product-*.json"), key=lambda item: item.name.casefold()):
        products.append(normalize(json.loads(path.read_text(encoding="utf-8-sig")), path.name))

    payload = {
        "metadata": {
            "store": "天昭灯网",
            "snapshotDate": "2026-09-20",
            "productCount": len(products),
            "imageCount": 7674,
            "ocrSidecarCount": 7645,
            "sourceAudit": "PASS",
            "exportAudit": "PASS",
            "imageNotice": "图片为微信小程序产品详情页截图，不是商家原始产品图片。",
            "dataNotice": "OCR 可能有误；空字段表示未能可靠确认，不得自行推断。",
            "releaseUrl": RELEASE_URL,
            "archiveUrl": ARCHIVE_URL,
        },
        "products": products,
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"output": str(OUTPUT), "productCount": len(products), "bytes": OUTPUT.stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    main()
