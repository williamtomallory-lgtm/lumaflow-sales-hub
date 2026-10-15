#!/usr/bin/env python3
"""Install and verify an isolated OpenCode ACP runner for LumaFlow Work.

The script deliberately keeps the OpenCode executable and its npm metadata under
``.local-runtime/opencode``.  The generated OpenCode config and ACP launcher are
under ``.local-data/octop/acp``; both locations are ignored by the repository.
The LumaFlow gateway key is read only from ``.local-data/octop/lumaflow.json``
at process start and is never written to the OpenCode config or Octop Runner API.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from queue import Empty, Queue
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


PACKAGE_NAME = "opencode-ai"
OPENCODE_VERSION = "1.19.0"
NPM_REGISTRY = "https://registry.npmjs.org"
EXPECTED_INTEGRITY = (
    "sha512-lddJhFwZI3GLlw8VyOo4yNwBVGeVN/mxH6ORh60h69zAXL7QhjSWY9orj10rwO2kxVnxH9dh45uDCWNuiqPb8A=="
)
WORK_ENGINE_MODELS_PATH = "/api/v1/work-engine/models"
PREFERRED_RUNNER_NAME = "lumaflow-opencode-local"
RUNNER_ENV_LUMA_CONFIG = "LUMAFLOW_ACP_LUMA_CONFIG"
RUNNER_ENV_OPENCODE = "LUMAFLOW_ACP_OPENCODE"
RUNNER_ENV_KEY = "LUMAFLOW_GATEWAY_KEY"
RUNNER_ENV_CONFIG = "OPENCODE_CONFIG"
MODEL_PROVIDER = "lumaflow"
DEFAULT_MODEL_ID = "configured"


class SetupError(RuntimeError):
    """An actionable local setup or verification failure."""


def _repo_root(value: str | None) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SetupError(f"{label} is missing: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise SetupError(f"{label} could not be read: {path}") from exc
    if not isinstance(value, dict):
        raise SetupError(f"{label} must contain a JSON object: {path}")
    return value


def _write_json(path: Path, value: dict[str, Any], *, private: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    if private and os.name != "nt":
        path.chmod(0o600)


def _loopback_http_url(value: Any, label: str) -> str:
    raw = str(value or "").strip()
    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "http" or host not in {"127.0.0.1", "localhost", "::1"}:
        raise SetupError(f"{label} must be an HTTP loopback URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise SetupError(f"{label} must not contain credentials, query, or fragment")
    return raw.rstrip("/")


def _load_lumaflow(root: Path) -> tuple[dict[str, Any], Path]:
    path = root / ".local-data" / "octop" / "lumaflow.json"
    config = _read_json(path, "private LumaFlow metadata")
    _loopback_http_url(config.get("baseUrl"), "Octop baseUrl")
    gateway = _loopback_http_url(config.get("gatewayBaseUrl"), "LumaFlow gatewayBaseUrl")
    if not gateway.endswith(WORK_ENGINE_MODELS_PATH):
        raise SetupError(
            f"gatewayBaseUrl must end with {WORK_ENGINE_MODELS_PATH}; the OpenAI-compatible route is required"
        )
    key = str(config.get("gatewayKey") or "").strip()
    if len(key) < 32:
        raise SetupError("private LumaFlow metadata has no usable gateway key")
    secret = str(config.get("jwtSecret") or "").strip()
    if len(secret) < 32:
        raise SetupError("private LumaFlow metadata has no usable JWT secret")
    if not str(config.get("ownerId") or "").strip().isdigit():
        raise SetupError("private LumaFlow metadata has no numeric ownerId")
    if not str(config.get("ownerUsername") or "").strip():
        raise SetupError("private LumaFlow metadata has no ownerUsername")
    return config, path


def _npm_executable() -> str:
    names = ("npm.cmd", "npm") if os.name == "nt" else ("npm",)
    for name in names:
        found = shutil.which(name)
        if found:
            return str(Path(found).resolve())
    raise SetupError("npm was not found; install Node.js without changing the global OpenCode installation")


def _node_executable() -> str:
    names = ("node.exe", "node") if os.name == "nt" else ("node",)
    for name in names:
        found = shutil.which(name)
        if found:
            return str(Path(found).resolve())
    raise SetupError("node was not found; install Node.js without changing the global OpenCode installation")


def _run_checked(command: list[str], *, cwd: Path, timeout: int = 300) -> None:
    try:
        completed = subprocess.run(command, cwd=cwd, check=False, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SetupError(f"command could not complete: {Path(command[0]).name}") from exc
    if completed.returncode != 0:
        raise SetupError(f"command failed with exit code {completed.returncode}: {Path(command[0]).name}")


def _runtime_paths(root: Path) -> tuple[Path, Path]:
    runtime = root / ".local-runtime" / "opencode"
    package_root = runtime / "node_modules" / PACKAGE_NAME
    candidates = (package_root / "bin" / "opencode.exe", package_root / "bin" / "opencode")
    for candidate in candidates:
        if candidate.is_file():
            return runtime, candidate.resolve()
    raise SetupError(
        "isolated OpenCode executable is missing; run setup first or remove only the generated .local-runtime/opencode directory"
    )


def _install_opencode(root: Path) -> tuple[Path, Path]:
    runtime = root / ".local-runtime" / "opencode"
    runtime.mkdir(parents=True, exist_ok=True)
    package_manifest = {
        "name": "lumaflow-opencode-runtime",
        "version": "0.0.0",
        "private": True,
        "dependencies": {PACKAGE_NAME: OPENCODE_VERSION},
    }
    _write_json(runtime / "package.json", package_manifest, private=False)
    npm = _npm_executable()
    _run_checked(
        [
            npm,
            "install",
            "--prefix",
            str(runtime),
            "--registry",
            NPM_REGISTRY,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--save-exact",
            f"{PACKAGE_NAME}@{OPENCODE_VERSION}",
        ],
        cwd=root,
    )
    # opencode-ai intentionally ships a tiny diagnostic placeholder until its
    # package postinstall selects the platform binary.  Keep npm lifecycle
    # scripts disabled during install, then run only this pinned package's
    # postinstall directly with an absolute node executable.  This preserves
    # the isolated runtime while avoiding a shell, npm-global state, or a
    # project-wide lifecycle hook.
    node = _node_executable()
    postinstall = runtime / "node_modules" / PACKAGE_NAME / "postinstall.mjs"
    _run_checked([node, str(postinstall)], cwd=postinstall.parent, timeout=180)
    lock = _read_json(runtime / "package-lock.json", "isolated OpenCode package lock")
    entry = lock.get("packages", {}).get(f"node_modules/{PACKAGE_NAME}")
    if not isinstance(entry, dict) or entry.get("version") != OPENCODE_VERSION:
        raise SetupError("isolated OpenCode lock does not contain the pinned version")
    if entry.get("integrity") != EXPECTED_INTEGRITY:
        raise SetupError("isolated OpenCode tarball integrity does not match official npm metadata")
    resolved = str(entry.get("resolved") or "")
    if not resolved.startswith(f"{NPM_REGISTRY}/{PACKAGE_NAME}/"):
        raise SetupError("isolated OpenCode lock resolved outside the official npm registry")
    return _runtime_paths(root)


def _model_catalog(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    catalog = config.get("modelCatalog")
    result: dict[str, dict[str, Any]] = {}
    if isinstance(catalog, list):
        for entry in catalog:
            if not isinstance(entry, dict):
                continue
            model_id = str(entry.get("id") or "").strip()
            if not model_id:
                continue
            try:
                context_window = int(entry.get("contextWindow") or 0)
                max_output_tokens = int(entry.get("maxOutputTokens") or 0)
            except (TypeError, ValueError):
                continue
            if context_window <= 0 or max_output_tokens <= 0:
                continue
            result[model_id] = {
                "name": str(entry.get("name") or model_id),
                "contextWindow": context_window,
                "maxOutputTokens": max_output_tokens,
            }
    # The Bonsai route is the safe built-in fallback even when older private
    # metadata has no catalog or still records a removed experimental default.
    result.setdefault(
        DEFAULT_MODEL_ID,
        {
            "name": "Ternary Bonsai 2 27B（LumaFlow 网关）",
            "contextWindow": 16384,
            "maxOutputTokens": 2048,
        },
    )
    return result


def _select_model_id(
    lumaflow: dict[str, Any],
    models: dict[str, dict[str, Any]],
    requested_model: str | None = None,
) -> str:
    requested = str(requested_model or "").strip()
    if requested:
        if requested not in models:
            raise SetupError(
                f"selected local model {requested!r} is not present in the LumaFlow model catalog"
            )
        return requested
    # Older private state may retain a removed model in workModelId.  Treat
    # that stale preference as absent; only an explicit CLI selection is an
    # error when it is not in the current catalog.
    configured = str(lumaflow.get("workModelId") or "").strip()
    if configured in models:
        return configured
    if DEFAULT_MODEL_ID not in models:
        raise SetupError(
            "the configured Bonsai model is not present in the LumaFlow model catalog"
        )
    return DEFAULT_MODEL_ID


def _model_ref(model_id: str) -> str:
    return f"{MODEL_PROVIDER}/{model_id}"


def _write_opencode_config(
    root: Path,
    lumaflow: dict[str, Any],
    data_root: Path,
    *,
    selected_model_id: str = DEFAULT_MODEL_ID,
) -> Path:
    models = _model_catalog(lumaflow)
    selected_model_id = _select_model_id(lumaflow, models, selected_model_id)
    provider_models: dict[str, dict[str, Any]] = {}
    for model_id, item in models.items():
        provider_models[model_id] = {
            "name": item["name"],
            "limit": {
                "context": item["contextWindow"],
                "output": item["maxOutputTokens"],
            },
        }
    config = {
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": False,
        "share": "disabled",
        # Keep the provider allowlist local-only.  OpenCode must not discover
        # or silently fall back to a cloud provider when an optional model is
        # unavailable.
        "enabled_providers": [MODEL_PROVIDER],
        "model": _model_ref(selected_model_id),
        "small_model": _model_ref(selected_model_id),
        "provider": {
            MODEL_PROVIDER: {
                "npm": "@ai-sdk/openai-compatible",
                "name": "LumaFlow 本地模型网关",
                "options": {
                    "baseURL": str(lumaflow["gatewayBaseUrl"]).rstrip("/"),
                    "apiKey": "{env:LUMAFLOW_GATEWAY_KEY}",
                },
                "models": provider_models,
            }
        },
    }
    path = data_root / "opencode.json"
    _write_json(path, config)
    return path


def _write_acp_wrapper(data_root: Path) -> Path:
    path = data_root / "run-opencode-acp.py"
    content = '''#!/usr/bin/env python3
"""Private ACP launcher generated by setup-work-coding-agent.py."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess


def main() -> None:
    metadata_path = Path(os.environ["LUMAFLOW_ACP_LUMA_CONFIG"])
    opencode_path = Path(os.environ["LUMAFLOW_ACP_OPENCODE"])
    config_path = Path(os.environ["OPENCODE_CONFIG"])
    with metadata_path.open("r", encoding="utf-8") as stream:
        metadata = json.load(stream)
    gateway_key = str(metadata.get("gatewayKey") or "").strip()
    if len(gateway_key) < 32:
        raise SystemExit("private LumaFlow gateway key is unavailable")
    if not opencode_path.is_file() or not config_path.is_file():
        raise SystemExit("generated OpenCode runtime or config is unavailable")
    env = os.environ.copy()
    env["OPENCODE_CONFIG"] = str(config_path)
    env["LUMAFLOW_GATEWAY_KEY"] = gateway_key
    completed = subprocess.run(
        [str(opencode_path), "acp"],
        env=env,
        check=False,
    )
    raise SystemExit(completed.returncode)


if __name__ == "__main__":
    main()
'''
    data_root.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")
    if os.name != "nt":
        path.chmod(0o700)
    return path


def _jwt_secret(lumaflow: dict[str, Any]) -> bytes:
    raw = str(lumaflow["jwtSecret"])
    if lumaflow.get("jwtSecretEncoding", "utf8") == "base64":
        padded = raw + "=" * (-len(raw) % 4)
        try:
            return base64.urlsafe_b64decode(padded.encode("ascii"))
        except (ValueError, UnicodeEncodeError) as exc:
            raise SetupError("private JWT secret encoding is invalid") from exc
    return raw.encode("utf-8")


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _owner_jwt(lumaflow: dict[str, Any], ttl_seconds: int = 300) -> str:
    now = int(time.time())
    header = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = _b64(
        json.dumps(
            {
                "sub": str(lumaflow["ownerId"]),
                "uname": str(lumaflow["ownerUsername"]),
                "role": "admin",
                "iat": now,
                "exp": now + ttl_seconds,
            },
            separators=(",", ":"),
        ).encode()
    )
    signed = f"{header}.{payload}".encode("ascii")
    signature = _b64(hmac.new(_jwt_secret(lumaflow), signed, hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"


def _http_json(
    url: str,
    *,
    method: str = "GET",
    token: str | None = None,
    gateway_key: str | None = None,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if gateway_key:
        headers["Authorization"] = f"Bearer {gateway_key}"
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    try:
        with urlopen(Request(url, data=data, headers=headers, method=method), timeout=8) as response:
            raw = response.read()
    except HTTPError as exc:
        raise SetupError(f"local API returned HTTP {exc.code}: {method} {urlparse(url).path}") from exc
    except (OSError, URLError) as exc:
        raise SetupError(f"local API is unavailable: {urlparse(url).netloc}") from exc
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SetupError(f"local API returned invalid JSON: {urlparse(url).path}") from exc
    if not isinstance(value, dict):
        raise SetupError(f"local API returned an unexpected payload: {urlparse(url).path}")
    return value


def _probe_gateway(lumaflow: dict[str, Any], selected_model_id: str = DEFAULT_MODEL_ID) -> list[str]:
    payload = _http_json(str(lumaflow["gatewayBaseUrl"]).rstrip("/"), gateway_key=str(lumaflow["gatewayKey"]))
    raw_models = payload.get("data")
    if not isinstance(raw_models, list):
        raise SetupError("LumaFlow model gateway did not return an OpenAI-compatible model list")
    ids = [str(item.get("id")) for item in raw_models if isinstance(item, dict) and item.get("id")]
    required = {DEFAULT_MODEL_ID, selected_model_id}
    if not required.issubset(ids):
        missing = ", ".join(sorted(required.difference(ids)))
        raise SetupError(f"LumaFlow model gateway does not expose selected local model(s): {missing}")
    return ids


def _runner_spec(executable: Path, wrapper: Path, lumaflow_path: Path, config_path: Path) -> dict[str, Any]:
    return {
        "enabled": True,
        "command": str(Path(sys.executable).resolve()),
        "args": [str(wrapper.resolve())],
        "env": {
            RUNNER_ENV_LUMA_CONFIG: str(lumaflow_path.resolve()),
            RUNNER_ENV_OPENCODE: str(executable.resolve()),
            RUNNER_ENV_CONFIG: str(config_path.resolve()),
        },
        "trusted": True,
        "tool_parse_mode": "update_detail",
        "stdio_buffer_limit_bytes": 52428800,
    }


def _runner_equal(actual: Any, desired: dict[str, Any]) -> bool:
    if not isinstance(actual, dict):
        return False
    keys = ("enabled", "command", "args", "env", "trusted", "tool_parse_mode", "stdio_buffer_limit_bytes")
    return all(actual.get(key) == desired.get(key) for key in keys)


def _register_runner(
    lumaflow: dict[str, Any],
    *,
    executable: Path,
    wrapper: Path,
    lumaflow_path: Path,
    config_path: Path,
) -> tuple[str, str]:
    base_url = _loopback_http_url(lumaflow["baseUrl"], "Octop baseUrl")
    token = _owner_jwt(lumaflow)
    current = _http_json(f"{base_url}/api/acp", token=token)
    runners = current.get("runners")
    if not isinstance(runners, dict):
        raise SetupError("Octop ACP API returned no runner map")
    desired = _runner_spec(executable, wrapper, lumaflow_path, config_path)
    name = PREFERRED_RUNNER_NAME
    if name in runners and not _runner_equal(runners[name], desired):
        index = 2
        while True:
            candidate = f"{PREFERRED_RUNNER_NAME}-{index}"
            if candidate not in runners:
                name = candidate
                break
            if _runner_equal(runners[candidate], desired):
                return candidate, "already-configured"
            index += 1
    if name in runners and _runner_equal(runners[name], desired):
        return name, "already-configured"
    _http_json(f"{base_url}/api/acp/{name}", method="PUT", token=token, body=desired)
    return name, "registered"


def _verification_env(root: Path, lumaflow: dict[str, Any], lumaflow_path: Path, config_path: Path) -> dict[str, str]:
    env = os.environ.copy()
    env[RUNNER_ENV_CONFIG] = str(config_path.resolve())
    env[RUNNER_ENV_KEY] = str(lumaflow["gatewayKey"])
    env["LUMAFLOW_ACP_LUMA_CONFIG"] = str(lumaflow_path.resolve())
    env["LUMAFLOW_ACP_ROOT"] = str(root.resolve())
    return env


def _verify_config(config_path: Path) -> dict[str, Any]:
    config = _read_json(config_path, "generated OpenCode config")
    if config.get("autoupdate") is not False or config.get("share") != "disabled":
        raise SetupError("OpenCode config does not disable autoupdate and sharing")
    if config.get("enabled_providers") != ["lumaflow"]:
        raise SetupError("OpenCode config allows a provider other than lumaflow")
    provider = config.get("provider", {}).get(MODEL_PROVIDER)
    if not isinstance(provider, dict) or provider.get("npm") != "@ai-sdk/openai-compatible":
        raise SetupError("OpenCode config does not use the OpenAI-compatible LumaFlow provider")
    options = provider.get("options")
    if not isinstance(options, dict) or options.get("apiKey") != "{env:LUMAFLOW_GATEWAY_KEY}":
        raise SetupError("OpenCode config does not use the private gateway-key environment placeholder")
    models = provider.get("models")
    if not isinstance(models, dict) or DEFAULT_MODEL_ID not in models:
        raise SetupError("OpenCode config is missing the configured Bonsai model")
    selected = config.get("model")
    small = config.get("small_model")
    prefix = MODEL_PROVIDER + "/"
    if not isinstance(selected, str) or not selected.startswith(prefix):
        raise SetupError("OpenCode default model is not a model from the local LumaFlow provider")
    if not isinstance(small, str) or not small.startswith(prefix):
        raise SetupError("OpenCode small model is not a model from the local LumaFlow provider")
    selected_id = selected[len(prefix) :]
    small_id = small[len(prefix) :]
    if not selected_id or selected_id not in models:
        raise SetupError("OpenCode selected model is absent from the provider catalog")
    if not small_id or small_id not in models:
        raise SetupError("OpenCode small model is absent from the provider catalog")
    return config


def _version(executable: Path, env: dict[str, str], root: Path) -> str:
    try:
        result = subprocess.run(
            [str(executable), "--version"],
            cwd=root,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SetupError("OpenCode --version could not complete") from exc
    if result.returncode != 0:
        raise SetupError("OpenCode --version failed")
    value = (result.stdout or result.stderr).strip().splitlines()
    if not value:
        raise SetupError("OpenCode --version returned no version")
    return value[0].strip()


def _read_json_line(queue: Queue[str], timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    for _ in range(24):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            line = queue.get(timeout=remaining)
        except Empty:
            break
        if not line:
            break
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise SetupError("OpenCode ACP initialize returned no JSON-RPC response")


def _acp_initialize(executable: Path, env: dict[str, str], root: Path) -> dict[str, Any]:
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
            "clientInfo": {"name": "lumaflow-work-verifier", "version": "1.0.0"},
        },
    }
    try:
        process = subprocess.Popen(
            [str(executable), "acp"],
            cwd=root,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError as exc:
        raise SetupError("OpenCode ACP process could not start") from exc
    assert process.stdin is not None and process.stdout is not None
    queue: Queue[str] = Queue()

    def read_output() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            queue.put(line.strip())
        queue.put("")

    thread = threading.Thread(target=read_output, daemon=True)
    thread.start()
    try:
        process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
        process.stdin.flush()
        response = _read_json_line(queue, 30.0)
        if response.get("id") != 1 or not isinstance(response.get("result"), dict):
            raise SetupError("OpenCode ACP initialize returned an error")
        process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}) + "\n")
        process.stdin.flush()
        return response["result"]
    except (OSError, BrokenPipeError) as exc:
        raise SetupError("OpenCode ACP initialize pipe closed") from exc
    finally:
        try:
            process.terminate()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            process.kill()
            process.wait(timeout=5)


def _setup(args: argparse.Namespace) -> int:
    root = _repo_root(args.repo_root)
    lumaflow, lumaflow_path = _load_lumaflow(root)
    runtime, executable = _install_opencode(root) if not args.skip_install else _runtime_paths(root)
    data_root = root / ".local-data" / "octop" / "acp"
    models = _model_catalog(lumaflow)
    selected_model_id = _select_model_id(lumaflow, models, args.model)
    config_path = _write_opencode_config(
        root,
        lumaflow,
        data_root,
        selected_model_id=selected_model_id,
    )
    wrapper = _write_acp_wrapper(data_root)
    result: dict[str, Any] = {
        "runtime": str(runtime),
        "executable": str(executable),
        "version": OPENCODE_VERSION,
        "config": str(config_path),
        "wrapper": str(wrapper),
        "provider": MODEL_PROVIDER,
        "selectedModel": selected_model_id,
        "models": sorted(models),
    }
    if args.probe_gateway:
        result["gatewayModels"] = _probe_gateway(lumaflow, selected_model_id)
    if not args.no_register:
        name, status = _register_runner(
            lumaflow,
            executable=executable,
            wrapper=wrapper,
            lumaflow_path=lumaflow_path,
            config_path=config_path,
        )
        result["runner"] = {"name": name, "status": status}
    else:
        result["runner"] = {"status": "not-registered"}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def _verify(args: argparse.Namespace) -> int:
    root = _repo_root(args.repo_root)
    lumaflow, lumaflow_path = _load_lumaflow(root)
    _runtime, executable = _runtime_paths(root)
    config_path = root / ".local-data" / "octop" / "acp" / "opencode.json"
    config = _verify_config(config_path)
    env = _verification_env(root, lumaflow, lumaflow_path, config_path)
    selected_model_id = str(config["model"])[len(MODEL_PROVIDER) + 1 :]
    if args.model and args.model.strip() != selected_model_id:
        raise SetupError(
            f"generated OpenCode config selects {selected_model_id!r}, not the requested {args.model.strip()!r}"
        )
    result: dict[str, Any] = {
        "executable": str(executable),
        "version": _version(executable, env, root),
        "acpInitialize": _acp_initialize(executable, env, root),
        "provider": MODEL_PROVIDER,
        "selectedModel": selected_model_id,
        "models": sorted(config["provider"][MODEL_PROVIDER]["models"]),
        "gatewayProbe": "skipped",
    }
    if args.probe_gateway:
        result["gatewayModels"] = _probe_gateway(lumaflow, result["selectedModel"])
        result["gatewayProbe"] = "passed"
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("setup", "verify"), nargs="?", default="setup")
    parser.add_argument("--repo-root", help="LumaFlow repository root; defaults to the current script's parent")
    parser.add_argument("--skip-install", action="store_true", help="reuse the existing isolated OpenCode runtime")
    parser.add_argument("--no-register", action="store_true", help="write local assets without calling Octop /api/acp")
    parser.add_argument("--probe-gateway", action="store_true", help="call the local model-list endpoint using the private key")
    parser.add_argument(
        "--model",
        help="select a model ID from the private local model catalog; defaults to configured Bonsai",
    )
    args = parser.parse_args()
    try:
        return _setup(args) if args.command == "setup" else _verify(args)
    except SetupError as exc:
        print(f"work coding agent setup failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
