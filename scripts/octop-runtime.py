#!/usr/bin/env python3
"""Install, initialise, and run the isolated Octop instance used by LumaFlow.

This module deliberately uses only the Python standard library.  It is used
before Octop is installed, and it must also be usable from a Windows
PowerShell launcher.  The instance is scoped by ``OCTOP_HOME`` to
``.local-data/octop``; it never falls back to the user's normal ``~/.octop``.

The setup path is idempotent and conservative:

* an existing database, credential file, provider, agent, or team is never
  deleted;
* an existing running service is inspected and reused rather than killed;
* only a child process started by this script is terminated during the
  temporary bootstrap server;
* secrets are written to ignored files and are never printed.

The optional API bootstrap creates full and read-only OpenAI-compatible
providers, three Work roles, and one native Octop team.  The managed default
route is the configured Ternary Bonsai 2 27B model.  The LumaFlow gateway
performs model leasing and applies a server-side tool policy to the read-only
provider key; unrelated models already present in a provider are preserved.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOT = REPO_ROOT / ".local-runtime" / "octop"
DATA_ROOT = REPO_ROOT / ".local-data" / "octop"
VENV_ROOT = RUNTIME_ROOT / "venv"
OWNER_FILE = DATA_ROOT / "owner-credentials.json"
LUMAFLOW_FILE = DATA_ROOT / "lumaflow.json"
CONFIG_FILE = DATA_ROOT / "config.json"
PID_FILE = DATA_ROOT / "octop.pid"
LOG_FILE = DATA_ROOT / "logs" / "octop-launch.log"
INSTALL_MARKER = RUNTIME_ROOT / "install.json"

UPSTREAM_URL = "https://github.com/TencentCloud/Octop.git"
UPSTREAM_REF = "664c1fb38e354ea987041aa14b151e20d15ce71f"
OCTOP_VERSION = "1.0.2b7"
OCTOP_HOST = "127.0.0.1"
OCTOP_PORT = 8088
LUMAFLOW_BASE_URL = "http://127.0.0.1:3000/api/v1/work-engine/models"
OCTOP_BASE_URL = f"http://{OCTOP_HOST}:{OCTOP_PORT}"
PROVIDER_NAME = "configured"
BONSAI_MODEL_ID = "configured"
BONSAI_MODEL_REF = f"{PROVIDER_NAME}/{BONSAI_MODEL_ID}"
READ_ONLY_PROVIDER_NAME = "configured-readonly"
READ_ONLY_BONSAI_MODEL_REF = f"{READ_ONLY_PROVIDER_NAME}/{BONSAI_MODEL_ID}"

# These are the exact identifiers emitted by an earlier bootstrap revision.
# They are retained only so a later run can migrate the managed roles and
# provider entries.  A model with the same id but a user-edited name is left
# alone rather than guessed to be ours.
LEGACY_STRATA_MODEL_ID = "local:strata-coder"
LEGACY_STRATA_MODEL_NAMES = frozenset(
    {
        "Strata Coder（LumaFlow 网关）",
        "Qwen3.8 Flash Next Coder · Strata",
    }
)
LEGACY_MODEL_REFS = frozenset(
    {
        f"{PROVIDER_NAME}/{LEGACY_STRATA_MODEL_ID}",
        f"{READ_ONLY_PROVIDER_NAME}/{LEGACY_STRATA_MODEL_ID}",
        f"lumaflow/{LEGACY_STRATA_MODEL_ID}",
    }
)

FULL_PROVIDER_NOTE = "LumaFlow Work gateway; model selection remains in LumaFlow."
READ_ONLY_PROVIDER_NOTE = (
    "LumaFlow Work gateway; read-only model lease for research and verification agents."
)

# The local Bonsai service is configured by the LumaFlow application rather
# than by Octop.  Keep this as a conservative project baseline only when the
# deployment has not made LLM_* available to this process; the resolver below
# first reads the live environment and the checked-in dotenv locations.
# The checked-in Windows launcher starts the measured Bonsai build with a
# 16K context.  Keep bootstrap metadata inside that real budget when the
# application environment does not provide explicit values; never advertise
# the earlier 32K/8K placeholder to Octop.
BONSAI_CONTEXT_FALLBACK = 16_384
BONSAI_OUTPUT_FALLBACK = 4_096
# The launcher and gateway currently expose this Bonsai build at these
# measured ceilings.  A stale inherited .env value above them is ignored so
# Octop cannot send a request budget the local llama-server will reject.
BONSAI_CONTEXT_MAX = 16_384
BONSAI_OUTPUT_MAX = 4_096

# Octop's harness cannot disable the critical read tools, but it does expose a
# real denylist for mutating/external tools.  These names are the upstream
# built-in catalog at the pinned Octop revision.  The list is applied only to
# the two bootstrap read-only roles, never to an unrelated user agent.
READ_ONLY_DISABLED_TOOLS = frozenset(
    {
        "write_file",
        "edit_file",
        "delete",
        "execute",
        "write_env_file",
        "browser_use",
        "desktop_screenshot",
        "send_file_to_user",
        "ask_agent",
        "generate_image",
        "generate_video",
        "acp_runner",
        "agent_list",
        "cronjob_create",
        "cronjob_update",
        "cronjob_delete",
        "cronjob_run_now",
        "mobile_tap",
        "mobile_swipe",
        "mobile_launch_app",
        "mobile_handoff_to_user",
        "read_env_file",
    }
)


class RuntimeErrorMessage(RuntimeError):
    """An actionable setup error that should be shown without a traceback."""


@dataclass(frozen=True)
class Paths:
    repo: Path = REPO_ROOT
    runtime: Path = RUNTIME_ROOT
    data: Path = DATA_ROOT
    venv: Path = VENV_ROOT
    owner: Path = OWNER_FILE
    lumaflow: Path = LUMAFLOW_FILE
    config: Path = CONFIG_FILE
    pid: Path = PID_FILE
    log: Path = LOG_FILE
    marker: Path = INSTALL_MARKER


PATHS = Paths()


def die(message: str) -> NoReturn:
    raise RuntimeErrorMessage(message)


def network_env() -> dict[str, str]:
    """Return a child-process environment without stale proxy settings.

    Some managed Windows hosts retain an old local proxy in the parent
    process.  Removing it only for Git/uv/pip children lets direct HTTPS work
    without changing the user's shell or machine-wide environment.
    """
    env = os.environ.copy()
    proxy_names = {"http_proxy", "https_proxy", "all_proxy"}
    for name in list(env):
        if name.lower() in proxy_names:
            env.pop(name, None)
    return env


def atomic_json_write(path: Path, payload: dict[str, Any], *, private: bool = False) -> None:
    """Write JSON atomically, creating the parent but never exposing a secret in output."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    temporary.write_text(data, encoding="utf-8", newline="\n")
    if private:
        _best_effort_private(temporary)
    os.replace(temporary, path)
    if private:
        _best_effort_private(path)


def _best_effort_private(path: Path) -> None:
    """Best-effort POSIX mode tightening; Windows access is inherited from the user."""
    try:
        path.chmod(0o600)
    except OSError:
        pass


def read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        die(f"无法读取 {path}: {exc}")
    if not isinstance(value, dict):
        die(f"配置文件必须是 JSON 对象: {path}")
    return value


def python_version(executable: Path) -> tuple[int, int]:
    result = subprocess.run(
        [str(executable), "-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return (0, 0)
    try:
        major, minor = result.stdout.strip().split(".", 1)
        return int(major), int(minor)
    except (ValueError, TypeError):
        return (0, 0)


def choose_base_python() -> Path:
    """Choose a >=3.12 interpreter without relying on a shell-specific lookup."""
    current = Path(sys.executable).resolve()
    if python_version(current) >= (3, 12):
        return current
    launcher = shutil.which("py")
    if launcher:
        for minor in (12, 13, 14, 15):
            probe = subprocess.run(
                [launcher, f"-3.{minor}", "-c", "import sys; print(sys.executable)"],
                check=False,
                capture_output=True,
                text=True,
            )
            if probe.returncode == 0:
                candidate = Path(probe.stdout.strip()).resolve()
                if python_version(candidate) >= (3, 12):
                    return candidate
    die("Octop 需要 Python 3.12 或更高版本；请安装 Python 3.12+ 后重试。")


def venv_python() -> Path:
    if os.name == "nt":
        return PATHS.venv / "Scripts" / "python.exe"
    return PATHS.venv / "bin" / "python"


def find_uv(requested: str | None = None) -> str | None:
    """Return uv, preferring the runtime-local copy used by remote hosts.

    The target Windows computer is deliberately not required to have uv on
    ``PATH``.  The parent launcher may place a verified standalone binary at
    ``.local-runtime/tools/uv.exe`` or pass an explicit path with ``--uv``.
    """
    candidates: list[Path] = []
    if requested:
        candidates.append(Path(requested).expanduser())
    candidates.append(
        PATHS.repo
        / ".local-runtime"
        / "tools"
        / ("uv.exe" if os.name == "nt" else "uv")
    )
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate.resolve())
    return shutil.which("uv")


def materialize_upstream_source(source: str, ref: str, *, offline: bool) -> Path | None:
    """Resolve a Git URL to a local pinned checkout when Git is available."""
    candidate = Path(source).expanduser()
    if candidate.is_dir():
        return candidate.resolve()
    if offline:
        die("--offline 只支持本地 Octop 源码目录；请传入 --source <目录>。")
    git = shutil.which("git")
    if not git:
        return None
    checkout = PATHS.runtime / "source" / ref[:16]
    if checkout.is_dir() and (checkout / "pyproject.toml").is_file():
        current = subprocess.run(
            [git, "-C", str(checkout), "rev-parse", "HEAD"],
            check=False,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if current == ref:
            return checkout
    checkout.parent.mkdir(parents=True, exist_ok=True)
    if checkout.exists():
        if not checkout.is_dir():
            die(f"Octop source path is not a directory: {checkout}")
        shutil.rmtree(checkout)
    env = network_env()
    subprocess.run([git, "clone", "--quiet", source, str(checkout)], check=True, env=env)
    subprocess.run(
        [git, "-C", str(checkout), "checkout", "--quiet", "--detach", ref],
        check=True,
        env=env,
    )
    return checkout


def ensure_venv(base_python: Path) -> Path:
    executable = venv_python()
    if executable.is_file() and python_version(executable) >= (3, 12):
        return executable
    PATHS.runtime.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(base_python), "-m", "venv", str(PATHS.venv)], check=True)
    if not executable.is_file():
        die(f"创建 Python 虚拟环境失败: {executable}")
    return executable


def ensure_dashboard_assets(
    source: Path,
    python: Path,
    *,
    offline: bool,
) -> str:
    """Make the compiled dashboard available to a source checkout.

    The Git checkout intentionally does not contain generated Vite output;
    the release wheel does.  Reusing the pinned release wheel keeps the
    source install reproducible on hosts without Node.js and avoids silently
    shipping an API-only Octop instance.
    """
    dashboard = source / "src" / "octop" / "dashboard"
    if (dashboard / "index.html").is_file():
        return "source"
    wheel_dir = PATHS.runtime / "wheel-cache"
    wheel_dir.mkdir(parents=True, exist_ok=True)
    wheel = next(iter(sorted(wheel_dir.glob(f"octop-{OCTOP_VERSION}-*.whl"))), None)
    if wheel is None:
        if offline:
            return "missing-offline"
        subprocess.run(
            [
                str(python),
                "-m",
                "pip",
                "download",
                "--disable-pip-version-check",
                "--no-deps",
                "--only-binary=:all:",
                "--dest",
                str(wheel_dir),
                f"octop=={OCTOP_VERSION}",
            ],
            check=True,
            env=network_env(),
        )
        wheel = next(iter(sorted(wheel_dir.glob(f"octop-{OCTOP_VERSION}-*.whl"))), None)
    if wheel is None:
        return "missing-wheel"
    dashboard.mkdir(parents=True, exist_ok=True)
    prefix = "octop/dashboard/"
    with zipfile.ZipFile(wheel) as archive:
        names = [name for name in archive.namelist() if name.startswith(prefix)]
        if not names or "octop/dashboard/index.html" not in names:
            return "wheel-without-dashboard"
        root = dashboard.resolve()
        for name in names:
            relative = Path(name[len(prefix) :])
            if not relative.parts or ".." in relative.parts:
                continue
            destination = (root / relative).resolve()
            try:
                destination.relative_to(root)
            except ValueError:
                continue
            if name.endswith("/"):
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(name) as input_stream, destination.open("wb") as output_stream:
                shutil.copyfileobj(input_stream, output_stream)
    return "wheel"


def install_octop(
    python: Path,
    *,
    source: str,
    ref: str,
    offline: bool,
    uv_path: str | None,
    local_embedding: bool,
) -> None:
    """Install the pinned upstream checkout or VCS revision into our venv."""
    expanded = materialize_upstream_source(source, ref, offline=offline)
    uv = find_uv(uv_path)
    resolved_source = str(expanded.resolve()) if expanded is not None else None
    dashboard_status = "wheel"
    extras = ["desktop", "knowledge-ocr"]
    if local_embedding:
        extras.append("local-embedding")
    if expanded is not None and uv and (expanded / "uv.lock").is_file():
        # Use the upstream lock so broad extras do not trigger pip's long
        # boto3/aiobotocore backtracking.  Install the project itself without
        # dependency resolution after the locked requirements are present.
        requirements = PATHS.runtime / "octop-requirements.txt"
        export = [
            uv,
            "export",
            "--project",
            str(expanded),
            "--frozen",
            "--no-dev",
        ]
        for extra in extras:
            export.extend(["--extra", extra])
        export.extend([
            "--format",
            "requirements.txt",
            "--no-emit-project",
            "--output-file",
            str(requirements),
        ])
        # The exported file contains thousands of hashes; keep setup output
        # readable while retaining stderr on failure.
        subprocess.run(export, check=True, env=network_env(), stdout=subprocess.DEVNULL)
        install_requirements = [
            uv,
            "pip",
            "install",
            "--python",
            str(python),
            "-r",
            str(requirements),
        ]
        if offline:
            install_requirements.insert(3, "--offline")
        subprocess.run(install_requirements, check=True, env=network_env())
        dashboard_status = ensure_dashboard_assets(expanded, python, offline=offline)
        subprocess.run(
            [
                uv,
                "pip",
                "install",
                "--python",
                str(python),
                "--no-deps",
                "--editable",
                str(expanded),
            ],
            check=True,
            env=network_env(),
        )
    else:
        # Compatibility path for a host without uv or Git.
        extra_spec = ",".join(extras)
        package = (
            str(expanded) + f"[{extra_spec}]"
            if expanded is not None
            else f"octop[{extra_spec}]=={OCTOP_VERSION}"
        )
        if expanded is None:
            resolved_source = f"pypi:octop=={OCTOP_VERSION}"
        subprocess.run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--upgrade",
                package,
            ],
            check=True,
            env=network_env(),
        )
        if expanded is not None:
            dashboard_status = ensure_dashboard_assets(expanded, python, offline=offline)
    atomic_json_write(
        PATHS.marker,
        {
            "package": "octop",
            "version": OCTOP_VERSION,
            "source": resolved_source or source,
            "requestedSource": source,
            "ref": ref,
            "python": str(python),
            "extras": extras,
            "dashboard": dashboard_status,
            "installedAt": int(time.time()),
        },
    )


def ensure_config() -> None:
    """Create only a greenfield config; preserve any existing Octop config byte-for-byte."""
    PATHS.data.mkdir(parents=True, exist_ok=True)
    if PATHS.config.exists():
        return
    atomic_json_write(
        PATHS.config,
        {
            "bind_host": OCTOP_HOST,
            "port": OCTOP_PORT,
            "log_level": "info",
            "access_token_ttl_seconds": 86400,
            "default_timezone": "America/Toronto",
            "enable_dashboard": True,
            "enable_api_docs": True,
            "history_v2_enabled": True,
            "require_setup_password": True,
            "cors_origins": ["http://127.0.0.1:3000", "http://localhost:3000"],
            "database": {"driver": "sqlite", "sqlite_path": "octop.db"},
            "backup": {
                "auto_enabled": False,
                "include_config": True,
                "include_workspaces": True,
                "include_skill_packages": True,
                "include_plugins": True,
                "include_knowledge": True,
                "include_chats": False,
            },
            "capabilities": {"mobile": {"enabled": False, "backend": "none"}},
        },
    )


def ensure_owner_credentials() -> dict[str, str]:
    existing = read_json(PATHS.owner)
    if existing is not None:
        username = str(existing.get("username") or "").strip()
        password = str(existing.get("password") or "")
        if username and password:
            return {"username": username, "password": password}
        die(f"管理员凭据文件字段不完整: {PATHS.owner}")
    if (PATHS.data / "octop.db").exists():
        die(
            f"发现已有 Octop 数据库但缺少私密管理员凭据: {PATHS.owner}。"
            "为避免覆盖用户配置，脚本不会猜测或重置密码。"
        )
    credentials = {
        "username": "lumaflow-owner",
        "password": secrets.token_urlsafe(32),
    }
    atomic_json_write(PATHS.owner, credentials, private=True)
    return credentials


def run_init(python: Path, credentials: dict[str, str]) -> None:
    db = PATHS.data / "octop.db"
    if db.exists():
        return
    env = os.environ.copy()
    env.update(
        {
            "OCTOP_HOME": str(PATHS.data),
            "OCTOP_ADMIN_USERNAME": credentials["username"],
            "OCTOP_ADMIN_PASSWORD": credentials["password"],
            "OCTOP_ADMIN_DISPLAY_NAME": "LumaFlow Owner",
        }
    )
    subprocess.run(
        [str(python), "-m", "octop", "init", "--yes"],
        cwd=str(PATHS.repo),
        env=env,
        check=True,
    )


def random_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((OCTOP_HOST, 0))
        return int(sock.getsockname()[1])


def _server_command(python: Path, port: int) -> list[str]:
    wrapper = PATHS.repo / "scripts" / "octop-work-app.py"
    if wrapper.is_file():
        # The Work app wrapper owns the parent-origin checked JWT handoff and
        # then delegates to Octop's official application launcher.
        return [str(python), str(wrapper), "--port", str(port)]
    code = (
        "from octop.launch import run_foreground_blocking; "
        f"run_foreground_blocking(host={OCTOP_HOST!r}, port={port}, reload=False, workers=1, "
        "log_level='warning', ssl_certfile=None, ssl_keyfile=None)"
    )
    return [str(python), "-c", code]


def start_child(python: Path, port: int, *, persistent: bool) -> subprocess.Popen[bytes]:
    log = PATHS.log if persistent else PATHS.data / "logs" / "bootstrap.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    stream = log.open("ab")
    env = os.environ.copy()
    env["OCTOP_HOME"] = str(PATHS.data)
    env["PYTHONUTF8"] = "1"
    process = subprocess.Popen(
        _server_command(python, port),
        cwd=str(PATHS.repo),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=stream,
        stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    # Keep the file descriptor alive with the child, but close it in this process.
    stream.close()
    return process


def stop_child(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=12)
    except (OSError, subprocess.TimeoutExpired):
        try:
            process.kill()
            process.wait(timeout=8)
        except (OSError, subprocess.TimeoutExpired):
            pass


def request_json(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    token: str | None = None,
    timeout: float = 60,
) -> Any:
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=payload,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            if not raw:
                return None
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read(2048).decode("utf-8", errors="replace")
        die(f"Octop API {method} {path} 返回 HTTP {exc.code}: {detail}")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        die(f"无法连接 Octop API {method} {path}: {exc}")


def wait_health(base_url: str, process: subprocess.Popen[bytes] | None = None) -> dict[str, Any]:
    deadline = time.monotonic() + 60
    last_error = ""
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            tail = ""
            try:
                tail = PATHS.data.joinpath("logs", "bootstrap.log").read_text(
                    encoding="utf-8", errors="replace"
                )[-2000:]
            except OSError:
                pass
            die(f"Octop 进程启动失败（退出码 {process.returncode}）。{tail}")
        try:
            result = request_json(base_url, "/api/health", timeout=2)
            if isinstance(result, dict) and result.get("ok"):
                return result
        except RuntimeErrorMessage as exc:
            last_error = str(exc)
        time.sleep(0.5)
    die(f"等待 Octop API 超时: {base_url}。{last_error}")


def login(base_url: str, credentials: dict[str, str]) -> tuple[str, dict[str, Any]]:
    result = request_json(
        base_url,
        "/api/auth/login",
        method="POST",
        body=credentials,
    )
    if not isinstance(result, dict) or not result.get("access_token"):
        die("Octop 登录响应缺少 access_token。")
    user = result.get("user")
    if not isinstance(user, dict) or user.get("id") is None:
        die("Octop 登录响应缺少 owner 用户资料。")
    return str(result["access_token"]), user


def db_jwt_secret() -> str:
    db_path = PATHS.data / "octop.db"
    try:
        with sqlite3.connect(db_path) as db:
            row = db.execute("SELECT v FROM secrets WHERE k = ?", ("jwt",)).fetchone()
    except sqlite3.Error as exc:
        die(f"读取 Octop JWT secret 失败: {exc}")
    if not row or not isinstance(row[0], (bytes, bytearray)):
        die("Octop 数据库尚未生成 secrets.jwt；请先成功启动一次服务。")
    return base64.urlsafe_b64encode(bytes(row[0])).decode("ascii").rstrip("=")


def _private_state() -> dict[str, Any]:
    existing = read_json(PATHS.lumaflow)
    if existing is not None:
        return existing
    return {"version": OCTOP_VERSION, "schemaVersion": 1, "octopVersion": OCTOP_VERSION}


def gateway_key(state: dict[str, Any]) -> str:
    value = str(state.get("gatewayKey") or "").strip()
    return value or secrets.token_urlsafe(32)


def gateway_read_key(state: dict[str, Any]) -> str:
    """Return the dedicated key used by read-only model requests.

    The parent gateway uses this separate key for a server-side tool
    allowlist, including nested ``task`` requests that Octop's critical-tool
    catalog cannot disable.
    """
    value = str(state.get("gatewayReadKey") or "").strip()
    return value if len(value) >= 32 else secrets.token_urlsafe(32)


def _dotenv_value(name: str) -> str | None:
    """Read a simple LLM_* value without mutating the parent process env."""
    raw = os.environ.get(name)
    if raw is not None and raw.strip():
        return raw.strip().strip('"').strip("'")
    candidates = (
        PATHS.repo / ".env.local",
        PATHS.repo / ".env",
        PATHS.repo / "vendor" / "lumaflow-core" / "frontend" / ".env.local",
        PATHS.repo / "vendor" / "lumaflow-core" / "frontend" / ".env",
    )
    for path in candidates:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            text = line.strip()
            if not text or text.startswith("#"):
                continue
            if text.startswith("export "):
                text = text[7:].lstrip()
            key, separator, value = text.partition("=")
            if separator and key.strip() == name:
                value = value.strip()
                if value and value[0:1] in {"\"", "'"} and value[-1:] == value[0]:
                    value = value[1:-1]
                return value.strip()
    return None


def _configured_positive_int(name: str, *, minimum: int, maximum: int, fallback: int) -> int:
    raw = _dotenv_value(name)
    try:
        value = int(str(raw).strip()) if raw is not None else 0
    except (TypeError, ValueError):
        value = 0
    if minimum <= value <= maximum:
        return value
    return fallback


def bonsai_context_tokens() -> int:
    """Return the configured Bonsai context, never an assumed 16K value."""
    return _configured_positive_int(
        "LLM_CONTEXT_TOKENS",
        minimum=512,
        maximum=BONSAI_CONTEXT_MAX,
        fallback=BONSAI_CONTEXT_FALLBACK,
    )


def bonsai_max_output_tokens() -> int:
    """Mirror LumaFlow's configured output ceiling for provider metadata."""
    return _configured_positive_int(
        "LLM_MAX_OUTPUT_TOKENS",
        minimum=256,
        maximum=BONSAI_OUTPUT_MAX,
        fallback=BONSAI_OUTPUT_FALLBACK,
    )


def lead_workspace() -> Path:
    return PATHS.data / "workspaces" / "work"


def read_only_agent_config(workspace: Path, read_root: Path) -> dict[str, Any]:
    """Build policy for a managed read-only role.

    The role's own ``workspace_dir`` stays separate so its SOUL/AGENTS,
    memory, sessions, and checkpoints cannot overwrite the lead role.  The
    local-shell backend is separately rooted at the lead Work workspace so a
    researcher or verifier can inspect the lead's output.  The tool denylist
    blocks the upstream mutable/external tools.  Octop keeps critical tools
    such as ``task`` and ``write_todos`` available by design; the bootstrap
    records that boundary rather than claiming an OS-level read-only sandbox.
    """
    role_path = workspace.resolve()
    root_path = read_root.resolve()
    if role_path == root_path:
        die("read-only agent 的 workspace_dir 必须独立于 lead Work backend root。")
    role_workspace = str(role_path)
    root = str(root_path)
    return {
        "workspace_dir": role_workspace,
        "backend": {"type": "local_shell", "root_dir": root, "virtual_mode": True},
        "tools_disabled": sorted(READ_ONLY_DISABLED_TOOLS),
        "subagents_auto_load": False,
        "todos_enabled": False,
        "team_enabled": False,
        "acp_delegate_enabled": False,
        "memory_capture_enabled": False,
        "memory_extract_on_session_end": False,
        "octop_reasoning_overrides": {"mode": "disabled"},
    }


def api_get_agents(base_url: str, token: str) -> list[dict[str, Any]]:
    result = request_json(base_url, "/api/agents", token=token)
    return result if isinstance(result, list) else []


def _is_legacy_bootstrap_model(model: Any) -> bool:
    """Recognise only the model entry generated by the old bootstrap.

    ``local:strata-coder`` is not globally reserved: a user may have added a
    model with that id deliberately.  The old managed entry also carried a
    stable display name, so require both pieces before removing it.
    """
    if not isinstance(model, dict):
        return False
    return (
        str(model.get("id") or "").strip() == LEGACY_STRATA_MODEL_ID
        and str(model.get("name") or "").strip() in LEGACY_STRATA_MODEL_NAMES
    )


def _legacy_model_ref(value: Any) -> bool:
    return isinstance(value, str) and value.strip() in LEGACY_MODEL_REFS


def _replace_legacy_model_refs(value: Any, default_model: str) -> tuple[Any, bool]:
    """Replace old managed model refs in a role/team config recursively.

    Config objects are merged rather than replaced, so user settings survive.
    The ``lumaflow/...`` spelling was used by an early ACP profile and keeps
    that provider namespace while changing the model ID.  Octop refs map to
    the role's requested provider so a lead or team cannot retain a stale
    read-only ref.  Other strings and values are unchanged.
    """
    if isinstance(value, str):
        normalized = value.strip()
        if normalized in LEGACY_MODEL_REFS:
            replacement = (
                "lumaflow/" + BONSAI_MODEL_ID
                if normalized.startswith("lumaflow/")
                else default_model
            )
            return replacement, replacement != value
        return value, False
    if isinstance(value, list):
        changed = False
        result: list[Any] = []
        for item in value:
            updated, item_changed = _replace_legacy_model_refs(item, default_model)
            result.append(updated)
            changed = changed or item_changed
        return result, changed
    if isinstance(value, dict):
        changed = False
        result: dict[Any, Any] = {}
        for key, item in value.items():
            updated, item_changed = _replace_legacy_model_refs(item, default_model)
            result[key] = updated
            changed = changed or item_changed
        return result, changed
    return value, False


def _managed_agent_patch(current: dict[str, Any], default_model: str) -> dict[str, Any]:
    """Return only the Bonsai/runtime fields that this bootstrap owns."""
    patch: dict[str, Any] = {}
    if current.get("default_model") != default_model:
        patch["default_model"] = default_model
    context_tokens = bonsai_context_tokens()
    output_tokens = bonsai_max_output_tokens()
    if current.get("max_input_length") != context_tokens:
        patch["max_input_length"] = context_tokens
    if current.get("max_tokens") != output_tokens:
        patch["max_tokens"] = output_tokens
    if current.get("temperature") != 0:
        patch["temperature"] = 0
    raw_config = current.get("config")
    if isinstance(raw_config, dict):
        migrated, changed = _replace_legacy_model_refs(raw_config, default_model)
        if changed:
            patch["config"] = migrated
    return patch


def _managed_provider_models(
    models: list[dict[str, Any]], expected_models: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Remove our exact legacy entry and refresh our managed metadata.

    Existing custom entries are carried byte-for-byte.  For the expected
    Bonsai ID, only an entry with the bootstrap display name is considered
    ours; merging the current catalog then corrects stale context/output
    values without taking over a user-renamed model.
    """
    expected_by_id = {str(item.get("id")): item for item in expected_models}
    result: list[dict[str, Any]] = []
    present: set[str] = set()
    for item in models:
        if _is_legacy_bootstrap_model(item):
            continue
        item_id = str(item.get("id"))
        expected = expected_by_id.get(item_id)
        if (
            expected is not None
            and str(item.get("name") or "").strip() == str(expected.get("name") or "").strip()
        ):
            merged = dict(item)
            merged.update(expected)
            result.append(merged)
        else:
            result.append(item)
        present.add(item_id)
    result.extend(item for item in expected_models if str(item.get("id")) not in present)
    return result


def _replace_legacy_acp_refs(value: Any) -> tuple[Any, bool]:
    """Migrate exact old ACP model refs while retaining their namespace."""
    if isinstance(value, str):
        normalized = value.strip()
        if normalized == f"lumaflow/{LEGACY_STRATA_MODEL_ID}":
            return "lumaflow/" + BONSAI_MODEL_ID, True
        if normalized == f"{PROVIDER_NAME}/{LEGACY_STRATA_MODEL_ID}":
            return BONSAI_MODEL_REF, True
        if normalized == f"{READ_ONLY_PROVIDER_NAME}/{LEGACY_STRATA_MODEL_ID}":
            return READ_ONLY_BONSAI_MODEL_REF, True
        return value, False
    if isinstance(value, list):
        changed = False
        result: list[Any] = []
        for item in value:
            updated, item_changed = _replace_legacy_acp_refs(item)
            result.append(updated)
            changed = changed or item_changed
        return result, changed
    if isinstance(value, dict):
        changed = False
        result: dict[Any, Any] = {}
        for key, item in value.items():
            updated, item_changed = _replace_legacy_acp_refs(item)
            result[key] = updated
            changed = changed or item_changed
        return result, changed
    return value, False


def migrate_managed_acp_config() -> None:
    """Clean the private ACP profile created by the earlier bootstrap.

    This deliberately targets one Octop-owned file and exact generated model
    names.  It does not scan or rewrite arbitrary user configuration files.
    """
    path = PATHS.data / "acp" / "opencode.json"
    if not path.is_file():
        return
    data = read_json(path)
    if data is None:
        return
    migrated, changed = _replace_legacy_acp_refs(data)
    if not isinstance(migrated, dict):
        return
    provider_root = migrated.get("provider")
    lumaflow = provider_root.get("lumaflow") if isinstance(provider_root, dict) else None
    models = lumaflow.get("models") if isinstance(lumaflow, dict) else None
    if isinstance(models, dict):
        for model_id in list(models):
            if _is_legacy_bootstrap_model({"id": model_id, **(models[model_id] if isinstance(models[model_id], dict) else {})}):
                del models[model_id]
                changed = True
        bonsai = models.get(BONSAI_MODEL_ID)
        if isinstance(bonsai, dict) and str(bonsai.get("name") or "").strip() == "Ternary Bonsai 2 27B（LumaFlow 网关）":
            updated_bonsai = dict(bonsai)
            limit = dict(updated_bonsai.get("limit")) if isinstance(updated_bonsai.get("limit"), dict) else {}
            limit.update({"context": bonsai_context_tokens(), "output": bonsai_max_output_tokens()})
            updated_bonsai["limit"] = limit
            if updated_bonsai != bonsai:
                models[BONSAI_MODEL_ID] = updated_bonsai
                changed = True
    if changed:
        atomic_json_write(path, migrated, private=True)


def ensure_provider(
    base_url: str,
    token: str,
    key: str,
    state: dict[str, Any],
    *,
    provider_name: str = PROVIDER_NAME,
    state_key: str = "providerId",
    model_catalog: list[dict[str, Any]] | None = None,
    note: str = FULL_PROVIDER_NOTE,
) -> int:
    """Ensure one provider owned by this bootstrap instance.

    A provider is adopted without a state entry only when its managed note,
    URL, enabled flag, and model IDs all match.  This prevents a coincidental
    same-named user provider from being taken over. Once its ID is recorded in
    our private state, the old exact Strata entry is removed and the Bonsai
    entry is ensured; all other existing custom model entries and provider
    fields are preserved.
    """
    result = request_json(base_url, "/api/admin/providers", token=token)
    providers = result if isinstance(result, list) else []
    existing = next((p for p in providers if p.get("name") == provider_name), None)
    state_provider_id = state.get(state_key)
    expected_models = model_catalog if model_catalog is not None else _model_catalog()
    expected_ids = {str(item["id"]) for item in expected_models}
    if existing is not None:
        try:
            existing_id = int(existing["id"])
        except (KeyError, TypeError, ValueError):
            die(f"Octop provider {provider_name!r} 缺少有效 id；脚本不会覆盖它。")
        if state_provider_id is None:
            existing_models = existing.get("models") or []
            if (
                existing.get("base_url") != LUMAFLOW_BASE_URL
                or not existing.get("enabled", True)
                or existing.get("note") != note
                or not isinstance(existing_models, list)
                or not expected_ids.issubset(
                    {str(item.get("id")) for item in existing_models if isinstance(item, dict)}
                )
            ):
                die(
                    f"Octop 已有名为 {provider_name!r} 的 provider，但不是本实例的 LumaFlow 配置；"
                    "脚本不会覆盖它。请在 Octop 控制台另选名称。"
                )
            state[state_key] = existing_id
            merged_models = _managed_provider_models(existing_models, expected_models)
            if merged_models != existing_models:
                request_json(
                    base_url,
                    f"/api/admin/providers/{existing_id}",
                    method="PATCH",
                    token=token,
                    body={"models": merged_models},
                )
            return existing_id
        try:
            provider_id = int(state_provider_id)
        except (TypeError, ValueError):
            die(
                f"lumaflow.json 的 {state_key} 无效；"
                "脚本不会猜测要修改哪个 provider。"
            )
        if existing_id != provider_id:
            die(
                f"Octop provider {provider_name!r} 的 id 已从 {provider_id} 变为 {existing_id}；"
                "为避免接管用户配置，脚本不会自动修复。"
            )
        state[state_key] = provider_id
        if existing.get("base_url") != LUMAFLOW_BASE_URL or not existing.get("enabled", True):
            die(
                f"Octop provider {provider_name!r} 已被修改或禁用；"
                "为避免覆盖现有配置，脚本不会自动修复。请在 Dashboard 恢复 LumaFlow gateway 后重试。"
            )
        models = existing.get("models") or []
        if not isinstance(models, list) or not all(isinstance(item, dict) for item in models):
            die(f"Octop provider {provider_name!r} 的 models 格式无效；脚本不会覆盖它。")
        merged_models = _managed_provider_models(models, expected_models)
        if merged_models != models:
            request_json(
                base_url,
                f"/api/admin/providers/{provider_id}",
                method="PATCH",
                token=token,
                body={"models": merged_models},
            )
        return provider_id
    if state_provider_id is not None:
        die(
            f"lumaflow.json 记录的 provider {provider_name!r} 不存在；"
            "脚本不会在可能被用户删除后自动重建。请清理过期的 bootstrap 状态后重试。"
        )
    created = request_json(
        base_url,
        "/api/admin/providers",
        method="POST",
        token=token,
        body={
            "name": provider_name,
            "kind": "openai",
            "base_url": LUMAFLOW_BASE_URL,
            "api_key": key,
            "models": expected_models,
            "note": note,
            "stream_usage": True,
        },
    )
    if not isinstance(created, dict) or created.get("id") is None:
        die("创建 LumaFlow provider 失败。")
    state[state_key] = int(created["id"])
    return int(created["id"])


def _model_catalog() -> list[dict[str, Any]]:
    return [
        {
            "id": BONSAI_MODEL_ID,
            "name": "Ternary Bonsai 2 27B（LumaFlow 网关）",
            "enabled": True,
            "input": ["text"],
            "thinking": False,
            "reasoning": False,
            "context_window": bonsai_context_tokens(),
            "max_input_tokens": bonsai_context_tokens(),
            "max_output_tokens": bonsai_max_output_tokens(),
        },
    ]


def agent_payload(
    name: str,
    description: str,
    workspace: Path,
    prompt: str,
    *,
    default_model: str = BONSAI_MODEL_REF,
    config_extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    config: dict[str, Any] = {
        "workspace_dir": str(workspace.resolve()),
        "octop_reasoning_overrides": {"mode": "disabled"},
    }
    if config_extra:
        config.update(config_extra)
    return {
        "name": name,
        "description": description,
        "default_model": default_model,
        "system_prompt": prompt,
        "config": config,
        "max_iters": 8,
        "max_input_length": bonsai_context_tokens(),
        "temperature": 0,
        "max_tokens": bonsai_max_output_tokens(),
        "welcome_message": f"{name} 已连接 LumaFlow Work 网关，可使用本地模型执行任务。",
        "is_shared": False,
    }


def ensure_agent(
    base_url: str,
    token: str,
    agents: list[dict[str, Any]],
    *,
    state: dict[str, Any],
    key: str,
    name: str,
    description: str,
    workspace: Path,
    prompt: str,
    default_model: str = BONSAI_MODEL_REF,
    config_extra: dict[str, Any] | None = None,
) -> str:
    current_id = str((state.get("agentIds") or {}).get(key) or "").strip()
    existing = next(
        (
            item
            for item in agents
            if (current_id and item.get("agent_id") == current_id)
            or (not current_id and item.get("name") == name)
        ),
        None,
    )
    if existing is not None:
        if not current_id and existing.get("name") == name:
            # A timed-out POST can commit an agent before the client receives
            # its response.  Recover that exact LumaFlow payload so a retry is
            # idempotent.  A prior managed role may still point at the old
            # Strata ref; that exact legacy ref is migrated below.  A
            # different description or unrelated model still cannot be taken
            # over merely because the display name matches.
            if existing.get("description") != description or (
                existing.get("default_model") not in {None, "", default_model}
                and not _legacy_model_ref(existing.get("default_model"))
            ):
                die(f"Octop 已存在同名 agent {name!r}，脚本不会覆盖它。")
        agent_id = str(existing.get("agent_id") or "")
        if not agent_id:
            die(f"Octop agent {name!r} 缺少 agent_id。")
        patch = _managed_agent_patch(existing, default_model)
        if patch:
            request_json(
                base_url,
                f"/api/agents/{agent_id}",
                method="PATCH",
                token=token,
                body=patch,
            )
        return agent_id
    created = request_json(
        base_url,
        "/api/agents",
        method="POST",
        token=token,
        body=agent_payload(
            name,
            description,
            workspace,
            prompt,
            default_model=default_model,
            config_extra=config_extra,
        ),
    )
    if not isinstance(created, dict) or not created.get("agent_id"):
        die(f"创建 Octop agent {name!r} 失败。")
    return str(created["agent_id"])


def enforce_read_only_agent(
    base_url: str,
    token: str,
    agent_id: str,
    *,
    workspace: Path,
    read_root: Path,
) -> None:
    """Apply and verify the real Octop denylist for our read-only roles.

    The API patch replaces ``config`` as one JSON object, so merge into the
    current object first.  This preserves unrelated settings while enforcing
    the bootstrap role's lead-workspace path and denylist.  It is called only
    for IDs recorded in our private bootstrap state.
    """
    current = request_json(base_url, f"/api/agents/{agent_id}", token=token)
    if not isinstance(current, dict):
        die(f"读取 Octop read-only agent {agent_id!r} 失败。")
    raw_config = current.get("config")
    config = dict(raw_config) if isinstance(raw_config, dict) else {}
    desired = read_only_agent_config(workspace, read_root)
    existing_disabled = config.get("tools_disabled")
    disabled = {
        str(item).strip()
        for item in existing_disabled
        if str(item).strip()
    } if isinstance(existing_disabled, list) else set()
    disabled.update(READ_ONLY_DISABLED_TOOLS)
    desired["tools_disabled"] = sorted(disabled)
    changed = False
    for key, value in desired.items():
        if config.get(key) != value:
            config[key] = value
            changed = True
    if changed:
        request_json(
            base_url,
            f"/api/agents/{agent_id}",
            method="PATCH",
            token=token,
            body={"config": config},
        )

    # Verify both path dimensions after the patch.  Octop may normalize a
    # writable host path, but it must never collapse the role workspace into
    # the lead backend root.
    refreshed = request_json(base_url, f"/api/agents/{agent_id}", token=token)
    refreshed_config = refreshed.get("config") if isinstance(refreshed, dict) else {}
    if not isinstance(refreshed_config, dict):
        die(f"读取 Octop read-only agent {agent_id!r} 的最终 config 失败。")
    actual_workspace = str(refreshed_config.get("workspace_dir") or "").strip()
    actual_backend = refreshed_config.get("backend")
    actual_root = (
        str(actual_backend.get("root_dir") or "").strip()
        if isinstance(actual_backend, dict)
        else ""
    )
    if not actual_workspace:
        die(f"Octop read-only agent {agent_id!r} 缺少独立 workspace_dir。")
    try:
        if Path(actual_workspace).resolve() == read_root.resolve():
            die(f"Octop read-only agent {agent_id!r} 的 workspace_dir 误指向 lead backend root。")
    except OSError:
        if actual_workspace == str(read_root.resolve()):
            die(f"Octop read-only agent {agent_id!r} 的 workspace_dir 误指向 lead backend root。")
    if not actual_root:
        die(f"Octop read-only agent {agent_id!r} 缺少 lead workspace backend root。")
    try:
        backend_matches_root = Path(actual_root).resolve() == read_root.resolve()
    except OSError:
        backend_matches_root = actual_root == str(read_root.resolve())
    if not backend_matches_root:
        die(f"Octop read-only agent {agent_id!r} 的 backend root 未指向 lead workspace。")

    # Confirm the server normalized the denylist and did not merely retain the
    # natural-language "read-only" prompt.  Missing entries are acceptable
    # when a global capability is disabled; any present denied tool must be off.
    settings = request_json(
        base_url,
        f"/api/agents/{agent_id}/tool-settings",
        token=token,
    )
    items = settings.get("tools", []) if isinstance(settings, dict) else []
    enabled_denied = {
        str(item.get("name"))
        for item in items
        if isinstance(item, dict)
        and item.get("name") in READ_ONLY_DISABLED_TOOLS
        and item.get("enabled") is True
    }
    if enabled_denied:
        die(
            f"Octop read-only agent {agent_id!r} 仍启用了受限工具: "
            + ", ".join(sorted(enabled_denied))
        )


def ensure_team(
    base_url: str,
    token: str,
    *,
    state: dict[str, Any],
    member_ids: list[str],
    workspace: Path,
) -> str:
    team_name = "Work 本地协作团队"
    team_description = "资料研究、Work 执行和独立结果核验组成的 Octop 原生团队。"
    current_id = str((state.get("agentIds") or {}).get("team") or "").strip()
    teams = request_json(base_url, "/api/teams", token=token)
    teams = teams if isinstance(teams, list) else []
    existing = next((item for item in teams if current_id and item.get("agent_id") == current_id), None)
    if existing is not None:
        team_id = str(existing.get("agent_id") or current_id)
        if not team_id:
            die("Octop 本地协作团队缺少 agent_id。")
        team_agent = request_json(base_url, f"/api/agents/{team_id}", token=token)
        if not isinstance(team_agent, dict):
            die("读取 Octop 本地协作团队的 agent 记录失败。")
        patch = _managed_agent_patch(team_agent, BONSAI_MODEL_REF)
        if patch:
            request_json(
                base_url,
                f"/api/agents/{team_id}",
                method="PATCH",
                token=token,
                body=patch,
            )
        return team_id
    same_name = next((item for item in teams if item.get("name") == team_name), None)
    if same_name is not None:
        if same_name.get("description") != team_description:
            die("Octop 已存在同名团队，脚本不会覆盖它。")
        team_id = str(same_name.get("agent_id") or "")
        if not team_id:
            die("Octop 同名团队缺少 agent_id；脚本不会猜测要修改哪个团队。")
        team_agent = request_json(base_url, f"/api/agents/{team_id}", token=token)
        if not isinstance(team_agent, dict):
            die("读取 Octop 同名团队的 agent 记录失败。")
        old_model = team_agent.get("default_model")
        if old_model not in {None, "", BONSAI_MODEL_REF} and not _legacy_model_ref(old_model):
            die("Octop 同名团队使用了其他模型，脚本不会覆盖它。")
        patch = _managed_agent_patch(team_agent, BONSAI_MODEL_REF)
        if patch:
            request_json(
                base_url,
                f"/api/agents/{team_id}",
                method="PATCH",
                token=token,
                body=patch,
            )
        return team_id
    created = request_json(
        base_url,
        "/api/teams",
        method="POST",
        token=token,
        body={
            "name": team_name,
            "description": team_description,
            "default_model": BONSAI_MODEL_REF,
            "color": "#2563eb",
            "icon_name": "users",
            "welcome_message": "团队会先研究，再执行，最后由独立核验员检查结果。",
            "member_ids": member_ids,
            "config": {"workspace_dir": str(workspace.resolve())},
        },
    )
    if not isinstance(created, dict) or not created.get("agent_id"):
        die("创建 Octop 原生团队失败。")
    team_id = str(created["agent_id"])
    team_agent = request_json(base_url, f"/api/agents/{team_id}", token=token)
    if isinstance(team_agent, dict):
        patch = _managed_agent_patch(team_agent, BONSAI_MODEL_REF)
        if patch:
            request_json(
                base_url,
                f"/api/agents/{team_id}",
                method="PATCH",
                token=token,
                body=patch,
            )
    return team_id


def ensure_active_model(base_url: str, token: str) -> None:
    current = request_json(base_url, "/api/providers/active-model", token=token)
    if not isinstance(current, dict):
        current = {}
    provider_name = str(current.get("provider_name") or "").strip()
    model = str(current.get("model") or "").strip()
    if provider_name and model and not (
        model == LEGACY_STRATA_MODEL_ID
        and provider_name in {PROVIDER_NAME, READ_ONLY_PROVIDER_NAME}
    ):
        # A user-selected provider/model, including a custom model under one
        # of our providers, remains selected across subsequent bootstraps.
        return
    target_provider = (
        READ_ONLY_PROVIDER_NAME if provider_name == READ_ONLY_PROVIDER_NAME else PROVIDER_NAME
    )
    target = {"provider_name": target_provider, "model": BONSAI_MODEL_ID}
    if provider_name == target_provider and model == BONSAI_MODEL_ID:
        return
    request_json(
        base_url,
        "/api/providers/active-model",
        method="PUT",
        token=token,
        body=target,
    )


def disable_proactive_care(base_url: str, token: str, agent_id: str) -> None:
    """Keep newly managed agents idle until a user enables proactive care."""
    request_json(
        base_url,
        f"/api/agents/{agent_id}/proactive-care",
        method="PUT",
        token=token,
        body={
            "enabled": False,
            "active_hours_start": "09:00",
            "active_hours_end": "22:00",
            "min_interval_hours": 5,
            "max_interval_hours": 24,
        },
    )


def bootstrap_api(base_url: str) -> dict[str, Any]:
    credentials = ensure_owner_credentials()
    token, user = login(base_url, credentials)
    state = _private_state()
    managed_before = state.get("agentIds") if isinstance(state.get("agentIds"), dict) else {}
    key = gateway_key(state)
    read_key = gateway_read_key(state)
    # Persist both gateway keys before creating providers.  If the API process
    # is interrupted after a provider POST, a retry must keep the same key
    # rather than silently creating a provider that the parent gateway cannot
    # authenticate.
    state["gatewayKey"] = key
    state["gatewayReadKey"] = read_key
    atomic_json_write(PATHS.lumaflow, state, private=True)
    provider_id = ensure_provider(base_url, token, key, state)
    readonly_provider_id = ensure_provider(
        base_url,
        token,
        read_key,
        state,
        provider_name=READ_ONLY_PROVIDER_NAME,
        state_key="readonlyProviderId",
        model_catalog=_model_catalog(),
        note=READ_ONLY_PROVIDER_NOTE,
    )
    agents = api_get_agents(base_url, token)
    lead = lead_workspace()
    researcher_workspace = PATHS.data / "workspaces" / "researcher"
    verifier_workspace = PATHS.data / "workspaces" / "verifier"
    work = ensure_agent(
        base_url,
        token,
        agents,
        state=state,
        key="work",
        name="Work执行助手",
        description="LumaFlow Work 的主执行者，负责按计划调用工具并产出文件。",
        workspace=lead,
        prompt=(
            "你是 Work 主执行者。按任务计划执行真实工具调用，记录输入、输出和文件证据；"
            "未经核验不要宣称完成。使用中文回答，步骤保持短小。"
        ),
    )
    if not managed_before.get("work"):
        disable_proactive_care(base_url, token, work)
    agents = api_get_agents(base_url, token)
    researcher = ensure_agent(
        base_url,
        token,
        agents,
        state=state,
        key="researcher",
        name="资料研究员",
        description="先读取任务范围内的资料并整理可验证事实，只读工作角色。",
        workspace=researcher_workspace,
        default_model=READ_ONLY_BONSAI_MODEL_REF,
        prompt=(
            "你是资料研究员。只读取和分析被授权路径，返回来源、事实和不确定项；"
            "不要修改、删除文件，也不要把推测写成事实。"
        ),
        config_extra=read_only_agent_config(researcher_workspace, lead),
    )
    enforce_read_only_agent(
        base_url,
        token,
        researcher,
        workspace=researcher_workspace,
        read_root=lead,
    )
    if not managed_before.get("researcher"):
        disable_proactive_care(base_url, token, researcher)
    agents = api_get_agents(base_url, token)
    verifier = ensure_agent(
        base_url,
        token,
        agents,
        state=state,
        key="verifier",
        name="结果核验员",
        description="独立复查执行结果、文件内容和证据链，只读工作角色。",
        workspace=verifier_workspace,
        default_model=READ_ONLY_BONSAI_MODEL_REF,
        prompt=(
            "你是结果核验员。独立读取执行产物并重算关键事实；只报告可复现证据、"
            "失败原因和待核实项，不修改或删除任何文件。"
        ),
        config_extra=read_only_agent_config(verifier_workspace, lead),
    )
    enforce_read_only_agent(
        base_url,
        token,
        verifier,
        workspace=verifier_workspace,
        read_root=lead,
    )
    if not managed_before.get("verifier"):
        disable_proactive_care(base_url, token, verifier)
    team = ensure_team(
        base_url,
        token,
        state=state,
        member_ids=[researcher, work, verifier],
        workspace=PATHS.data / "workspaces" / "team",
    )
    if not managed_before.get("team"):
        disable_proactive_care(base_url, token, team)
    # Migrate only the exact legacy Strata selection; a user's other active
    # provider/model selection remains untouched.
    ensure_active_model(base_url, token)
    migrate_managed_acp_config()
    migrated_state, _ = _replace_legacy_model_refs(state, BONSAI_MODEL_REF)
    if isinstance(migrated_state, dict):
        state.clear()
        state.update(migrated_state)
    state.update(
        {
            "version": OCTOP_VERSION,
            "schemaVersion": 1,
            "octopVersion": OCTOP_VERSION,
            "upstreamRef": UPSTREAM_REF,
            "baseUrl": OCTOP_BASE_URL,
            "gatewayBaseUrl": LUMAFLOW_BASE_URL,
            "providerName": PROVIDER_NAME,
            "readonlyProviderName": READ_ONLY_PROVIDER_NAME,
            "modelId": BONSAI_MODEL_ID,
            "modelRef": BONSAI_MODEL_REF,
            "readonlyModelRef": READ_ONLY_BONSAI_MODEL_REF,
            "ownerId": int(user["id"]),
            "ownerUsername": str(user.get("username") or credentials["username"]),
            "jwtSecret": db_jwt_secret(),
            "jwtSecretEncoding": "base64",
            "gatewayKey": key,
            "gatewayReadKey": read_key,
            "gatewayReadKeyEncoding": "raw",
            "providerIds": {
                "full": provider_id,
                "readonly": readonly_provider_id,
            },
            "agentIds": {
                "work": work,
                "researcher": researcher,
                "verifier": verifier,
                "team": team,
            },
            "jwt": {"algorithm": "HS256", "claims": ["sub", "uname", "role", "iat", "exp"]},
            "modelRefs": {
                "bonsai": BONSAI_MODEL_REF,
            },
            "readonlyModelRefs": {
                "bonsai": READ_ONLY_BONSAI_MODEL_REF,
            },
            "modelCatalog": [
                {
                    "id": item["id"],
                    "ref": f"{PROVIDER_NAME}/{item['id']}",
                    "name": item["name"],
                    "contextWindow": item.get("context_window"),
                    "maxOutputTokens": item.get("max_output_tokens"),
                }
                for item in _model_catalog()
            ],
            "readonlyModelCatalog": [
                {
                    "id": item["id"],
                    "ref": f"{READ_ONLY_PROVIDER_NAME}/{item['id']}",
                    "name": item["name"],
                    "contextWindow": item.get("context_window"),
                    "maxOutputTokens": item.get("max_output_tokens"),
                }
                for item in _model_catalog()
            ],
            "limits": {
                "contextWindow": bonsai_context_tokens(),
                "maxOutputTokens": bonsai_max_output_tokens(),
                "temperature": 0,
            },
        }
    )
    atomic_json_write(PATHS.lumaflow, state, private=True)
    return state


def health_at(port: int = OCTOP_PORT) -> dict[str, Any] | None:
    try:
        result = request_json(f"http://{OCTOP_HOST}:{port}", "/api/health", timeout=2)
    except RuntimeErrorMessage:
        return None
    return result if isinstance(result, dict) and result.get("ok") else None


def bootstrap_with_temporary_server(python: Path) -> dict[str, Any]:
    port = random_port()
    child = start_child(python, port, persistent=False)
    base_url = f"http://{OCTOP_HOST}:{port}"
    try:
        wait_health(base_url, child)
        return bootstrap_api(base_url)
    finally:
        stop_child(child)


def setup(args: argparse.Namespace) -> int:
    base_python = choose_base_python()
    python = ensure_venv(base_python)
    ensure_config()
    source = args.source or UPSTREAM_URL
    marker = read_json(PATHS.marker)
    if marker is None or args.reinstall:
        install_octop(
            python,
            source=source,
            ref=args.ref,
            offline=args.offline,
            uv_path=args.uv,
            local_embedding=args.local_embedding,
        )
    credentials = ensure_owner_credentials()
    run_init(python, credentials)
    windows_patch = REPO_ROOT / "scripts" / "patch-octop-windows.py"
    if os.name == "nt" and windows_patch.is_file():
        subprocess.run([str(python), str(windows_patch), "--apply", *(["--offline"] if args.offline else [])], check=True, env=network_env())
    if args.skip_bootstrap:
        print(f"Octop 已安装并初始化: {PATHS.data}")
        return 0
    state = read_json(PATHS.lumaflow)
    if state is None or not state.get("agentIds"):
        result = bootstrap_with_temporary_server(python)
        print(
            f"Octop 已安装、初始化并创建 Work 团队（{len(result.get('agentIds', {}))} 个 ID）。"
            f" 数据目录: {PATHS.data}"
        )
    else:
        print(f"Octop 已配置，保留现有 owner/provider/team: {PATHS.data}")
    return 0


def write_pid(pid: int) -> None:
    atomic_json_write(PATHS.pid, {"pid": pid, "startedAt": int(time.time()), "port": OCTOP_PORT})


def start(args: argparse.Namespace) -> int:
    python = venv_python()
    if not python.is_file():
        die("Octop 虚拟环境不存在，请先运行 scripts/setup-octop.py。")
    ensure_config()
    existing = health_at()
    if existing is not None:
        print(f"Octop 已在 {OCTOP_BASE_URL} 运行；未启动或停止任何其他进程。")
        if args.bootstrap:
            bootstrap_api(OCTOP_BASE_URL)
        return 0
    process = start_child(python, OCTOP_PORT, persistent=True)
    try:
        wait_health(OCTOP_BASE_URL, process)
        write_pid(process.pid)
        if args.bootstrap:
            bootstrap_api(OCTOP_BASE_URL)
        print(f"Octop 已启动: {OCTOP_BASE_URL}（PID {process.pid}）")
        return 0
    except Exception:
        stop_child(process)
        raise


def status(_: argparse.Namespace) -> int:
    health = health_at()
    state = read_json(PATHS.lumaflow)
    if health is None:
        print(json.dumps({"running": False, "baseUrl": OCTOP_BASE_URL}, ensure_ascii=False))
        return 1
    summary = {
        "running": True,
        "baseUrl": OCTOP_BASE_URL,
        "health": health,
        "configured": bool(state and state.get("agentIds")),
        "dataRoot": str(PATHS.data),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LumaFlow isolated Octop runtime")
    sub = parser.add_subparsers(dest="command", required=True)
    setup_parser = sub.add_parser("setup", help="install, initialise, and bootstrap Octop")
    setup_parser.add_argument("--source", help="local checkout or Git URL", default=None)
    setup_parser.add_argument("--ref", default=UPSTREAM_REF, help="pinned Git revision")
    setup_parser.add_argument("--offline", action="store_true")
    setup_parser.add_argument("--reinstall", action="store_true")
    setup_parser.add_argument(
        "--uv",
        default=None,
        help="uv executable path; defaults to .local-runtime/tools/uv(.exe), then PATH",
    )
    setup_parser.add_argument(
        "--local-embedding",
        action="store_true",
        help="also install optional fastembed/HuggingFace support (does not download a model)",
    )
    setup_parser.add_argument("--skip-bootstrap", action="store_true")
    start_parser = sub.add_parser("start", help="start the isolated Octop service")
    start_parser.add_argument("--no-bootstrap", dest="bootstrap", action="store_false")
    start_parser.set_defaults(bootstrap=True)
    sub.add_parser("status", help="check the isolated Octop service")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "setup":
            return setup(args)
        if args.command == "start":
            return start(args)
        if args.command == "status":
            return status(args)
        die(f"未知命令: {args.command}")
    except RuntimeErrorMessage as exc:
        print(f"Octop runtime error: {exc}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        print(f"Octop runtime command failed with exit code {exc.returncode}.", file=sys.stderr)
        return int(exc.returncode or 1)


if __name__ == "__main__":
    raise SystemExit(main())
