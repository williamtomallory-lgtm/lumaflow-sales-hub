"""Install the pinned Qwen Image 2.1 GGUF runtime and model files.

This installer intentionally uses only the Python standard library.  It keeps
downloads resumable with a sidecar ``.part`` file, verifies every completed
file by size and SHA-256, and extracts only safe runtime members from the
pinned ZIP archives.  It never starts the image worker.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = Path("config/qwen-image-gguf-manifest.json")
MAX_RETRIES = 6
MAX_MEMBER_BYTES = 2 * 1024 * 1024 * 1024
MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024
USER_AGENT = "LumaFlow-Qwen-Image-Installer/1.0"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _relative_parts(value: object, label: str) -> tuple[str, ...]:
    text = str(value).replace("\\", "/")
    path = PurePosixPath(text)
    parts = path.parts
    if not text or path.is_absolute() or not parts or parts[0].endswith(":") or any(part in ("", "..") for part in parts):
        raise ValueError(f"Unsafe {label}: {value}")
    return parts


def contained(root: Path, relative: object, label: str = "path") -> Path:
    parts = _relative_parts(relative, label)
    base = root.resolve()
    target = base.joinpath(*parts).resolve()
    try:
        target.relative_to(base)
    except ValueError as error:
        raise ValueError(f"{label} escapes project root: {relative}") from error
    return target


def _record_bytes(record: dict[str, object]) -> int:
    raw = record.get("bytes", record.get("size"))
    if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0:
        raise ValueError("Every asset must have a positive integer bytes value")
    return raw


def _validate_record(record: object, label: str) -> dict[str, object]:
    if not isinstance(record, dict):
        raise ValueError(f"Invalid {label} record")
    _record_bytes(record)
    digest = record.get("sha256")
    if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest.lower()):
        raise ValueError(f"Invalid SHA-256 for {label}")
    url = record.get("url")
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        raise ValueError(f"Invalid download URL for {label}")
    return record


def load_manifest(path: Path) -> dict[str, object]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Unable to read Qwen Image manifest {path}: {error}") from error
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise ValueError("Unsupported Qwen Image GGUF manifest")
    if not isinstance(manifest.get("files"), list) or not isinstance(manifest.get("archives"), list):
        raise ValueError("Qwen Image manifest requires files and archives arrays")
    seen_paths: set[str] = set()
    for index, record in enumerate(manifest["files"]):
        item = _validate_record(record, f"file {index}")
        path_value = item.get("path")
        parts = _relative_parts(path_value, "file path")
        normalized = "/".join(parts)
        if normalized in seen_paths:
            raise ValueError(f"Duplicate manifest path: {normalized}")
        seen_paths.add(normalized)
    seen_names: set[str] = set()
    for index, record in enumerate(manifest["archives"]):
        item = _validate_record(record, f"archive {index}")
        name = item.get("name")
        parts = _relative_parts(name, "archive name")
        if len(parts) != 1:
            raise ValueError(f"Archive name must be a filename: {name}")
        normalized = parts[0]
        if normalized in seen_names:
            raise ValueError(f"Duplicate archive name: {normalized}")
        seen_names.add(normalized)
    runtime = manifest.get("runtime", {})
    if not isinstance(runtime, dict):
        raise ValueError("Qwen Image runtime section must be an object")
    extract_to = runtime.get("extractTo", ".local-runtime/qwen-image/bin")
    contained(ROOT, extract_to, "runtime extraction path")
    extensions = runtime.get("includeExtensions", [".exe", ".dll", ".txt", ".md"])
    if not isinstance(extensions, list) or not all(isinstance(item, str) and item.startswith(".") for item in extensions):
        raise ValueError("runtime includeExtensions must be a list of file extensions")
    required = manifest.get("required", [])
    runtime_required = runtime.get("required", [])
    if not isinstance(required, list) or not isinstance(runtime_required, list):
        raise ValueError("Qwen Image required paths must be arrays")
    for required in [*required, *runtime_required]:
        contained(ROOT, required, "required path")
    return manifest


def verified(path: Path, record: dict[str, object]) -> bool:
    try:
        return path.is_file() and path.stat().st_size == _record_bytes(record) and sha256(path) == str(record["sha256"]).lower()
    except OSError:
        return False


def _content_range_start(value: str) -> int | None:
    if not value.lower().startswith("bytes ") or "-" not in value:
        return None
    try:
        return int(value[6:].split("-", 1)[0])
    except ValueError:
        return None


def download(record: dict[str, object], target: Path, offline: bool, verify_only: bool) -> None:
    expected_bytes = _record_bytes(record)
    if verified(target, record):
        print(f"VERIFIED {target}", flush=True)
        return
    if target.exists():
        raise RuntimeError(f"Existing file differs; it was not overwritten: {target}")
    if verify_only:
        raise RuntimeError(f"Missing or corrupt Qwen Image asset: {target}")
    if offline:
        raise RuntimeError(f"Offline Qwen Image asset missing or corrupt: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    url = str(record["url"])
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            if offset > expected_bytes:
                partial.unlink()
                offset = 0
            elif offset == expected_bytes and sha256(partial) == str(record["sha256"]).lower():
                partial.replace(target)
                print(f"VERIFIED {target}", flush=True)
                return
            headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity"}
            if offset:
                headers["Range"] = f"bytes={offset}-"
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=120) as response:
                status = int(response.getcode() or 200)
                append = offset > 0 and status == 206
                if append:
                    range_start = _content_range_start(response.headers.get("Content-Range", ""))
                    if range_start != offset:
                        append = False
                if not append:
                    offset = 0
                mode = "ab" if append else "wb"
                with partial.open(mode) as stream:
                    last_report = time.monotonic()
                    while True:
                        block = response.read(8 * 1024 * 1024)
                        if not block:
                            break
                        stream.write(block)
                        offset += len(block)
                        if time.monotonic() - last_report >= 15:
                            print(f"DOWNLOADING {target.name} {offset / expected_bytes:.1%}", flush=True)
                            last_report = time.monotonic()
            if partial.stat().st_size != expected_bytes:
                if partial.stat().st_size > expected_bytes:
                    partial.unlink(missing_ok=True)
                raise ValueError(f"size mismatch ({partial.stat().st_size} != {expected_bytes})")
            if sha256(partial) != str(record["sha256"]).lower():
                partial.unlink(missing_ok=True)
                raise ValueError("SHA-256 mismatch")
            partial.replace(target)
            print(f"VERIFIED {target}", flush=True)
            return
        except (OSError, urllib.error.URLError, ValueError, zipfile.BadZipFile) as error:
            print(f"RETRY {target.name} {attempt}/{MAX_RETRIES}: {error}", flush=True)
            if attempt == MAX_RETRIES:
                raise RuntimeError(f"Download failed: {target}") from error
            time.sleep(min(3 * attempt, 20))


def _safe_member(info: zipfile.ZipInfo) -> tuple[str, ...] | None:
    name = info.filename.replace("\\", "/")
    if "\x00" in name:
        raise ValueError("ZIP member contains NUL")
    parts = _relative_parts(name, "ZIP member")
    mode = (info.external_attr >> 16) & 0xFFFF
    if stat.S_ISLNK(mode):
        raise ValueError(f"ZIP symlink is not allowed: {info.filename}")
    return parts


def extract_runtime(archive: Path, root: Path, runtime: dict[str, object], verify_only: bool) -> None:
    extract_to = contained(root, runtime.get("extractTo", ".local-runtime/qwen-image/bin"), "runtime extraction path")
    flatten = bool(runtime.get("flatten", True))
    extensions = {str(item).lower() for item in runtime.get("includeExtensions", [".exe", ".dll", ".txt", ".md"])}
    extract_total = 0
    seen_members: set[str] = set()
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            parts = _safe_member(info)
            if parts is None:
                continue
            member_name = "/".join(parts)
            if member_name in seen_members:
                raise ValueError(f"Duplicate ZIP member: {member_name}")
            seen_members.add(member_name)
            if info.is_dir():
                continue
            suffix = Path(parts[-1]).suffix.lower()
            if suffix not in extensions:
                continue
            if info.file_size > MAX_MEMBER_BYTES or extract_total + info.file_size > MAX_EXTRACTED_BYTES:
                raise ValueError(f"ZIP member is too large: {info.filename}")
            extract_total += info.file_size
            relative = parts[-1] if flatten else "/".join(parts)
            target = contained(extract_to, relative, "runtime output")
            if verify_only:
                continue
            if target.exists():
                if not target.is_file():
                    raise RuntimeError(f"Runtime output is not a regular file: {target}")
                if target.stat().st_size != info.file_size:
                    raise RuntimeError(f"Existing runtime file differs; it was not overwritten: {target}")
                digest = hashlib.sha256()
                with bundle.open(info) as source:
                    for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
                        digest.update(block)
                if digest.hexdigest() != sha256(target):
                    raise RuntimeError(f"Existing runtime file differs; it was not overwritten: {target}")
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            pending = target.with_name(target.name + ".installing")
            digest = hashlib.sha256()
            written = 0
            with bundle.open(info) as source, pending.open("wb") as destination:
                for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
                    destination.write(block)
                    digest.update(block)
                    written += len(block)
            if written != info.file_size or digest.hexdigest() != sha256(pending):
                pending.unlink(missing_ok=True)
                raise RuntimeError(f"Extracted runtime file failed verification: {target}")
            pending.replace(target)


def verify_required(root: Path, manifest: dict[str, object]) -> None:
    required = manifest.get("required", [])
    runtime = manifest.get("runtime", {})
    if isinstance(runtime, dict):
        required = [*required, *(runtime.get("required", []) if isinstance(runtime.get("required", []), list) else [])]
    for value in required:
        path = contained(root, value, "required path")
        if not path.is_file() or path.stat().st_size <= 0:
            raise RuntimeError(f"Required Qwen Image runtime file is missing: {path}")


def install(project_root: Path, manifest_path: Path, cache: Path, offline: bool = False, verify_only: bool = False, jobs: int = 3) -> None:
    manifest = load_manifest(manifest_path)
    files = [record for record in manifest["files"] if isinstance(record, dict)]
    archives = [record for record in manifest["archives"] if isinstance(record, dict)]
    if not verify_only:
        cache.mkdir(parents=True, exist_ok=True)
    downloads: list[tuple[dict[str, object], Path]] = []
    for record in files:
        downloads.append((record, contained(project_root, record["path"], "file path")))
    for record in archives:
        downloads.append((record, cache / str(record["name"])))
    with ThreadPoolExecutor(max_workers=max(1, min(8, jobs))) as pool:
        futures = [pool.submit(download, record, target, offline, verify_only) for record, target in downloads]
        for future in futures:
            future.result()
    runtime = manifest.get("runtime", {})
    if not isinstance(runtime, dict):
        raise ValueError("Qwen Image runtime section must be an object")
    for record in archives:
        archive = cache / str(record["name"])
        extract_runtime(archive, project_root, runtime, verify_only)
    verify_required(project_root, manifest)
    print("QWEN_IMAGE_GGUF_READY (model not started)", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Download and verify Qwen Image 2.1 GGUF assets without starting inference.")
    parser.add_argument("--project-root", type=Path, default=ROOT, help="LumaFlow project root")
    parser.add_argument("--manifest", type=Path, help="Manifest path; defaults to config/qwen-image-gguf-manifest.json under project root")
    parser.add_argument("--cache", type=Path, help="Download cache directory; defaults to .local-data/downloads under project root")
    parser.add_argument("--offline", action="store_true", help="Use only complete local files and archives")
    parser.add_argument("--verify-only", action="store_true", help="Verify downloads and extracted runtime files without writing")
    parser.add_argument("--jobs", type=int, default=3, help="Concurrent downloads, from 1 to 8")
    args = parser.parse_args()
    if not 1 <= args.jobs <= 8:
        parser.error("--jobs must be between 1 and 8")
    project_root = args.project_root.expanduser().resolve()
    manifest_path = (args.manifest.expanduser() if args.manifest else project_root / DEFAULT_MANIFEST).resolve()
    cache = (args.cache.expanduser() if args.cache else project_root / ".local-data" / "downloads").resolve()
    install(project_root, manifest_path, cache, args.offline, args.verify_only, args.jobs)


if __name__ == "__main__":
    main()
