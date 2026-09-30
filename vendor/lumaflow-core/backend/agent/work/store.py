"""SQLite persistence for long-running Agent work.

The work database deliberately uses a connection per operation.  Together with
WAL mode, a SQLite busy timeout, and a process-local lock shared by database
path, this keeps the store safe when web handlers and background workers use it
from different threads.
"""

import json
import math
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple, Union


WORK_STATUSES = frozenset(
    {
        "pending",
        "queued",
        "running",
        "awaiting_approval",
        "completed",
        "failed",
        "cancelled",
    }
)
APPROVAL_STATUSES = frozenset(
    {"not_required", "pending", "approved", "rejected"}
)

_DB_LOCKS: Dict[str, threading.RLock] = {}
_DB_LOCKS_GUARD = threading.Lock()
_UNSET = object()


class WorkNotFoundError(KeyError):
    """Raised when an update targets a work item that does not exist."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalized_path(path: Path) -> str:
    return os.path.normcase(os.path.realpath(str(path)))


def _lock_for_path(path: Path) -> threading.RLock:
    key = _normalized_path(path)
    with _DB_LOCKS_GUARD:
        lock = _DB_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _DB_LOCKS[key] = lock
        return lock


def _require_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("%s must be a non-empty string" % field)
    return value.strip()


def _validate_status(value: str) -> str:
    if value not in WORK_STATUSES:
        raise ValueError(
            "invalid work status %r; expected one of %s"
            % (value, ", ".join(sorted(WORK_STATUSES)))
        )
    return value


def _validate_approval_status(value: str, requires_approval: bool) -> str:
    if value not in APPROVAL_STATUSES:
        raise ValueError(
            "invalid approval status %r; expected one of %s"
            % (value, ", ".join(sorted(APPROVAL_STATUSES)))
        )
    if requires_approval and value == "not_required":
        raise ValueError("approval status cannot be 'not_required' for approval work")
    if not requires_approval and value != "not_required":
        raise ValueError("approval status must be 'not_required' when approval is disabled")
    return value


def _validate_progress(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("progress must be a number between 0 and 100")
    number = float(value)
    if not math.isfinite(number) or number < 0 or number > 100:
        raise ValueError("progress must be a finite number between 0 and 100")
    return number


def _validate_pagination(offset: int, limit: int) -> Tuple[int, int]:
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a non-negative integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > 1000:
        raise ValueError("limit must be an integer between 1 and 1000")
    return offset, limit


def _json_dumps(value: Any, field: str) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("%s must be JSON serializable: %s" % (field, exc)) from exc


def _json_loads(value: Optional[str], fallback: Any) -> Any:
    if value is None:
        return fallback
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        # A damaged JSON field must not make the entire work list unreadable.
        return fallback


class WorkStore:
    """Thread-safe SQLite repository for work items."""

    def __init__(self, db_path: Optional[Union[str, Path]] = None):
        if db_path is None:
            data_dir = os.environ.get("COW_DATA_DIR")
            root = Path(data_dir).expanduser() if data_dir else Path.home() / ".cow"
            db_path = root / "work" / "index.db"
        self.db_path = Path(db_path).expanduser().resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = _lock_for_path(self.db_path)
        self._initialize()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.db_path), timeout=10, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 10000")
        try:
            yield conn
        finally:
            conn.close()

    def _initialize(self) -> None:
        with self._lock, self._connection() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS _work_store_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS work_items (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    progress REAL NOT NULL DEFAULT 0,
                    requires_approval INTEGER NOT NULL DEFAULT 0,
                    approval_status TEXT NOT NULL DEFAULT 'not_required',
                    input TEXT NOT NULL DEFAULT '{}',
                    output TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    CHECK (status IN ('pending', 'queued', 'running',
                        'awaiting_approval', 'completed', 'failed', 'cancelled')),
                    CHECK (progress >= 0 AND progress <= 100),
                    CHECK (requires_approval IN (0, 1)),
                    CHECK (approval_status IN
                        ('not_required', 'pending', 'approved', 'rejected'))
                );

                CREATE INDEX IF NOT EXISTS idx_work_items_updated
                    ON work_items(updated_at DESC, id DESC);
                CREATE INDEX IF NOT EXISTS idx_work_items_session
                    ON work_items(session_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_work_items_agent
                    ON work_items(agent_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_work_items_status
                    ON work_items(status, updated_at DESC);

                CREATE TABLE IF NOT EXISTS activity_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    work_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    message TEXT NOT NULL,
                    data TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (work_id) REFERENCES work_items(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_activity_events_work_id
                    ON activity_events(work_id, id);
                """
            )
            # Keep this store's schema version namespaced.  The caller may
            # intentionally place these tables in CowAgent's conversation DB,
            # whose global PRAGMA user_version must remain untouched.
            conn.execute(
                "INSERT OR REPLACE INTO _work_store_meta (key, value) VALUES (?, ?)",
                ("schema_version", "1"),
            )
            conn.commit()

    @staticmethod
    def _work_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "id": row["id"],
            "session_id": row["session_id"],
            "agent_id": row["agent_id"],
            "title": row["title"],
            "kind": row["kind"],
            "status": row["status"],
            "progress": row["progress"],
            "requires_approval": bool(row["requires_approval"]),
            "approval_status": row["approval_status"],
            "input": _json_loads(row["input"], {}),
            "output": _json_loads(row["output"], None),
            "error": row["error"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def create_work_item(
        self,
        session_id: str,
        agent_id: str,
        title: str,
        kind: str,
        input: Any = None,
        work_id: Optional[str] = None,
        status: str = "pending",
        progress: Any = 0,
        requires_approval: bool = False,
        approval_status: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a work item, or return the existing row for the same id.

        ``work_id`` is an idempotency key: repeated calls never add a second
        row or overwrite the original request.
        """

        session_id = _require_text(session_id, "session_id")
        agent_id = _require_text(agent_id, "agent_id")
        title = _require_text(title, "title")
        kind = _require_text(kind, "kind")
        work_id = _require_text(work_id or str(uuid.uuid4()), "work_id")
        status = _validate_status(status)
        progress = _validate_progress(progress)
        if not isinstance(requires_approval, bool):
            raise ValueError("requires_approval must be a boolean")
        if approval_status is None:
            approval_status = "pending" if requires_approval else "not_required"
        approval_status = _validate_approval_status(
            approval_status, requires_approval
        )
        encoded_input = _json_dumps({} if input is None else input, "input")
        now = _utc_now()

        with self._lock, self._connection() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO work_items (
                    id, session_id, agent_id, title, kind, status, progress,
                    requires_approval, approval_status, input, output, error,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
                """,
                (
                    work_id,
                    session_id,
                    agent_id,
                    title,
                    kind,
                    status,
                    progress,
                    int(requires_approval),
                    approval_status,
                    encoded_input,
                    now,
                    now,
                ),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM work_items WHERE id = ?", (work_id,)
            ).fetchone()
        return self._work_from_row(row)

    # Concise aliases make the repository convenient in execution services.
    create_work = create_work_item

    def get_work_item(self, work_id: str) -> Optional[Dict[str, Any]]:
        work_id = _require_text(work_id, "work_id")
        with self._lock, self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM work_items WHERE id = ?", (work_id,)
            ).fetchone()
        return self._work_from_row(row) if row is not None else None

    get_work = get_work_item

    def _filters(
        self,
        session_id: Optional[str],
        agent_id: Optional[str],
        status: Optional[str],
    ) -> Tuple[str, List[Any]]:
        clauses = []
        params: List[Any] = []
        if session_id is not None:
            clauses.append("session_id = ?")
            params.append(_require_text(session_id, "session_id"))
        if agent_id is not None:
            clauses.append("agent_id = ?")
            params.append(_require_text(agent_id, "agent_id"))
        if status is not None:
            clauses.append("status = ?")
            params.append(_validate_status(status))
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        return where, params

    def list_work_items(
        self,
        offset: int = 0,
        limit: int = 50,
        session_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        status: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        offset, limit = _validate_pagination(offset, limit)
        where, params = self._filters(session_id, agent_id, status)
        params.extend([limit, offset])
        with self._lock, self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM work_items%s "
                "ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?" % where,
                params,
            ).fetchall()
        return [self._work_from_row(row) for row in rows]

    list_work = list_work_items

    def list_work_items_page(
        self,
        offset: int = 0,
        limit: int = 50,
        session_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        status: Optional[str] = None,
    ) -> Dict[str, Any]:
        offset, limit = _validate_pagination(offset, limit)
        where, params = self._filters(session_id, agent_id, status)
        with self._lock, self._connection() as conn:
            total = conn.execute(
                "SELECT COUNT(*) FROM work_items%s" % where, params
            ).fetchone()[0]
            rows = conn.execute(
                "SELECT * FROM work_items%s "
                "ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?" % where,
                params + [limit, offset],
            ).fetchall()
        return {
            "items": [self._work_from_row(row) for row in rows],
            "offset": offset,
            "limit": limit,
            "total": total,
        }

    def _update(self, work_id: str, values: Dict[str, Any]) -> Dict[str, Any]:
        work_id = _require_text(work_id, "work_id")
        if not values:
            item = self.get_work_item(work_id)
            if item is None:
                raise WorkNotFoundError(work_id)
            return item
        values["updated_at"] = _utc_now()
        assignments = ", ".join("%s = ?" % key for key in values)
        params = list(values.values()) + [work_id]
        with self._lock, self._connection() as conn:
            cursor = conn.execute(
                "UPDATE work_items SET %s WHERE id = ?" % assignments, params
            )
            if cursor.rowcount != 1:
                conn.rollback()
                raise WorkNotFoundError(work_id)
            conn.commit()
            row = conn.execute(
                "SELECT * FROM work_items WHERE id = ?", (work_id,)
            ).fetchone()
        return self._work_from_row(row)

    def update_progress(self, work_id: str, progress: Any) -> Dict[str, Any]:
        return self._update(work_id, {"progress": _validate_progress(progress)})

    def update_status(
        self,
        work_id: str,
        status: str,
        progress: Any = _UNSET,
        output: Any = _UNSET,
        error: Any = _UNSET,
    ) -> Dict[str, Any]:
        status = _validate_status(status)
        values: Dict[str, Any] = {"status": status}
        if progress is not _UNSET:
            values["progress"] = _validate_progress(progress)
        elif status == "completed":
            values["progress"] = 100.0
        if output is not _UNSET:
            values["output"] = _json_dumps(output, "output")
        if error is not _UNSET:
            if error is not None and not isinstance(error, str):
                raise ValueError("error must be a string or None")
            values["error"] = error
        return self._update(work_id, values)

    def set_approval_status(
        self, work_id: str, approval_status: str
    ) -> Dict[str, Any]:
        item = self.get_work_item(work_id)
        if item is None:
            raise WorkNotFoundError(work_id)
        approval_status = _validate_approval_status(
            approval_status, item["requires_approval"]
        )
        return self._update(work_id, {"approval_status": approval_status})

    update_approval = set_approval_status

    def activity_feed(self) -> "ActivityFeed":
        return ActivityFeed(self)


class ActivityFeed:
    """Append-only, cursor-readable event stream for work items."""

    def __init__(
        self,
        db_path: Optional[Union[str, Path, WorkStore]] = None,
        store: Optional[WorkStore] = None,
    ):
        if isinstance(db_path, WorkStore):
            if store is not None:
                raise ValueError("pass either db_path or store, not both")
            store = db_path
        self.store = store or WorkStore(db_path)
        self.db_path = self.store.db_path
        self._lock = self.store._lock

    @staticmethod
    def _event_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "id": row["id"],
            "work_id": row["work_id"],
            "type": row["type"],
            "message": row["message"],
            "data": _json_loads(row["data"], {}),
            "created_at": row["created_at"],
        }

    def append_event(
        self,
        work_id: str,
        event_type: str,
        message: str,
        data: Any = None,
    ) -> Dict[str, Any]:
        work_id = _require_text(work_id, "work_id")
        event_type = _require_text(event_type, "event_type")
        if not isinstance(message, str):
            raise ValueError("message must be a string")
        encoded_data = _json_dumps({} if data is None else data, "data")
        now = _utc_now()
        with self._lock, self.store._connection() as conn:
            try:
                cursor = conn.execute(
                    """
                    INSERT INTO activity_events
                        (work_id, type, message, data, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (work_id, event_type, message, encoded_data, now),
                )
                conn.commit()
            except sqlite3.IntegrityError as exc:
                conn.rollback()
                if self.store.get_work_item(work_id) is None:
                    raise WorkNotFoundError(work_id) from exc
                raise
            row = conn.execute(
                "SELECT * FROM activity_events WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
        return self._event_from_row(row)

    append = append_event

    def get_event(self, event_id: int) -> Optional[Dict[str, Any]]:
        if isinstance(event_id, bool) or not isinstance(event_id, int) or event_id < 1:
            raise ValueError("event_id must be a positive integer")
        with self._lock, self.store._connection() as conn:
            row = conn.execute(
                "SELECT * FROM activity_events WHERE id = ?", (event_id,)
            ).fetchone()
        return self._event_from_row(row) if row is not None else None

    def list_events(
        self,
        work_id: Optional[str] = None,
        after_id: Optional[int] = None,
        offset: int = 0,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        offset, limit = _validate_pagination(offset, limit)
        clauses = []
        params: List[Any] = []
        if work_id is not None:
            clauses.append("work_id = ?")
            params.append(_require_text(work_id, "work_id"))
        if after_id is not None:
            if isinstance(after_id, bool) or not isinstance(after_id, int) or after_id < 0:
                raise ValueError("after_id must be a non-negative integer")
            clauses.append("id > ?")
            params.append(after_id)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        params.extend([limit, offset])
        with self._lock, self.store._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM activity_events%s "
                "ORDER BY id ASC LIMIT ? OFFSET ?" % where,
                params,
            ).fetchall()
        return [self._event_from_row(row) for row in rows]

    read_events = list_events

    def list_events_page(
        self,
        work_id: Optional[str] = None,
        after_id: Optional[int] = None,
        offset: int = 0,
        limit: int = 50,
    ) -> Dict[str, Any]:
        offset, limit = _validate_pagination(offset, limit)
        clauses = []
        params: List[Any] = []
        if work_id is not None:
            clauses.append("work_id = ?")
            params.append(_require_text(work_id, "work_id"))
        if after_id is not None:
            if isinstance(after_id, bool) or not isinstance(after_id, int) or after_id < 0:
                raise ValueError("after_id must be a non-negative integer")
            clauses.append("id > ?")
            params.append(after_id)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self._lock, self.store._connection() as conn:
            total = conn.execute(
                "SELECT COUNT(*) FROM activity_events%s" % where, params
            ).fetchone()[0]
            rows = conn.execute(
                "SELECT * FROM activity_events%s "
                "ORDER BY id ASC LIMIT ? OFFSET ?" % where,
                params + [limit, offset],
            ).fetchall()
        return {
            "items": [self._event_from_row(row) for row in rows],
            "offset": offset,
            "limit": limit,
            "total": total,
        }
