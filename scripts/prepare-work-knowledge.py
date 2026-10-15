#!/usr/bin/env python3
"""Prepare Octop's local ONNX knowledge-base backend.

The helper uses only Octop's authenticated HTTP API and Python's standard
library.  It downloads one public embedding model (the small Chinese BGE
model by default), probes it locally, enables the ONNX service, and then
enables the knowledge-base feature.  It never uploads documents or sends
private content to a model host.  JWTs and provider credentials stay in
memory and are omitted from the report.

The helper is intentionally separate from the feature acceptance script.  It
is an opt-in configuration operation, whereas acceptance must report an
unconfigured knowledge backend as pending.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
DATA_ROOT = ROOT / ".local-data" / "octop"
PRIVATE_CONFIG = DATA_ROOT / "lumaflow.json"
LOCAL_REPORT = DATA_ROOT / "logs" / "knowledge-preparation.json"
DEFAULT_MODEL = "BAAI/bge-small-zh-v1.5"

JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def safe_text(value: Any, limit: int = 800) -> str:
    text = str(value)
    text = JWT_RE.sub("<redacted-jwt>", text)
    text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._-]+", r"\1<redacted>", text)
    text = re.sub(r"(?i)([?&](?:token|access_token|api_key|key)=)[^&\s]+", r"\1<redacted>", text)
    return text[:limit]


def safe_json(value: Any, depth: int = 0) -> Any:
    if depth > 10:
        return "<depth-limit>"
    sensitive = ("token", "secret", "password", "api_key", "apikey", "authorization", "cookie")
    if isinstance(value, dict):
        return {
            str(key): "<redacted>"
            if any(part in str(key).lower() for part in sensitive)
            else safe_json(item, depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [safe_json(item, depth + 1) for item in value[:100]]
    if isinstance(value, str):
        return safe_text(value, 1200)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return safe_text(value)


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def issue_owner_jwt(state: dict[str, Any]) -> str | None:
    encoded = str(state.get("jwtSecret") or "").strip()
    username = str(state.get("ownerUsername") or "").strip()
    if not encoded or not username:
        return None
    try:
        if str(state.get("jwtSecretEncoding") or "base64").lower() == "base64":
            secret = base64.urlsafe_b64decode(encoded + "=" * ((4 - len(encoded) % 4) % 4))
        else:
            secret = encoded.encode("utf-8")
        owner_id = int(state["ownerId"])
    except (KeyError, TypeError, ValueError, base64.binascii.Error):
        return None
    now = int(time.time())
    header = b64url(b'{"alg":"HS256","typ":"JWT"}')
    payload = b64url(
        json.dumps(
            {"sub": str(owner_id), "uname": username, "role": "admin", "iat": now, "exp": now + 3600},
            separators=(",", ":"),
        ).encode("utf-8")
    )
    signed = f"{header}.{payload}".encode("ascii")
    return f"{header}.{payload}.{b64url(hmac.new(secret, signed, hashlib.sha256).digest())}"


class ApiError(RuntimeError):
    def __init__(self, method: str, path: str, status: int, detail: Any):
        self.method = method
        self.path = path
        self.status = status
        self.detail = safe_text(detail)
        super().__init__(f"{method} {path} returned HTTP {status}: {self.detail}")


class Client:
    def __init__(self, base_url: str, token: str, agent_id: str):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.agent_id = agent_id
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, method: str, path: str, body: Any = None, timeout: float = 45.0) -> Any:
        data = None
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self.token}"}
        if self.agent_id:
            headers["X-Agent-ID"] = self.agent_id
        if body is not None:
            data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                raw = response.read()
                if not raw:
                    return None
                try:
                    return json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    return raw[:4096].decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                detail: Any = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                detail = raw.decode("utf-8", errors="replace")
            raise ApiError(method, path, int(exc.code), detail) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ApiError(method, path, 0, type(exc).__name__ + ": " + safe_text(exc)) from None

    def get(self, path: str) -> Any:
        return self.request("GET", path)

    def post(self, path: str, body: Any) -> Any:
        return self.request("POST", path, body)

    def put(self, path: str, body: Any) -> Any:
        return self.request("PUT", path, body)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=ROOT, help="LumaFlow repository root")
    parser.add_argument("--base-url", default="", help="Octop API base URL; defaults to lumaflow.json")
    parser.add_argument("--model", default="", help="ONNX catalog ID; default preserves selected model or uses BGE small zh")
    parser.add_argument("--timeout", type=float, default=900.0, help="Maximum model download wait in seconds")
    parser.add_argument("--allow-model-change", action="store_true", help="Allow replacing an existing selected ONNX model")
    parser.add_argument("--allow-backend-change", action="store_true", help="Allow switching an enabled remote KB backend to ONNX")
    return parser.parse_args()


def write_report(report: dict[str, Any]) -> None:
    try:
        LOCAL_REPORT.parent.mkdir(parents=True, exist_ok=True)
        LOCAL_REPORT.write_text(json.dumps(safe_json(report), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass


def main() -> int:
    global ROOT, DATA_ROOT, PRIVATE_CONFIG, LOCAL_REPORT
    args = parse_args()
    ROOT = args.repo_root.resolve()
    DATA_ROOT = ROOT / ".local-data" / "octop"
    PRIVATE_CONFIG = DATA_ROOT / "lumaflow.json"
    LOCAL_REPORT = DATA_ROOT / "logs" / "knowledge-preparation.json"
    state = read_json(PRIVATE_CONFIG)
    base_url = str(args.base_url or state.get("baseUrl") or "http://127.0.0.1:8088").rstrip("/")
    ids = state.get("agentIds") if isinstance(state.get("agentIds"), dict) else {}
    agent_id = str(ids.get("work") or "")
    token = issue_owner_jwt(state)
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "octop-local-knowledge-preparation",
        "baseUrl": base_url,
        "modelInferenceCalled": False,
        "privateDocumentUploaded": False,
        "checks": [],
    }

    def check(name: str, status: str, evidence: Any = None, reason: str | None = None) -> None:
        row: dict[str, Any] = {"name": name, "status": status}
        if evidence is not None:
            row["evidence"] = safe_json(evidence)
        if reason:
            row["reason"] = safe_text(reason)
        report["checks"].append(row)

    if not token:
        check("owner-auth", "failed", reason="private lumaflow.json lacks a usable owner JWT secret")
        report["summary"] = {"passed": 0, "pendingConfiguration": 0, "failed": 1}
        write_report(report)
        print(str(LOCAL_REPORT))
        return 2

    client = Client(base_url, token, agent_id)
    try:
        capability = client.get("/api/knowledge-bases/capability")
        check("capability-before", "passed", capability)
        if not isinstance(capability, dict):
            raise RuntimeError("knowledge capability response is not an object")
        backend = str(capability.get("backend") or "onnx").lower()
        selected = str(capability.get("selected_model") or "").strip()
        if backend != "onnx" and capability.get("feature_enabled") and not args.allow_backend_change:
            check(
                "local-onnx-preparation",
                "pendingConfiguration",
                capability,
                "knowledge feature is enabled with a remote backend; rerun with --allow-backend-change to switch it",
            )
            report["summary"] = {"passed": 1, "pendingConfiguration": 1, "failed": 0}
            write_report(report)
            print(str(LOCAL_REPORT))
            return 0

        model = str(args.model or selected or DEFAULT_MODEL).strip()
        if selected and selected != model and not args.allow_model_change:
            model = selected
        options = client.get("/api/knowledge-bases/embedding-options?all_onnx=true")
        catalog = options.get("onnx") if isinstance(options, dict) else None
        catalog_ids = {
            str(item.get("id")) for item in catalog or () if isinstance(item, dict) and item.get("id")
        }
        if model not in catalog_ids:
            raise RuntimeError(f"model {model!r} is absent from the Octop ONNX catalog")
        check("catalog-model", "passed", {"model": model, "catalog_count": len(catalog_ids)})

        status = client.get("/api/onnx-models/status")
        downloaded = bool(status.get("downloaded")) if isinstance(status, dict) else False
        if not downloaded:
            started = client.post("/api/onnx-models/download", {"model": model})
            check("download-start", "passed", started)
            deadline = time.monotonic() + max(30.0, args.timeout)
            while time.monotonic() < deadline:
                status = client.get("/api/onnx-models/download-status")
                state_name = str(status.get("status") if isinstance(status, dict) else "")
                if state_name == "done":
                    break
                if state_name == "failed":
                    raise RuntimeError("ONNX download failed: " + safe_text(status))
                time.sleep(2.0)
            else:
                raise TimeoutError("ONNX download did not reach done before timeout")
        else:
            check("download-cache", "passed", {"downloaded": True, "model": model})

        probe = client.post("/api/onnx-models/test", {"model": model})
        if not isinstance(probe, dict) or not probe.get("ok"):
            raise RuntimeError("local ONNX probe failed: " + safe_text(probe))
        check("local-embedding-probe", "passed", probe)

        configured = client.put(
            "/api/onnx-models/config",
            {"enabled": True, "model": model, "download_if_missing": False},
        )
        check("onnx-service-enabled", "passed", configured)
        enabled = client.put(
            "/api/knowledge-bases/feature",
            {"enabled": True, "backend": "onnx", "model": model},
        )
        check("knowledge-feature-enabled", "passed", enabled)

        final_capability = client.get("/api/knowledge-bases/capability")
        final_status = client.get("/api/onnx-models/status")
        ready = (
            isinstance(final_capability, dict)
            and bool(final_capability.get("feature_enabled"))
            and bool(final_capability.get("usable"))
            and final_capability.get("selected_model") == model
            and bool((final_capability.get("checks") or {}).get("model_downloaded"))
            and bool((final_capability.get("checks") or {}).get("provider_ready") is False)
            and isinstance(final_status, dict)
            and bool(final_status.get("ready"))
        )
        if not ready:
            raise RuntimeError(
                "knowledge backend did not become ready: "
                + safe_text({"capability": final_capability, "onnx": final_status})
            )
        check("knowledge-ready-readback", "passed", {"capability": final_capability, "onnx": final_status})
        report["model"] = model
        report["summary"] = {"passed": len(report["checks"]), "pendingConfiguration": 0, "failed": 0}
        write_report(report)
        print(str(LOCAL_REPORT))
        return 0
    except Exception as exc:
        check("local-onnx-preparation", "failed", {"exception": type(exc).__name__}, safe_text(exc))
        report["summary"] = {
            "passed": sum(1 for row in report["checks"] if row.get("status") == "passed"),
            "pendingConfiguration": sum(1 for row in report["checks"] if row.get("status") == "pendingConfiguration"),
            "failed": 1,
        }
        write_report(report)
        print(str(LOCAL_REPORT))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
