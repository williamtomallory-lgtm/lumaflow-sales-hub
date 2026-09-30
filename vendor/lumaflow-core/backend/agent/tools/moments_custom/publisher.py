"""Local Windows Weixin Moments publisher.

The ilink bot API can send a reply to a contact, but it has no Moments
publication operation.  This adapter intentionally uses the *visible*,
already logged-in Windows Weixin client instead.  It is only called after the
user sends an explicit confirmation and never handles credentials or Weixin's
local database.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence


@dataclass(frozen=True)
class PublicationResult:
    status: str
    message: str
    provider: str = "windows_desktop"


def _script_path() -> Path:
    # backend/agent/tools/moments_custom -> backend -> scripts
    return Path(__file__).resolve().parents[3] / "scripts" / "weixin-moments-publish.ps1"


def publisher_mode() -> str:
    configured = os.environ.get("LUMAFLOW_MOMENTS_PUBLISHER", "").strip().lower()
    if configured:
        return configured
    return "windows_desktop" if os.name == "nt" else "disabled"


def _is_windows() -> bool:
    return os.name == "nt"


def publish_moments(body: str, image_paths: Optional[Sequence[str]] = None, *, verify_only: bool = False) -> PublicationResult:
    """Submit a user-confirmed Moments post through the visible desktop app.

    Success requires a verified newest feed entry. An uncertain attempt is
    deliberately non-retryable to avoid publishing the same text twice.
    """
    if not isinstance(body, str) or not body.strip():
        return PublicationResult("failed", "朋友圈正文为空，未执行发布。")
    mode = publisher_mode()
    if mode in {"disabled", "none", "off"}:
        return PublicationResult(
            "unavailable",
            "当前没有启用本机微信朋友圈发布器；请设置 LUMAFLOW_MOMENTS_PUBLISHER=windows_desktop。",
        )
    if mode != "windows_desktop":
        return PublicationResult("unavailable", f"不支持的朋友圈发布器：{mode}。")
    if not _is_windows():
        return PublicationResult("unavailable", "朋友圈桌面发布器只支持 Windows 微信客户端。")
    if image_paths:
        return PublicationResult("unavailable", "当前桌面发布器只支持文字朋友圈；未发布，也不会丢弃图片后发布。")
    script = _script_path()
    if not script.is_file():
        return PublicationResult("unavailable", "本机微信发布脚本不存在，请重新安装 LumaFlow。")

    encoded = base64.b64encode(body.encode("utf-8")).decode("ascii")
    args = [
        "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-STA",
        "-ExecutionPolicy", "Bypass", "-File", str(script),
        "-Action", "verify" if verify_only else "publish", "-BodyBase64", encoded,
    ]
    try:
        completed = subprocess.run(
            args,
            cwd=str(script.parent.parent),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=45,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        return PublicationResult("submitted_unverified", "发布器超时，无法确定是否已经点击发表；请检查朋友圈，暂勿重复确认。")
    except OSError as exc:
        return PublicationResult("failed", f"无法启动微信桌面发布器：{exc}")

    output = (completed.stdout or "").strip()
    if completed.returncode != 0:
        # The script emits a safe, user-facing message and never includes
        # credentials or chat contents.  Keep stderr out of the chat reply.
        return PublicationResult("submitted_unverified", "发布器意外退出，无法核验发布状态；请检查朋友圈，暂勿重复确认。")
    try:
        receipt = json.loads(output)
        status = receipt["status"]
        message = receipt["message"]
        if status not in {"published_verified", "submitted_unverified", "failed"} or not isinstance(message, str):
            raise ValueError("Invalid receipt")
    except (ValueError, TypeError, KeyError):
        return PublicationResult("submitted_unverified", "未收到有效发布回执；请检查朋友圈，暂勿重复确认。")
    return PublicationResult(status, message)
