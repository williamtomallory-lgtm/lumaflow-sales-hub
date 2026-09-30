"""Handle user-authored Moments text and an explicit publish confirmation."""

from __future__ import annotations

import json
import os
from pathlib import Path
import threading
import time
from typing import Any, Dict, Mapping

from agent.tools.base_tool import BaseTool, ToolResult
from agent.tools.moments_custom.publisher import publish_moments


class MomentsCustom(BaseTool):
    name = "moments_custom"
    description = (
        "接收用户自己写好的朋友圈正文，原文返回，不查询产品 SKU 或运营简报，也不自动改写。"
        "首次只建立待发布草稿；只有用户随后明确发送确认发布，才调用已登录 Windows 微信桌面发布器。"
    )
    params = {
        "type": "object",
        "properties": {
            "body": {"type": "string", "description": "用户自己提供的完整朋友圈正文。"},
            "action": {"type": "string", "enum": ["help", "publish", "cancel", "verify"], "description": "展示用法、发布待确认正文、取消或只核验当前账户最新朋友圈。"},
        },
        "anyOf": [{"required": ["body"]}, {"required": ["action"]}],
        "additionalProperties": False,
    }

    def __init__(self, config: Dict[str, Any] | None = None):
        super().__init__()
        # Tool instances are scoped to one Agent, so this pending body cannot
        # leak between different personal WeChat Agents.
        self._pending_body: str | None = None
        self._pending_at = 0.0
        self._session_id: str | None = None
        self._agent_id: str | None = None
        self._lock = threading.Lock()

    def bind_runtime(self, session_id: str | None, agent_id: str | None):
        """Trusted initializer only; never accept identity from model arguments."""
        self._session_id = session_id
        self._agent_id = agent_id

    def _authorized(self) -> bool:
        try:
            configured = os.environ.get("LUMAFLOW_MOMENTS_ALLOWED_SESSIONS")
            if configured is not None:
                allowed = json.loads(configured)
            else:
                from config import get_data_root
                path = Path(get_data_root()) / "moments-publisher.json"
                allowed = json.loads(path.read_text(encoding="utf-8-sig")).get("allowedSessions", {})
            sessions = allowed.get(self._agent_id, [])
            return bool(self._session_id) and isinstance(sessions, list) and self._session_id in sessions
        except (ValueError, TypeError, AttributeError, OSError):
            return False

    def execute(self, args: Dict[str, Any]) -> ToolResult:
        with self._lock:
            return self._execute(args)

    def _execute(self, args: Dict[str, Any]) -> ToolResult:
        if isinstance(args, Mapping) and set(args) == {"action", "body"} and args["action"] == "verify":
            if not self._authorized():
                return ToolResult.fail("当前会话未获本机账户核验授权；没有执行发表。")
            if not isinstance(args["body"], str) or not args["body"].strip():
                return ToolResult.fail("请发送“核验朋友圈(原文)”。本次只核验，不发表。")
            result = publish_moments(args["body"], verify_only=True)
            return ToolResult.success({"mode": "verification", "body": args["body"], "publicationStatus": result.status,
                                       "provider": result.provider, "notice": result.message})
        if isinstance(args, Mapping) and dict(args) == {"action": "help"}:
            return ToolResult.success({
                "mode": "help",
                "modes": ["资料模式", "自定义模式"],
                "publicationStatus": "requires_explicit_confirmation",
            })
        if isinstance(args, Mapping) and dict(args) == {"action": "cancel"}:
            had_pending = self._pending_body is not None
            self._pending_body = None
            return ToolResult.success({
                "mode": "cancel",
                "publicationStatus": "cancelled" if had_pending else "no_pending_post",
            })
        if isinstance(args, Mapping) and dict(args) == {"action": "publish"}:
            if not self._authorized():
                return ToolResult.fail("当前会话未获本机账户发布授权；未执行发表。请在本机配置发布者会话白名单。")
            if not self._pending_body:
                return ToolResult.fail("当前没有待确认的朋友圈正文；请先发送“自定义模式(正文)”。")
            if time.monotonic() - self._pending_at > 600:
                self._pending_body = None
                return ToolResult.fail("待发布正文已超过10分钟；请重新发送正文后确认。")
            result = publish_moments(self._pending_body)
            payload = {
                "body": self._pending_body,
                "publicationStatus": result.status,
                "provider": result.provider,
                "notice": result.message,
            }
            if result.status in {"published_verified", "submitted_unverified"}:
                self._pending_body = None
                return ToolResult.success(payload)
            return ToolResult.fail(payload)
        if not isinstance(args, Mapping) or set(args) != {"body"}:
            return ToolResult.fail("请发送“发朋友圈 内容：你写好的正文”；本模式不需要 SKU 或运营简报。")
        raw = args["body"]
        if not isinstance(raw, str) or not raw.strip():
            return ToolResult.fail("请把要发的原文放进“自定义模式(内容)”的括号里。")
        body = raw
        self._pending_body = body
        self._pending_at = time.monotonic()
        return ToolResult.success({
            "body": body,
            "source": "user_authored",
            "publicationStatus": "awaiting_confirmation",
            "notice": "已接收原文；请由用户再次发送“确认发布”，才会操作当前登录的 Windows 微信朋友圈。",
        })
