"""Secure local attachment persistence for the agent runtime.

This module intentionally uses only the Python standard library.  It stores
metadata in SQLite next to the session database and stores bytes under a
content-addressed directory below the configured agent ``tmp`` directory.
Channels pass a path that they already received from their own local cache;
the store verifies that path before it opens it.
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
import re
import sqlite3
import threading
import unicodedata
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from uuid import uuid4

from .models import AttachmentKind, AttachmentMetadata

DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
DEFAULT_CHUNK_BYTES = 1024 * 1024
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MIME_RE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+\\-]*/[a-z0-9][a-z0-9!#$&^_.+\\-]*$")
_SAFE_SOURCE_RE = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,63}$")


class AttachmentError(Exception):
    """Base error with a stable code safe for a channel/API response."""

    def __init__(self, code: str, reason: str):
        super().__init__(reason)
        self.code = code
        self.reason = reason


class AttachmentPathError(AttachmentError):
    def __init__(self, reason: str = "附件路径不在当前 agent 临时目录内。"):
        super().__init__("ATTACHMENT_PATH_DENIED", reason)


class AttachmentSizeError(AttachmentError):
    def __init__(self, reason: str = "附件超过允许的大小。"):
        super().__init__("ATTACHMENT_TOO_LARGE", reason)


class AttachmentTypeError(AttachmentError):
    def __init__(self, reason: str = "附件元数据无效。"):
        super().__init__("ATTACHMENT_INVALID", reason)


class AttachmentNotFoundError(AttachmentError):
    def __init__(self, reason: str = "附件不存在。"):
        super().__init__("ATTACHMENT_NOT_FOUND", reason)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _resolve_directory(value: os.PathLike[str] | str) -> Path:
    path = Path(value)
    if "\x00" in str(path):
        raise AttachmentPathError()
    return path.expanduser().resolve(strict=False)


def _under(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _safe_name(value: object, fallback: str = "attachment") -> str:
    raw = unicodedata.normalize("NFC", str(value or ""))
    raw = re.sub(r"[\\/]+", "_", raw)
    raw = "".join(character for character in raw if ord(character) >= 32 and ord(character) != 127)
    raw = raw.strip().strip(".")
    if not raw:
        raw = fallback
    return raw[:255]


def _safe_id(value: object, label: str) -> str:
    raw = str(value or "").strip()
    if not raw or len(raw) > 256 or any(ord(character) < 32 for character in raw):
        raise AttachmentTypeError(f"{label} 无效。")
    return raw


def _safe_mime(value: object, name: str) -> str:
    candidate = str(value or "").split(";", 1)[0].strip().lower()
    if not candidate:
        candidate = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return candidate if _MIME_RE.fullmatch(candidate) else "application/octet-stream"


def _kind(value: object, mime: str, name: str) -> AttachmentKind:
    normalized = str(value or "").strip().lower()
    if normalized in {"image", "img", "photo", "picture", "图片"}:
        return "image"
    if normalized in {"file", "document", "doc", "attachment", "文件", "附件"}:
        return "file"
    if not normalized:
        return "image" if mime.startswith("image/") else "file"
    # A file extension is never enough to make us treat unknown content as an
    # image.  Explicit channel kind or MIME is required for image semantics.
    raise AttachmentTypeError("附件类型无效。")


def _safe_source(value: object) -> str:
    raw = str(value or "weixin").strip().lower()
    if not _SAFE_SOURCE_RE.fullmatch(raw):
        raise AttachmentTypeError("附件来源无效。")
    return raw


class AttachmentStore:
    """Persist attachment metadata and content under an agent workspace.

    ``workspace_root`` is the current agent workspace.  Incoming files are
    accepted only below ``workspace_root / "tmp"`` (or the explicit
    ``tmp_root``).  Files are copied to ``tmp/attachments/<sha256>.bin`` and
    therefore do not depend on an untrusted user filename.  ``database_path``
    defaults to ``workspace_root / "sessions.sqlite3"`` so this can sit beside
    an existing session database without changing that database's schema.
    """

    def __init__(
        self,
        workspace_root: os.PathLike[str] | str,
        *,
        tmp_root: os.PathLike[str] | str | None = None,
        database_path: os.PathLike[str] | str | None = None,
        max_attachment_bytes: int = DEFAULT_MAX_ATTACHMENT_BYTES,
        chunk_bytes: int = DEFAULT_CHUNK_BYTES,
    ) -> None:
        if max_attachment_bytes <= 0 or chunk_bytes <= 0:
            raise ValueError("attachment limits must be positive")
        self.workspace_root = _resolve_directory(workspace_root)
        self.tmp_root = _resolve_directory(tmp_root or self.workspace_root / "tmp")
        if not _under(self.tmp_root, self.workspace_root):
            raise AttachmentPathError("agent 临时目录必须位于当前 workspace 内。")
        self.storage_root = (self.tmp_root / "attachments").resolve(strict=False)
        self.database_path = _resolve_directory(database_path or self.workspace_root / "sessions.sqlite3")
        self.max_attachment_bytes = max_attachment_bytes
        self.chunk_bytes = chunk_bytes
        self._lock = threading.RLock()
        self._prepare_directories()
        self._initialize_database()
        try:
            self.database_path.chmod(0o600)
        except OSError:
            pass

    def _prepare_directories(self) -> None:
        self.tmp_root.mkdir(parents=True, exist_ok=True)
        self.storage_root.mkdir(parents=True, exist_ok=True)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        # Best effort on Windows; on POSIX this prevents other local users from
        # browsing attachment bytes when the workspace was created permissively.
        for path in (self.tmp_root, self.storage_root):
            try:
                path.chmod(0o700)
            except OSError:
                pass

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        """Close every short-lived connection (important on Windows file locks)."""

        connection = self._connect()
        try:
            yield connection
        finally:
            connection.close()

    def _initialize_database(self) -> None:
        with self._lock, self._connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS attachments (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
                    name TEXT NOT NULL,
                    path TEXT NOT NULL,
                    mime TEXT NOT NULL,
                    size INTEGER NOT NULL CHECK (size >= 0),
                    hash TEXT NOT NULL CHECK (length(hash) = 64),
                    source TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status = 'stored'),
                    created_at TEXT NOT NULL,
                    UNIQUE (session_id, message_id, hash)
                );
                CREATE INDEX IF NOT EXISTS attachments_session_created_idx
                    ON attachments (session_id, created_at, id);
                CREATE INDEX IF NOT EXISTS attachments_hash_idx
                    ON attachments (hash);
                """
            )

    def _source_path(self, value: os.PathLike[str] | str) -> Path:
        if value is None:
            raise AttachmentPathError()
        raw = str(value)
        if not raw or "\x00" in raw:
            raise AttachmentPathError()
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = self.workspace_root / candidate
        try:
            resolved = candidate.expanduser().resolve(strict=True)
        except (OSError, RuntimeError):
            raise AttachmentPathError("附件文件不存在。") from None
        if not _under(resolved, self.tmp_root):
            raise AttachmentPathError()
        try:
            if not resolved.is_file():
                raise AttachmentPathError("附件文件不可读取。")
        except OSError:
            raise AttachmentPathError("附件文件不可读取。") from None
        return resolved

    def _copy_and_hash(self, source: Path) -> tuple[str, int, Path, bool]:
        """Stream the source once, enforcing the byte cap independently of stat."""

        temporary: Path | None = None
        try:
            descriptor_flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
            no_follow = getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(source, descriptor_flags | no_follow)
            try:
                digest = hashlib.sha256()
                total = 0
                temporary = self.storage_root / f".{uuid4().hex}.part"
                with os.fdopen(descriptor, "rb") as source_handle, temporary.open("xb") as target_handle:
                    descriptor = -1
                    while True:
                        chunk = source_handle.read(self.chunk_bytes)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > self.max_attachment_bytes:
                            raise AttachmentSizeError()
                        digest.update(chunk)
                        target_handle.write(chunk)
                checksum = digest.hexdigest()
            finally:
                if descriptor != -1:
                    os.close(descriptor)
            target = (self.storage_root / f"{checksum}.bin").resolve(strict=False)
            if not _under(target, self.storage_root):
                raise AttachmentPathError()
            existed = target.exists()
            if source != target and not existed:
                os.replace(temporary, target)
                temporary = None
                try:
                    target.chmod(0o600)
                except OSError:
                    pass
            elif source == target:
                # The caller is re-ingesting a previously managed file.  No
                # second copy is needed, but the temporary copy is disposable.
                existed = True
            return checksum, total, target, not existed
        except AttachmentError:
            raise
        except (OSError, ValueError) as error:
            raise AttachmentPathError("附件文件不可读取。") from error
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    @staticmethod
    def _from_row(row: sqlite3.Row) -> AttachmentMetadata:
        return AttachmentMetadata(
            id=row["id"], session_id=row["session_id"], message_id=row["message_id"],
            kind=row["kind"], name=row["name"], path=row["path"], mime=row["mime"],
            size=int(row["size"]), hash=row["hash"], source=row["source"],
            status="stored", created_at=row["created_at"],
        )

    def persist(
        self,
        *,
        session_id: str,
        message_id: str,
        kind: str | None,
        name: str | None,
        path: os.PathLike[str] | str,
        mime: str | None = None,
        source: str = "weixin",
        created_at: str | None = None,
    ) -> AttachmentMetadata:
        """Validate, content-address, and persist one inbound attachment.

        A repeated ``session_id`` + ``message_id`` + content hash is an
        idempotent duplicate.  The same bytes received in a different message
        create a second metadata row but reuse the one content-addressed file;
        message provenance is never lost while disk bytes remain deduplicated.
        """

        safe_session = _safe_id(session_id, "session_id")
        safe_message = _safe_id(message_id, "message_id")
        source_path = self._source_path(path)
        safe_name = _safe_name(name or source_path.name)
        safe_mime = _safe_mime(mime, safe_name)
        safe_kind = _kind(kind, safe_mime, safe_name)
        safe_source = _safe_source(source)
        timestamp = str(created_at or _utc_now()).strip()
        if not timestamp or len(timestamp) > 80 or any(ord(character) < 32 for character in timestamp):
            raise AttachmentTypeError("created_at 无效。")

        with self._lock:
            checksum, size, target, target_created = self._copy_and_hash(source_path)
            with self._connection() as connection:
                try:
                    connection.execute("BEGIN IMMEDIATE")
                    existing_row = connection.execute(
                        "SELECT * FROM attachments WHERE session_id = ? AND message_id = ? AND hash = ?",
                        (safe_session, safe_message, checksum),
                    ).fetchone()
                    if existing_row is not None:
                        connection.commit()
                        return replace(self._from_row(existing_row), status="duplicate")
                    identifier = str(uuid4())
                    connection.execute(
                        """
                        INSERT INTO attachments
                            (id, session_id, message_id, kind, name, path, mime, size, hash, source, status, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored', ?)
                        """,
                        (identifier, safe_session, safe_message, safe_kind, safe_name, str(target), safe_mime, size, checksum, safe_source, timestamp),
                    )
                    connection.commit()
                    return AttachmentMetadata(
                        id=identifier, session_id=safe_session, message_id=safe_message,
                        kind=safe_kind, name=safe_name, path=str(target), mime=safe_mime,
                        size=size, hash=checksum, source=safe_source, status="stored", created_at=timestamp,
                    )
                except sqlite3.IntegrityError:
                    connection.rollback()
                    existing_row = connection.execute(
                        "SELECT * FROM attachments WHERE session_id = ? AND message_id = ? AND hash = ?",
                        (safe_session, safe_message, checksum),
                    ).fetchone()
                    if existing_row is not None:
                        return replace(self._from_row(existing_row), status="duplicate")
                    raise
                except Exception:
                    connection.rollback()
                    if target_created:
                        try:
                            target.unlink(missing_ok=True)
                        except OSError:
                            pass
                    raise

    # Explicit aliases make the integration point easy to discover for channel
    # code without requiring a second storage implementation.
    save = persist
    persist_file = persist

    def get(self, attachment_id: str) -> AttachmentMetadata | None:
        identifier = _safe_id(attachment_id, "attachment_id")
        with self._lock, self._connection() as connection:
            row = connection.execute("SELECT * FROM attachments WHERE id = ?", (identifier,)).fetchone()
            return self._from_row(row) if row is not None else None

    def require(self, attachment_id: str) -> AttachmentMetadata:
        record = self.get(attachment_id)
        if record is None:
            raise AttachmentNotFoundError()
        return record

    def list(self, *, session_id: str | None = None, message_id: str | None = None) -> tuple[AttachmentMetadata, ...]:
        parameters: list[str] = []
        where: list[str] = []
        if session_id is not None:
            parameters.append(_safe_id(session_id, "session_id"))
            where.append("session_id = ?")
        if message_id is not None:
            parameters.append(_safe_id(message_id, "message_id"))
            where.append("message_id = ?")
        # ``created_at`` has millisecond precision, so two files ingested in
        # the same batch can share a timestamp. SQLite rowid preserves their
        # actual insertion order; a random UUID does not.
        query = "SELECT * FROM attachments" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY created_at, rowid"
        with self._lock, self._connection() as connection:
            rows = connection.execute(query, parameters).fetchall()
            return tuple(self._from_row(row) for row in rows)

    def find_by_hash(self, checksum: str) -> tuple[AttachmentMetadata, ...]:
        if not _SHA256_RE.fullmatch(checksum):
            raise AttachmentTypeError("附件 hash 无效。")
        with self._lock, self._connection() as connection:
            rows = connection.execute("SELECT * FROM attachments WHERE hash = ? ORDER BY created_at, id", (checksum,)).fetchall()
            return tuple(self._from_row(row) for row in rows)

    def resolve_path(self, attachment_id: str) -> Path:
        """Resolve a stored record without accepting a caller-controlled path."""

        record = self.require(attachment_id)
        candidate = Path(record.path).resolve(strict=False)
        if not _under(candidate, self.storage_root) or not candidate.is_file():
            raise AttachmentPathError("附件存储文件不可用。")
        return candidate
