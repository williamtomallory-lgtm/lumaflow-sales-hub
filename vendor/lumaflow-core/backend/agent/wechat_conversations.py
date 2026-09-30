"""Canonical conversation and approval storage for the personal WeChat Agent.

The web/runtime layer deliberately owns routing and model execution.  This
module owns the durable state that those layers share:

* canonical messages are written through :class:`ConversationStore`;
* the small sidecar database keeps conversation/contact metadata, idempotency
  keys, approval actions, and queued work;
* message pages use a ``before:<seq>`` cursor so the newest page can be
  refreshed without losing status updates to the same message.

There is one instance of this store per WeChat Agent profile.  The sidecar is
separate from the canonical history database so old history can be read and
repaired without a schema migration, while the user-visible transcript still
has exactly one source of truth.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from common.log import logger

try:
    from agent.memory.conversation_store import (
        ConversationStore,
        _extract_display_text,
    )
except Exception:  # pragma: no cover - only useful for a very early import
    ConversationStore = Any  # type: ignore

    def _extract_display_text(value: Any) -> str:
        return value if isinstance(value, str) else str(value or "")


_ROLE_VALUES = frozenset({"user", "assistant", "system"})
_SOURCE_VALUES = frozenset({"work", "wechat"})
_MESSAGE_STATUS_VALUES = frozenset(
    {"pending", "running", "completed", "failed", "awaiting_confirmation"}
)
_DELIVERY_STATUS_VALUES = frozenset({"none", "pending", "sent", "failed"})
_ACTION_TYPES = frozenset({"send", "delete", "modify", "moments", "command"})
_ACTION_STATES = frozenset({"pending", "approved", "rejected", "failed"})
_MESSAGE_ID_RE = re.compile(r"^(?:message:)?(\d+)$")
_CURSOR_RE = re.compile(r"^(?:before:)?(\d+)$")
_PAGE_SIZE = 50
_MAX_PAGE_SIZE = 200


def utc_iso(value: Any = None) -> str:
    """Return a compact UTC ISO timestamp suitable for the TS contract."""

    if value is None:
        value = time.time()
    try:
        stamp = float(value)
    except (TypeError, ValueError):
        stamp = time.time()
    return (
        datetime.fromtimestamp(stamp, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _timestamp(value: Any = None) -> float:
    try:
        return float(value if value is not None else time.time())
    except (TypeError, ValueError):
        return time.time()


def _json(value: Any, default: Any = None) -> Any:
    if value in (None, ""):
        return default
    try:
        return json.loads(value) if isinstance(value, str) else value
    except (TypeError, ValueError):
        return default


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _text(value: Any) -> str:
    try:
        result = _extract_display_text(value)
    except Exception:
        result = value if isinstance(value, str) else str(value or "")
    return str(result or "")


def _parse_message_id(value: Any) -> Optional[int]:
    match = _MESSAGE_ID_RE.fullmatch(str(value or "").strip())
    return int(match.group(1)) if match else None


def _parse_before_cursor(value: Any) -> Optional[int]:
    if value in (None, ""):
        return None
    match = _CURSOR_RE.fullmatch(str(value).strip())
    if not match:
        raise ValueError("invalid message cursor")
    parsed = int(match.group(1))
    return parsed if parsed > 0 else None


def _limit(value: Any) -> int:
    try:
        value = int(value)
    except (TypeError, ValueError):
        return _PAGE_SIZE
    return max(1, min(_MAX_PAGE_SIZE, value))


def _safe_string(value: Any, maximum: int = 150_000) -> str:
    if value is None:
        return ""
    text = str(value)
    if len(text) > maximum:
        raise ValueError(f"text exceeds {maximum} characters")
    return text


def conversation_title(text: str) -> str:
    """Summarize the first request without another model request or contact IDs."""
    text = re.sub(r"```[^\n]*|[*#`]+", "", str(text or ""))
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"^(?:请(?:你)?|麻烦(?:你)?|帮我|给我|可以帮我)[，,\s]*", "", text.strip())
    text = re.sub(r"^帮我[，,\s]*", "", text)
    first = re.split(r"[\n。！？!?]", text, maxsplit=1)[0]
    first = re.sub(r"\s+", " ", first).strip(" ,，:：")
    return first[:32].rstrip() + ("…" if len(first) > 32 else "")


DEFAULT_CONFIG: Dict[str, Any] = {
    # Identity fields live in this sidecar as well as the Agent roster.  The
    # sidecar is the canonical source for the conversation UI, so preserving
    # them here keeps the UI stable while the roster is hot-reloaded.
    "id": "wechat-agent",
    "name": "我的微信 Agent",
    "avatarUrl": "",
    "systemPrompt": "",
    "workspace": "",
    "syncEnabled": True,
    "receiveEnabled": True,
    "dndEnabled": False,
    "knowledgeBaseIds": [],
    "knowledgeContext": "",
    "permissions": {
        "read": "auto",
        "create": "auto",
        "modify": "confirm",
        "tools": "confirm",
        "delete": "confirm",
        "send": "confirm",
        "moments": "confirm",
    },
}


class WechatConversationStore:
    """Durable canonical transcript metadata for one WeChat Agent.

    ``path`` can be a sidecar database path, an Agent workspace directory, or
    an existing canonical ``index.db`` path.  Supplying ``canonical_store`` is
    preferred by tests and by runtime code that already resolved the profile.
    """

    def __init__(
        self,
        path: os.PathLike[str] | str,
        *,
        agent_id: str = "",
        canonical_store: Optional[ConversationStore] = None,
        initial_config: Optional[Mapping[str, Any]] = None,
    ) -> None:
        self.agent_id = str(agent_id or "")
        self._lock = threading.RLock()
        self._canonical = canonical_store or self._resolve_canonical_store(path)
        self._state_path = self._resolve_state_path(path)
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_state_db()
        self._ensure_default_config(initial_config)

    # ------------------------------------------------------------------
    # Construction and SQLite helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_state_path(path: os.PathLike[str] | str) -> Path:
        candidate = Path(path).expanduser()
        if candidate.exists() and candidate.is_dir():
            return candidate / "memory" / "wechat_conversations.db"
        if candidate.suffix.lower() in {".db", ".sqlite", ".sqlite3"}:
            # The canonical file itself gets a sidecar next to it.  A caller
            # that wants a different path can pass ``wechat.db`` directly.
            if candidate.name == "index.db":
                return candidate.with_name("wechat_conversations.db")
            return candidate
        return candidate / "wechat_conversations.db"

    def _resolve_canonical_store(
        self, path: os.PathLike[str] | str
    ) -> ConversationStore:
        candidate = Path(path).expanduser()
        try:
            from agent.memory import get_conversation_store

            if candidate.exists() and candidate.is_dir():
                return get_conversation_store(str(candidate))
            # Runtime callers normally pass an Agent workspace path even when
            # it has not been created yet.  A directory-shaped path is easy to
            # recognise by its lack of a database suffix.
            if candidate.suffix.lower() not in {".db", ".sqlite", ".sqlite3"}:
                return get_conversation_store(str(candidate))
        except Exception as exc:
            logger.debug("[WeChatStore] workspace store resolution skipped: %s", exc)

        # Tests and early startup may not have a registry yet.  Keep a nearby
        # canonical index so the sidecar never becomes the transcript itself.
        if candidate.name == "index.db":
            canonical_path = candidate
        elif candidate.parent.name == "long-term":
            canonical_path = candidate.parent / "index.db"
        else:
            canonical_path = candidate.with_name("index.db")
        return ConversationStore(canonical_path, agent_id=self.agent_id)

    def _connect_state(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._state_path), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _canonical_connect(self) -> sqlite3.Connection:
        # ConversationStore initialises migrations in _connect().  Its public
        # API does not expose a row-level update helper, so after initialising
        # we use its private raw connection while holding this store lock.
        connector = getattr(self._canonical, "_connect", None)
        if connector is not None:
            return connector()
        return sqlite3.connect(str(self._canonical._db_path), timeout=10)

    def _init_state_db(self) -> None:
        with self._lock:
            conn = self._connect_state()
            try:
                conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS conversations (
                        conversation_id TEXT PRIMARY KEY,
                        title TEXT NOT NULL DEFAULT '',
                        contact_id TEXT NOT NULL DEFAULT '',
                        contact_name TEXT NOT NULL DEFAULT '',
                        recipient_name TEXT NOT NULL DEFAULT '',
                        channel_instance_id TEXT NOT NULL DEFAULT '',
                        kind TEXT NOT NULL DEFAULT 'work',
                        created_at REAL NOT NULL,
                        updated_at REAL NOT NULL,
                        active INTEGER NOT NULL DEFAULT 0,
                        metadata TEXT NOT NULL DEFAULT '{}'
                    );
                    CREATE INDEX IF NOT EXISTS idx_wechat_conv_updated
                        ON conversations(updated_at DESC, conversation_id);
                    CREATE TABLE IF NOT EXISTS config (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS client_messages (
                        client_message_id TEXT PRIMARY KEY,
                        conversation_id TEXT NOT NULL,
                        message_id TEXT NOT NULL DEFAULT '',
                        created_at REAL NOT NULL,
                        payload TEXT NOT NULL DEFAULT '{}'
                    );
                    CREATE TABLE IF NOT EXISTS incoming_messages (
                        external_message_id TEXT PRIMARY KEY,
                        conversation_id TEXT NOT NULL,
                        message_id TEXT NOT NULL DEFAULT '',
                        created_at REAL NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS actions (
                        action_id TEXT PRIMARY KEY,
                        conversation_id TEXT NOT NULL,
                        type TEXT NOT NULL,
                        title TEXT NOT NULL,
                        detail TEXT NOT NULL DEFAULT '',
                        state TEXT NOT NULL,
                        message_id TEXT NOT NULL DEFAULT '',
                        payload TEXT NOT NULL DEFAULT '{}',
                        error TEXT NOT NULL DEFAULT '',
                        created_at REAL NOT NULL,
                        updated_at REAL NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_wechat_actions_conv
                        ON actions(conversation_id, updated_at DESC);
                    CREATE TABLE IF NOT EXISTS deliveries (
                        message_id TEXT PRIMARY KEY,
                        conversation_id TEXT NOT NULL,
                        status TEXT NOT NULL,
                        attempts INTEGER NOT NULL DEFAULT 0,
                        last_error TEXT NOT NULL DEFAULT '',
                        updated_at REAL NOT NULL,
                        delivered_at REAL
                    );
                    CREATE TABLE IF NOT EXISTS jobs (
                        job_id TEXT PRIMARY KEY,
                        kind TEXT NOT NULL,
                        conversation_id TEXT NOT NULL,
                        message_id TEXT NOT NULL DEFAULT '',
                        client_message_id TEXT NOT NULL DEFAULT '',
                        text TEXT NOT NULL DEFAULT '',
                        state TEXT NOT NULL,
                        attempts INTEGER NOT NULL DEFAULT 0,
                        error TEXT NOT NULL DEFAULT '',
                        created_at REAL NOT NULL,
                        updated_at REAL NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_wechat_jobs_state
                        ON jobs(state, updated_at);
                    """
                )
                conn.commit()
            finally:
                conn.close()

    def _ensure_default_config(
        self, initial_config: Optional[Mapping[str, Any]] = None
    ) -> None:
        with self._lock:
            current = self._read_config_locked()
            if current:
                return
            config = self._normalise_config(initial_config or {})
            conn = self._connect_state()
            try:
                with conn:
                    for key, value in config.items():
                        conn.execute(
                            "INSERT OR REPLACE INTO config(key, value) VALUES (?, ?)",
                            (key, _dump(value)),
                        )
            finally:
                conn.close()

    @staticmethod
    def _normalise_config(value: Mapping[str, Any]) -> Dict[str, Any]:
        config = dict(DEFAULT_CONFIG)
        config["permissions"] = dict(DEFAULT_CONFIG["permissions"])
        if isinstance(value, Mapping):
            for key in (
                "id",
                "name",
                "avatarUrl",
                "systemPrompt",
                "workspace",
                "syncEnabled",
                "receiveEnabled",
                "dndEnabled",
                "knowledgeBaseIds",
                "knowledgeContext",
            ):
                if key in value:
                    config[key] = value[key]
            if isinstance(value.get("permissions"), Mapping):
                config["permissions"].update(value["permissions"])
        config["syncEnabled"] = bool(config["syncEnabled"])
        config["receiveEnabled"] = bool(config["receiveEnabled"])
        config["dndEnabled"] = bool(config["dndEnabled"])
        config["id"] = _safe_string(config.get("id") or DEFAULT_CONFIG["id"], 200).strip() or DEFAULT_CONFIG["id"]
        config["name"] = _safe_string(config.get("name") or DEFAULT_CONFIG["name"], 80).strip() or DEFAULT_CONFIG["name"]
        config["avatarUrl"] = _safe_string(config.get("avatarUrl") or "", 2_000)
        config["systemPrompt"] = _safe_string(config.get("systemPrompt") or "", 12_000)
        config["workspace"] = _safe_string(config.get("workspace") or "", 2_000)
        ids = config.get("knowledgeBaseIds")
        config["knowledgeBaseIds"] = (
            [str(item) for item in ids if isinstance(item, str)]
            if isinstance(ids, list)
            else []
        )
        config["knowledgeContext"] = _safe_string(
            config.get("knowledgeContext") or "", 200_000
        )
        permissions = config["permissions"]
        for key, default in DEFAULT_CONFIG["permissions"].items():
            mode = permissions.get(key, default)
            if mode not in ("auto", "confirm"):
                mode = default
            permissions[key] = mode
        # Migrate the former automatic-file preset to the full automatic mode.
        if all(permissions.get(key) == "auto" for key in ("read", "create", "modify")):
            for key in permissions:
                permissions[key] = "auto"
        return config

    def _read_config_locked(self) -> Dict[str, Any]:
        conn = self._connect_state()
        try:
            rows = conn.execute("SELECT key, value FROM config").fetchall()
            raw = {row["key"]: _json(row["value"]) for row in rows}
        finally:
            conn.close()
        return self._normalise_config(raw) if raw else {}

    # ------------------------------------------------------------------
    # Config and conversation metadata
    # ------------------------------------------------------------------

    def get_config(self) -> Dict[str, Any]:
        with self._lock:
            config = self._read_config_locked() or self._normalise_config({})
            return json.loads(_dump(config))

    def set_config(self, updates: Mapping[str, Any]) -> Dict[str, Any]:
        if not isinstance(updates, Mapping):
            raise ValueError("configuration must be an object")
        with self._lock:
            config = self._read_config_locked() or self._normalise_config({})
            merged = dict(config)
            merged["permissions"] = dict(config.get("permissions") or {})
            for key, value in updates.items():
                if key == "permissions" and isinstance(value, Mapping):
                    merged["permissions"].update(value)
                elif key in merged:
                    merged[key] = value
            merged = self._normalise_config(merged)
            conn = self._connect_state()
            try:
                with conn:
                    for key, value in merged.items():
                        conn.execute(
                            "INSERT OR REPLACE INTO config(key, value) VALUES (?, ?)",
                            (key, _dump(value)),
                        )
            finally:
                conn.close()
            return json.loads(_dump(merged))

    def _upsert_conversation_locked(
        self,
        conversation_id: str,
        *,
        title: Optional[str] = None,
        contact_id: Optional[str] = None,
        contact_name: Optional[str] = None,
        recipient_name: Optional[str] = None,
        channel_instance_id: Optional[str] = None,
        kind: Optional[str] = None,
        touch: bool = True,
    ) -> None:
        conversation_id = _safe_string(conversation_id, 200).strip()
        if not conversation_id:
            raise ValueError("conversation_id is required")
        now = time.time()
        conn = self._connect_state()
        try:
            with conn:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO conversations
                      (conversation_id, title, contact_id, contact_name,
                       recipient_name, channel_instance_id, kind,
                       created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        conversation_id,
                        _safe_string(title or conversation_id, 120),
                        _safe_string(contact_id or "", 200),
                        _safe_string(contact_name or "", 80),
                        _safe_string(recipient_name or "", 80),
                        _safe_string(channel_instance_id or "", 120),
                        "wechat" if contact_id else (kind or "work"),
                        now,
                        now,
                    ),
                )
                assignments = []
                values: List[Any] = []
                for column, value, maximum in (
                    ("title", title, 120),
                    ("contact_id", contact_id, 200),
                    ("contact_name", contact_name, 80),
                    ("recipient_name", recipient_name, 80),
                    ("channel_instance_id", channel_instance_id, 120),
                    ("kind", kind, 20),
                ):
                    if value is not None:
                        assignments.append(f"{column} = ?")
                        values.append(_safe_string(value, maximum))
                if touch:
                    assignments.append("updated_at = ?")
                    values.append(now)
                if assignments:
                    values.append(conversation_id)
                    conn.execute(
                        f"UPDATE conversations SET {', '.join(assignments)} WHERE conversation_id = ?",
                        values,
                    )
        finally:
            conn.close()

    def create_conversation(self, title: Optional[str] = None) -> Dict[str, Any]:
        conversation_id = f"work-{uuid.uuid4().hex}"
        with self._lock:
            self._upsert_conversation_locked(
                conversation_id,
                title=(title or "新对话").strip() or "新对话",
                kind="work",
            )
            self._set_current_locked(conversation_id)
            return self.get_conversation(conversation_id) or {
                "id": conversation_id,
                "title": title or "新对话",
            }

    def update_conversation(self, conversation_id: str, updates: Mapping[str, Any]) -> Dict[str, Any]:
        if not updates or set(updates) - {"title", "pinned", "archived"}:
            raise ValueError("invalid conversation changes")
        if "title" in updates and not _safe_string(updates["title"], 120).strip():
            raise ValueError("title is required")
        for key in ("pinned", "archived"):
            if key in updates and not isinstance(updates[key], bool):
                raise ValueError(f"{key} must be boolean")
        with self._lock:
            if self.get_conversation(conversation_id) is None:
                raise KeyError(conversation_id)
            conn = self._connect_state()
            try:
                row = conn.execute("SELECT metadata FROM conversations WHERE conversation_id = ?", (conversation_id,)).fetchone()
                metadata = _json(row["metadata"], {}) or {}
                for key in ("pinned", "archived"):
                    if key in updates:
                        metadata[key] = updates[key]
                if "title" in updates:
                    metadata["customTitle"] = True
                with conn:
                    conn.execute("UPDATE conversations SET metadata = ? WHERE conversation_id = ?", (_dump(metadata), conversation_id))
                    if "title" in updates:
                        conn.execute("UPDATE conversations SET title = ? WHERE conversation_id = ?", (updates["title"].strip(), conversation_id))
            finally:
                conn.close()
            return self.get_conversation(conversation_id) or {}

    def delete_conversation(self, conversation_id: str) -> None:
        with self._lock:
            if self.get_conversation(conversation_id) is None:
                raise KeyError(conversation_id)
            conn = self._connect_state()
            try:
                busy = conn.execute("SELECT 1 FROM jobs WHERE conversation_id = ? AND state IN ('queued', 'retry', 'running') LIMIT 1", (conversation_id,)).fetchone()
                pending = conn.execute("SELECT 1 FROM actions WHERE conversation_id = ? AND state = 'pending' LIMIT 1", (conversation_id,)).fetchone()
                if busy or pending:
                    raise ValueError("会话正在工作或有待确认操作，请处理完成后再删除")
                self._canonical.clear_session(conversation_id)
                with conn:
                    for table in ("conversations", "client_messages", "incoming_messages", "actions", "deliveries", "jobs"):
                        conn.execute(f"DELETE FROM {table} WHERE conversation_id = ?", (conversation_id,))
                if self.current_conversation_id() == conversation_id:
                    self._set_current_locked(None)
            finally:
                conn.close()

    def _set_current_locked(self, conversation_id: Optional[str]) -> None:
        conn = self._connect_state()
        try:
            with conn:
                conn.execute(
                    "UPDATE conversations SET active = 0 WHERE active = 1"
                )
                if conversation_id:
                    conn.execute(
                        "UPDATE conversations SET active = 1 WHERE conversation_id = ?",
                        (conversation_id,),
                    )
                conn.execute(
                    "INSERT OR REPLACE INTO config(key, value) VALUES (?, ?)",
                    ("currentConversationId", _dump(conversation_id)),
                )
        finally:
            conn.close()

    def current_conversation_id(self) -> Optional[str]:
        with self._lock:
            conn = self._connect_state()
            try:
                row = conn.execute(
                    "SELECT value FROM config WHERE key = 'currentConversationId'"
                ).fetchone()
            finally:
                conn.close()
            value = _json(row["value"]) if row else None
            return str(value) if value else None

    def activate(self, conversation_id: str) -> Dict[str, Any]:
        conversation_id = _safe_string(conversation_id, 200).strip()
        with self._lock:
            conversation = self.get_conversation(conversation_id)
            if conversation is None:
                # A legacy canonical session may predate the sidecar metadata.
                if not self._canonical_session_exists(conversation_id):
                    raise KeyError(conversation_id)
                self._upsert_conversation_locked(
                    conversation_id, title=conversation_id, kind="wechat"
                )
            self._set_current_locked(conversation_id)
            return self.get_conversation(conversation_id) or {
                "id": conversation_id,
                "title": conversation_id,
            }

    def _canonical_session_exists(self, conversation_id: str) -> bool:
        with self._canonical_connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM sessions WHERE agent_id = ? AND session_id = ?",
                (getattr(self._canonical, "_agent_id", self.agent_id), conversation_id),
            ).fetchone()
        return bool(row)

    def set_receiver(
        self,
        conversation_id: str,
        receiver: str,
        *,
        contact_name: str = "",
        recipient_name: str = "",
        channel_instance_id: str = "",
    ) -> Dict[str, Any]:
        receiver = _safe_string(receiver, 200).strip()
        if not receiver:
            raise ValueError("receiver is required")
        with self._lock:
            existing = self.get_conversation(conversation_id)
            self._upsert_conversation_locked(
                conversation_id,
                title=(existing["title"] if existing and existing.get("customTitle") else contact_name or conversation_id),
                contact_id=receiver,
                contact_name=contact_name,
                recipient_name=recipient_name,
                channel_instance_id=channel_instance_id,
                kind="wechat",
            )
            return self.get_conversation(conversation_id) or {}

    def get_receiver(self, conversation_id: str) -> Optional[str]:
        with self._lock:
            conn = self._connect_state()
            try:
                row = conn.execute(
                    "SELECT contact_id FROM conversations WHERE conversation_id = ?",
                    (conversation_id,),
                ).fetchone()
            finally:
                conn.close()
            return str(row["contact_id"]) if row and row["contact_id"] else None

    def get_conversation(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        conn = self._connect_state()
        try:
            row = conn.execute(
                "SELECT * FROM conversations WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            return None
        return self._conversation_public(dict(row))

    def _canonical_sessions(self) -> Dict[str, Dict[str, Any]]:
        sessions: Dict[str, Dict[str, Any]] = {}
        try:
            conn = self._canonical_connect()
            try:
                aid = getattr(self._canonical, "_agent_id", self.agent_id)
                rows = conn.execute(
                    """
                    SELECT session_id, title, channel_type, created_at, last_active
                    FROM sessions WHERE agent_id = ?
                    """,
                    (aid,),
                ).fetchall()
            finally:
                conn.close()
        except Exception as exc:
            logger.warning("[WeChatStore] canonical session listing failed: %s", exc)
            return sessions
        for row in rows:
            sid = str(row[0])
            sessions[sid] = {
                "id": sid,
                "title": str(row[1] or sid)[:120],
                "created_at": float(row[3] or 0),
                "updated_at": float(row[4] or row[3] or 0),
                "kind": "wechat" if str(row[2] or "") in {"weixin", "wechat"} else "work",
            }
        return sessions

    def list_conversations(
        self, cursor: Optional[str] = None, limit: int = _PAGE_SIZE
    ) -> Dict[str, Any]:
        limit = _limit(limit)
        with self._lock:
            canonical = self._canonical_sessions()
            conn = self._connect_state()
            try:
                rows = [dict(row) for row in conn.execute("SELECT * FROM conversations").fetchall()]
            finally:
                conn.close()
            for row in rows:
                sid = row["conversation_id"]
                existing = canonical.get(sid, {})
                existing.update(
                    {
                        "id": sid,
                        "metadata": row["metadata"],
                        "title": row["title"] or existing.get("title") or sid,
                        "created_at": min(
                            float(row["created_at"] or time.time()),
                            float(existing.get("created_at") or row["created_at"] or time.time()),
                        ),
                        "updated_at": max(
                            float(row["updated_at"] or 0),
                            float(existing.get("updated_at") or 0),
                        ),
                    }
                )
                canonical[sid] = existing
            ordered = sorted(
                canonical.values(),
                key=lambda row: (float(row.get("updated_at") or 0), row["id"]),
                reverse=True,
            )
            if cursor:
                token = str(cursor)
                if token.startswith("before:"):
                    token = token[7:]
                ids = [row["id"] for row in ordered]
                if token in ids:
                    ordered = ordered[ids.index(token) + 1 :]
            has_more = len(ordered) > limit
            page = list(reversed(ordered[:limit]))
            # `ordered` is newest first; the UI renders each page oldest first.
            items = [self._conversation_public(row) for row in page]
            for item in items:
                item["preview"] = self._conversation_preview(item["id"])
            next_cursor = f"before:{page[0]['id']}" if has_more and page else None
            return {"items": items, "nextCursor": next_cursor}

    def _conversation_preview(self, conversation_id: str) -> Optional[str]:
        try:
            conn = self._canonical_connect()
            try:
                aid = getattr(self._canonical, "_agent_id", self.agent_id)
                row = conn.execute(
                    """
                    SELECT content FROM messages
                    WHERE agent_id = ? AND session_id = ?
                    ORDER BY seq DESC LIMIT 1
                    """,
                    (aid, conversation_id),
                ).fetchone()
            finally:
                conn.close()
            if row:
                text = _text(_json(row[0], row[0])).strip()
                return text[:500] if text else None
        except Exception:
            pass
        return None

    def _conversation_public(self, row: Mapping[str, Any]) -> Dict[str, Any]:
        metadata = _json(row.get("metadata"), {}) or {}
        conversation_id = str(row.get("id") or row.get("conversation_id") or "")
        title = str(row.get("title") or "新对话")
        if not metadata.get("customTitle"):
            conn = self._canonical_connect()
            try:
                first = conn.execute(
                    "SELECT content FROM messages WHERE agent_id = ? AND session_id = ? AND role = 'user' ORDER BY seq ASC LIMIT 1",
                    (getattr(self._canonical, "_agent_id", self.agent_id), conversation_id),
                ).fetchone()
            finally:
                conn.close()
            if first:
                title = conversation_title(_text(_json(first[0], first[0]))) or "新对话"
            elif title == conversation_id or "@im.wechat" in title:
                title = "新对话"
        return {
            "id": conversation_id,
            "title": title[:120],
            "createdAt": utc_iso(row.get("created_at")),
            "updatedAt": utc_iso(row.get("updated_at")),
            "pinned": bool(metadata.get("pinned")),
            "archived": bool(metadata.get("archived")),
            "customTitle": bool(metadata.get("customTitle")),
        }

    # ------------------------------------------------------------------
    # Canonical message writes and idempotency
    # ------------------------------------------------------------------

    def _find_message_by_extra(self, key: str, value: str) -> Optional[Dict[str, Any]]:
        if not value:
            return None
        try:
            conn = self._canonical_connect()
            try:
                aid = getattr(self._canonical, "_agent_id", self.agent_id)
                rows = conn.execute(
                    """
                    SELECT id, agent_id, session_id, seq, role, content,
                           created_at, extras
                    FROM messages
                    WHERE agent_id = ? AND extras LIKE ?
                    ORDER BY id DESC
                    """,
                    (aid, f'%"{key}":%'),
                ).fetchall()
            finally:
                conn.close()
        except Exception:
            return None
        for row in rows:
            extras = _json(row[7], {}) or {}
            if str(extras.get(key) or "") == str(value):
                return self._message_public_from_row(row)
        return None

    def get_message_by_client_id(self, client_message_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            conn = self._connect_state()
            try:
                row = conn.execute(
                    "SELECT message_id FROM client_messages WHERE client_message_id = ?",
                    (client_message_id,),
                ).fetchone()
            finally:
                conn.close()
            if row and row["message_id"]:
                return self.get_message(row["message_id"])
            return self._find_message_by_extra("clientMessageId", client_message_id)

    def add_message(
        self,
        conversation_id: str,
        role: str,
        text: str,
        source: str,
        client_message_id: Optional[str] = None,
        **metadata: Any,
    ) -> Dict[str, Any]:
        conversation_id = _safe_string(conversation_id, 200).strip()
        role = str(role or "")
        source = str(source or "")
        if role not in _ROLE_VALUES:
            raise ValueError("invalid message role")
        if source not in _SOURCE_VALUES:
            raise ValueError("invalid message source")
        text = _safe_string(text)
        client_message_id = (
            _safe_string(client_message_id, 200).strip()
            if client_message_id
            else ""
        )
        with self._lock:
            if client_message_id:
                existing = self.get_message_by_client_id(client_message_id)
                if existing:
                    if existing.get("conversationId") != conversation_id:
                        raise ValueError("clientMessageId already belongs to another conversation")
                    return existing
            self._upsert_conversation_locked(
                conversation_id,
                title=metadata.get("title") or None,
                contact_id=metadata.get("receiver") or metadata.get("contact_id") or None,
                contact_name=metadata.get("sender_name") or None,
                recipient_name=metadata.get("recipient_name") or None,
                channel_instance_id=metadata.get("channel_instance_id") or None,
                kind="wechat" if source == "wechat" else "work",
            )
            extras: Dict[str, Any] = {
                "source": source,
                "status": metadata.get("status") or "completed",
                "deliveryStatus": metadata.get("delivery_status")
                or metadata.get("deliveryStatus")
                or "none",
            }
            if client_message_id:
                extras["clientMessageId"] = client_message_id
            for key in (
                "sender_name",
                "recipient_name",
                "external_message_id",
                "run_id",
                "error",
            ):
                if metadata.get(key) not in (None, ""):
                    extras[key] = metadata[key]
            extra = metadata.get("extras")
            if isinstance(extra, Mapping):
                extras.update(extra)
            if extras["status"] not in _MESSAGE_STATUS_VALUES:
                raise ValueError("invalid message status")
            if extras["deliveryStatus"] not in _DELIVERY_STATUS_VALUES:
                raise ValueError("invalid delivery status")
            # ConversationStore writes the extras together with the message,
            # keeping the canonical row readable even if the process stops
            # immediately after this method returns.
            self._canonical.append_messages(
                conversation_id,
                [{"role": role, "content": text, "extras": extras}],
                channel_type="weixin" if source == "wechat" else "web",
            )
            row = self._latest_canonical_row(conversation_id)
            if row is None:
                raise RuntimeError("canonical message was not written")
            message = self._message_public_from_row(row)
            if client_message_id:
                conn = self._connect_state()
                try:
                    with conn:
                        conn.execute(
                            """
                            INSERT OR REPLACE INTO client_messages
                              (client_message_id, conversation_id, message_id,
                               created_at, payload)
                            VALUES (?, ?, ?, ?, ?)
                            """,
                            (
                                client_message_id,
                                conversation_id,
                                message["id"],
                                time.time(),
                                _dump({"source": source}),
                            ),
                        )
                finally:
                    conn.close()
            return message

    def record_incoming(
        self,
        external_message_id: str,
        conversation_id: str,
        text: str,
        *,
        sender_name: str = "",
        recipient_name: str = "",
        channel_instance_id: str = "",
        status: str = "running",
        **metadata: Any,
    ) -> Tuple[Dict[str, Any], bool]:
        """Append one inbound WeChat message exactly once across restarts."""

        external_message_id = _safe_string(external_message_id, 300).strip()
        if not external_message_id:
            raise ValueError("external_message_id is required")
        with self._lock:
            conn = self._connect_state()
            try:
                row = conn.execute(
                    "SELECT message_id FROM incoming_messages WHERE external_message_id = ?",
                    (external_message_id,),
                ).fetchone()
            finally:
                conn.close()
            if row and row["message_id"]:
                existing = self.get_message(row["message_id"])
                if existing:
                    return existing, False
            existing = self._find_message_by_extra(
                "externalMessageId", external_message_id
            )
            if existing:
                return existing, False
            message = self.add_message(
                conversation_id,
                "user",
                text,
                "wechat",
                sender_name=sender_name,
                recipient_name=recipient_name,
                channel_instance_id=channel_instance_id,
                status=status,
                external_message_id=external_message_id,
                extras={"externalMessageId": external_message_id, **metadata},
            )
            conn = self._connect_state()
            try:
                with conn:
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO incoming_messages
                          (external_message_id, conversation_id, message_id, created_at)
                        VALUES (?, ?, ?, ?)
                        """,
                        (external_message_id, conversation_id, message["id"], time.time()),
                    )
            finally:
                conn.close()
            return message, True

    def _latest_canonical_row(self, conversation_id: str):
        conn = self._canonical_connect()
        try:
            aid = getattr(self._canonical, "_agent_id", self.agent_id)
            return conn.execute(
                """
                SELECT id, agent_id, session_id, seq, role, content,
                       created_at, extras
                FROM messages
                WHERE agent_id = ? AND session_id = ?
                ORDER BY seq DESC LIMIT 1
                """,
                (aid, conversation_id),
            ).fetchone()
        finally:
            conn.close()

    def get_message(self, message_id: str) -> Optional[Dict[str, Any]]:
        numeric = _parse_message_id(message_id)
        if numeric is None:
            return None
        with self._lock:
            conn = self._canonical_connect()
            try:
                aid = getattr(self._canonical, "_agent_id", self.agent_id)
                row = conn.execute(
                    """
                    SELECT id, agent_id, session_id, seq, role, content,
                           created_at, extras
                    FROM messages WHERE id = ? AND agent_id = ?
                    """,
                    (numeric, aid),
                ).fetchone()
            finally:
                conn.close()
            return self._message_public_from_row(row) if row else None

    def update_message(self, message_id: str, **fields: Any) -> Dict[str, Any]:
        numeric = _parse_message_id(message_id)
        if numeric is None:
            raise KeyError(message_id)
        with self._lock:
            conn = self._canonical_connect()
            try:
                aid = getattr(self._canonical, "_agent_id", self.agent_id)
                row = conn.execute(
                    """
                    SELECT id, agent_id, session_id, seq, role, content,
                           created_at, extras
                    FROM messages WHERE id = ? AND agent_id = ?
                    """,
                    (numeric, aid),
                ).fetchone()
                if row is None:
                    raise KeyError(message_id)
                extras = _json(row[7], {}) or {}
                if not isinstance(extras, dict):
                    extras = {}
                content = _json(row[5], row[5])
                if "text" in fields:
                    content = _safe_string(fields["text"])
                for key, value in fields.items():
                    if key in {"status", "delivery_status", "deliveryStatus", "source"}:
                        target = {
                            "delivery_status": "deliveryStatus",
                            "deliveryStatus": "deliveryStatus",
                        }.get(key, key)
                        if target == "status" and value not in _MESSAGE_STATUS_VALUES:
                            raise ValueError("invalid message status")
                        if target == "deliveryStatus" and value not in _DELIVERY_STATUS_VALUES:
                            raise ValueError("invalid delivery status")
                        if target == "source" and value not in _SOURCE_VALUES:
                            raise ValueError("invalid message source")
                        extras[target] = value
                    elif key in {
                        "sender_name",
                        "recipient_name",
                        "externalMessageId",
                        "clientMessageId",
                        "error",
                    }:
                        if value not in (None, ""):
                            extras[key] = value
                    elif key == "extras" and isinstance(value, Mapping):
                        extras.update(value)
                with conn:
                    conn.execute(
                        "UPDATE messages SET content = ?, extras = ? WHERE id = ? AND agent_id = ?",
                        (_dump(content), _dump(extras), numeric, aid),
                    )
            finally:
                conn.close()
            updated = self.get_message(str(numeric))
            if updated is None:
                raise KeyError(message_id)
            return updated

    # ------------------------------------------------------------------
    # Message pagination and action lifecycle
    # ------------------------------------------------------------------

    def list_messages(
        self,
        conversation_id: str,
        cursor: Optional[str] = None,
        limit: int = _PAGE_SIZE,
    ) -> Dict[str, Any]:
        limit = _limit(limit)
        before = _parse_before_cursor(cursor)
        with self._lock:
            conn = self._canonical_connect()
            try:
                aid = getattr(self._canonical, "_agent_id", self.agent_id)
                query = """
                    SELECT id, agent_id, session_id, seq, role, content,
                           created_at, extras
                    FROM messages
                    WHERE agent_id = ? AND session_id = ?
                """
                args: List[Any] = [aid, conversation_id]
                if before is not None:
                    query += " AND seq < ?"
                    args.append(before)
                query += " ORDER BY seq DESC LIMIT ?"
                args.append(limit + 1)
                rows = conn.execute(query, args).fetchall()
            finally:
                conn.close()
            has_more = len(rows) > limit
            rows = list(reversed(rows[:limit]))
            items = [self._message_public_from_row(row) for row in rows]
            next_cursor = f"before:{rows[0][3]}" if has_more and rows else None
            return {
                "items": items,
                "nextCursor": next_cursor,
                "pendingActions": self._actions_public(conversation_id),
            }

    def _message_public_from_row(self, row: Any) -> Dict[str, Any]:
        if isinstance(row, sqlite3.Row):
            values = [row[index] for index in range(8)]
        else:
            values = list(row)
        numeric_id, _agent, conversation_id, seq, role, raw_content, created_at, raw_extras = values
        content = _json(raw_content, raw_content)
        extras = _json(raw_extras, {}) or {}
        if not isinstance(extras, dict):
            extras = {}
        source = extras.get("source")
        if source not in _SOURCE_VALUES:
            source = "wechat" if extras.get("externalMessageId") else "work"
        status = extras.get("status") or "completed"
        if status not in _MESSAGE_STATUS_VALUES:
            status = "completed"
        delivery = extras.get("deliveryStatus") or extras.get("delivery_status")
        if delivery not in _DELIVERY_STATUS_VALUES:
            delivery = "none"
        result: Dict[str, Any] = {
            "id": str(numeric_id),
            "conversationId": str(conversation_id),
            "role": role if role in _ROLE_VALUES else "system",
            "text": _text(content),
            "createdAt": utc_iso(created_at),
            "source": source,
            "status": status,
            "deliveryStatus": delivery,
        }
        for output_key, input_key in (
            ("senderName", "sender_name"),
            ("recipientName", "recipient_name"),
        ):
            if extras.get(input_key):
                result[output_key] = str(extras[input_key])[:80]
        return result

    def create_action(
        self,
        conversation_id: str,
        action_type: str,
        title: str,
        detail: str = "",
        payload: Optional[Mapping[str, Any]] = None,
        message_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        if action_type not in _ACTION_TYPES:
            raise ValueError("invalid action type")
        conversation_id = _safe_string(conversation_id, 200).strip()
        action_id = f"action-{uuid.uuid4().hex}"
        now = time.time()
        with self._lock:
            if self.get_conversation(conversation_id) is None:
                self._upsert_conversation_locked(conversation_id, kind="work")
            conn = self._connect_state()
            try:
                with conn:
                    conn.execute(
                        """
                        INSERT INTO actions
                          (action_id, conversation_id, type, title, detail, state,
                           message_id, payload, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
                        """,
                        (
                            action_id,
                            conversation_id,
                            action_type,
                            _safe_string(title, 200),
                            _safe_string(detail, 150_000),
                            _safe_string(message_id or "", 200),
                            _dump(dict(payload or {})),
                            now,
                            now,
                        ),
                    )
            finally:
                conn.close()
            return self._action_public(self._get_action_row(action_id))

    def _get_action_row(self, action_id: str):
        conn = self._connect_state()
        try:
            return conn.execute(
                "SELECT * FROM actions WHERE action_id = ?", (action_id,)
            ).fetchone()
        finally:
            conn.close()

    def get_action(self, action_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._get_action_row(action_id)
            if row is None:
                return None
            result = dict(row)
            result["payload"] = _json(result.get("payload"), {}) or {}
            return result

    def claim_action(self, action_id: str, approved: bool) -> Optional[Dict[str, Any]]:
        """Consume a pending approval exactly once.

        A second click, a retry from a lost HTTP response, or a stale tab gets
        ``None`` and cannot execute the same external operation twice.
        """

        now = time.time()
        state = "approved" if bool(approved) else "rejected"
        with self._lock:
            conn = self._connect_state()
            try:
                with conn:
                    cur = conn.execute(
                        """
                        UPDATE actions SET state = ?, updated_at = ?
                        WHERE action_id = ? AND state = 'pending'
                        """,
                        (state, now, action_id),
                    )
                if cur.rowcount != 1:
                    return None
                row = conn.execute(
                    "SELECT * FROM actions WHERE action_id = ?", (action_id,)
                ).fetchone()
            finally:
                conn.close()
            result = dict(row) if row else None
            if result is not None:
                result["payload"] = _json(result.get("payload"), {}) or {}
            return result

    def finish_action(
        self, action_id: str, state: str, error: str = ""
    ) -> Optional[Dict[str, Any]]:
        if state not in _ACTION_STATES:
            raise ValueError("invalid action state")
        with self._lock:
            conn = self._connect_state()
            try:
                with conn:
                    conn.execute(
                        "UPDATE actions SET state = ?, error = ?, updated_at = ? WHERE action_id = ?",
                        (state, _safe_string(error, 2_000), time.time(), action_id),
                    )
            finally:
                conn.close()
            row = self._get_action_row(action_id)
            if row is None:
                return None
            return self._action_public(row)

    def _action_public(self, row: Any) -> Dict[str, Any]:
        if row is None:
            return {}
        value = dict(row)
        result: Dict[str, Any] = {
            "id": value.get("action_id", ""),
            "conversationId": value.get("conversation_id", ""),
            "type": value.get("type", "command"),
            "title": value.get("title", ""),
            "state": value.get("state", "pending"),
        }
        if value.get("detail"):
            result["detail"] = value["detail"]
        if value.get("message_id"):
            result["messageId"] = value["message_id"]
        return result

    def _actions_public(self, conversation_id: str) -> List[Dict[str, Any]]:
        conn = self._connect_state()
        try:
            rows = conn.execute(
                """
                SELECT * FROM actions WHERE conversation_id = ?
                ORDER BY updated_at DESC LIMIT 100
                """,
                (conversation_id,),
            ).fetchall()
        finally:
            conn.close()
        return [self._action_public(row) for row in rows]

    # ------------------------------------------------------------------
    # Delivery and queued work helpers used by the runtime layer
    # ------------------------------------------------------------------

    def set_delivery(
        self,
        message_id: str,
        conversation_id: str,
        status: str,
        *,
        error: str = "",
        increment_attempt: bool = False,
    ) -> Optional[Dict[str, Any]]:
        if status not in _DELIVERY_STATUS_VALUES:
            raise ValueError("invalid delivery status")
        current = self.get_message(message_id)
        if current is None:
            return None
        attempts_delta = 1 if increment_attempt else 0
        with self._lock:
            conn = self._connect_state()
            try:
                with conn:
                    conn.execute(
                        """
                        INSERT INTO deliveries(message_id, conversation_id, status,
                          attempts, last_error, updated_at, delivered_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(message_id) DO UPDATE SET
                          status=excluded.status,
                          attempts=deliveries.attempts + excluded.attempts,
                          last_error=excluded.last_error,
                          updated_at=excluded.updated_at,
                          delivered_at=excluded.delivered_at
                        """,
                        (
                            str(message_id),
                            conversation_id,
                            status,
                            attempts_delta,
                            _safe_string(error, 2_000),
                            time.time(),
                            time.time() if status == "sent" else None,
                        ),
                    )
            finally:
                conn.close()
        return self.update_message(
            message_id,
            delivery_status=status,
            status="completed" if status == "sent" else "failed" if status == "failed" else current.get("status", "pending"),
            extras={"deliveryError": error} if error else {},
        )

    def enqueue_job(
        self,
        kind: str,
        conversation_id: str,
        message_id: str = "",
        client_message_id: str = "",
        text: str = "",
    ) -> Dict[str, Any]:
        job_id = f"job-{uuid.uuid4().hex}"
        now = time.time()
        with self._lock:
            conn = self._connect_state()
            try:
                with conn:
                    conn.execute(
                        """
                        INSERT INTO jobs(job_id, kind, conversation_id, message_id,
                          client_message_id, text, state, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
                        """,
                        (
                            job_id,
                            _safe_string(kind, 40),
                            conversation_id,
                            message_id,
                            client_message_id,
                            _safe_string(text),
                            now,
                            now,
                        ),
                    )
            finally:
                conn.close()
        return {"jobId": job_id, "state": "queued", "conversationId": conversation_id}

    def claim_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            conn = self._connect_state()
            try:
                with conn:
                    cur = conn.execute(
                        """
                        UPDATE jobs SET state = 'running', attempts = attempts + 1,
                          updated_at = ?
                        WHERE job_id = ? AND state IN ('queued', 'retry')
                        """,
                        (time.time(), job_id),
                    )
                if cur.rowcount != 1:
                    return None
                row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
            finally:
                conn.close()
            return dict(row) if row else None

    def finish_job(self, job_id: str, state: str, error: str = "") -> Optional[Dict[str, Any]]:
        if state not in {"queued", "retry", "completed", "failed"}:
            raise ValueError("invalid job state")
        with self._lock:
            conn = self._connect_state()
            try:
                with conn:
                    conn.execute(
                        "UPDATE jobs SET state = ?, error = ?, updated_at = ? WHERE job_id = ?",
                        (state, _safe_string(error, 2_000), time.time(), job_id),
                    )
                row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
            finally:
                conn.close()
            return dict(row) if row else None

    def recover_jobs(self) -> List[Dict[str, Any]]:
        """Return unfinished jobs and make interrupted runs claimable again."""
        with self._lock:
            conn = self._connect_state()
            try:
                with conn:
                    conn.execute(
                        "UPDATE jobs SET state = 'queued', updated_at = ? WHERE state = 'running'",
                        (time.time(),),
                    )
                rows = conn.execute(
                    "SELECT * FROM jobs WHERE state IN ('queued', 'retry') ORDER BY created_at"
                ).fetchall()
            finally:
                conn.close()
            return [dict(row) for row in rows]


# Friendly alias used by a few runtime call sites and tests.
WeChatConversationStore = WechatConversationStore


__all__ = [
    "DEFAULT_CONFIG",
    "WechatConversationStore",
    "WeChatConversationStore",
    "utc_iso",
]
