"""Import the prepared Tianzhao snapshot into a local WeKnora knowledge base.

Set WEKNORA_API_KEY and WEKNORA_KB_ID in the process environment. Progress is
saved after each successful entry so a long import can resume safely.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / ".local-data/tianzhao-weknora-import.jsonl"
PROGRESS = ROOT / ".local-data/tianzhao-weknora-progress.json"


def main() -> None:
    api_key = os.environ.get("WEKNORA_API_KEY", "").strip()
    kb_id = os.environ.get("WEKNORA_KB_ID", "").strip()
    base_url = os.environ.get("WEKNORA_BASE_URL", "http://127.0.0.1:8092").rstrip("/")
    if not api_key or not kb_id:
        raise SystemExit("WEKNORA_API_KEY and WEKNORA_KB_ID are required")
    entries = [json.loads(line) for line in SOURCE.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(entries) != 1887:
        raise SystemExit(f"Expected 1887 product entries, found {len(entries)}")
    progress = json.loads(PROGRESS.read_text(encoding="utf-8")) if PROGRESS.exists() else {"kb_id": kb_id, "imported": {}}
    if progress["kb_id"] != kb_id:
        raise SystemExit("Progress file belongs to a different WeKnora knowledge base")
    url = f"{base_url}/api/v1/knowledge-bases/{kb_id}/knowledge/manual"
    for index, entry in enumerate(entries, start=1):
        if str(index) in progress["imported"]:
            continue
        payload = json.dumps(entry, ensure_ascii=False).encode("utf-8")
        request = Request(url, data=payload, method="POST", headers={
            "X-API-Key": api_key,
            "Content-Type": "application/json; charset=utf-8",
        })
        for attempt in range(3):
            try:
                with urlopen(request, timeout=90) as response:
                    body = json.load(response)
                if body.get("success") is not True:
                    raise RuntimeError(f"WeKnora rejected entry {index}: {body.get('message', 'unknown error')}")
                knowledge = body.get("data") or {}
                progress["imported"][str(index)] = knowledge.get("id", "")
                PROGRESS.write_text(json.dumps(progress, ensure_ascii=False), encoding="utf-8")
                if index == len(entries) or index % 50 == 0:
                    print(f"imported={len(progress['imported'])}/{len(entries)}")
                break
            except (HTTPError, URLError) as error:
                if attempt == 2 or isinstance(error, HTTPError) and error.code not in (429, 502, 503, 504):
                    raise RuntimeError(f"Import stopped at entry {index}: {error}") from error
                time.sleep(2 ** attempt)
    print(f"complete={len(progress['imported'])}/{len(entries)}")


if __name__ == "__main__":
    main()
