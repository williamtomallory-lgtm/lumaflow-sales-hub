"""Weixin inbound attachment adapter.

The upstream Weixin channel can continue producing its legacy text marker,
for example ``[图片: <managed path>]``.  This adapter adds a durable metadata
record for every accepted image/file and returns both representations so the
existing prompt path remains compatible while Web/Work can use structured
attachment IDs.

This module does not log or inspect message bodies, does not download media,
and does not launch a Weixin client.  It only persists a path the channel has
already materialized in the current agent ``tmp`` directory.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from agent.attachments import AttachmentBatch, AttachmentError, AttachmentKind, AttachmentMetadata, AttachmentStore, RejectedAttachment

_LEGACY_MARKER_RE = re.compile(r"\[(图片|文件)\s*:\s*([^\]\r\n]+)\]")


@dataclass(frozen=True, slots=True)
class WeixinAttachmentInput:
    """Normalized input accepted from a Weixin event/file-cache adapter."""

    path: str
    name: str | None = None
    kind: str | None = None
    mime: str | None = None
    source: str = "weixin"


def _value(value: object, *keys: str, default: object = None) -> object:
    if isinstance(value, Mapping):
        for key in keys:
            if key in value:
                return value[key]
    for key in keys:
        try:
            result = getattr(value, key)
        except AttributeError:
            continue
        if result is not None:
            return result
    return default


def normalize_weixin_attachment(value: WeixinAttachmentInput | Mapping[str, Any] | object) -> WeixinAttachmentInput:
    """Coerce common Weixin file-cache shapes without reading their contents."""

    if isinstance(value, WeixinAttachmentInput):
        return value
    path = _value(value, "path", "file_path", "local_path", "cached_path", "file_cache", "file_cache_path", "cached_file_path")
    if path is None:
        raise ValueError("attachment path is required")
    return WeixinAttachmentInput(
        path=str(path),
        name=(None if _value(value, "name", "filename", "file_name") is None else str(_value(value, "name", "filename", "file_name"))),
        kind=(None if _value(value, "kind", "type", "media_type") is None else str(_value(value, "kind", "type", "media_type"))),
        mime=(None if _value(value, "mime", "mime_type", "content_type") is None else str(_value(value, "mime", "mime_type", "content_type"))),
        source=str(_value(value, "source", "source_channel", default="weixin") or "weixin"),
    )


def _marker(record: AttachmentMetadata) -> str:
    label = "图片" if record.kind == "image" else "文件"
    return f"[{label}: {record.path}]"


def _rejected_marker(item: RejectedAttachment) -> str:
    label = "图片" if item.kind == "image" else "文件"
    # Do not echo an untrusted path.  The legacy prompt receives a stable
    # marker and the UI can render the structured rejection separately.
    return f"[{label}: 未保存]"


def legacy_attachment_text(records: Iterable[AttachmentMetadata], rejected: Iterable[RejectedAttachment] = ()) -> str:
    """Render the old marker format from safe managed records only."""

    markers = [_marker(record) for record in records]
    markers.extend(_rejected_marker(item) for item in rejected)
    return " ".join(markers)


def append_legacy_attachment_text(text: str, batch: AttachmentBatch) -> str:
    """Append marker compatibility to an existing message without body logging."""

    markers = batch.legacy_text
    if not markers:
        return text
    if not text:
        return markers
    return f"{text}\n{markers}"


def persist_weixin_attachments(
    store: AttachmentStore,
    *,
    session_id: str,
    message_id: str,
    attachments: Iterable[WeixinAttachmentInput | Mapping[str, Any] | object],
) -> AttachmentBatch:
    """Persist all attachments for one inbound message.

    A bad path or oversized file becomes a structured rejection; other files in
    the same message still persist.  Rejections never retain the untrusted
    path.  The caller can attach ``batch.ids`` to its message record and pass
    ``batch.legacy_text`` through the old prompt formatter.
    """

    records: list[AttachmentMetadata] = []
    rejected: list[RejectedAttachment] = []
    for raw in attachments:
        try:
            item = normalize_weixin_attachment(raw)
            # The store validates path containment, kind, MIME, IDs, and size;
            # channel code never constructs a storage filename itself.
            record = store.persist(
                session_id=session_id,
                message_id=message_id,
                kind=item.kind,
                name=item.name,
                path=item.path,
                mime=item.mime,
                source=item.source,
            )
            records.append(record)
        except AttachmentError as error:
            try:
                item = normalize_weixin_attachment(raw)
                name = item.name or "attachment"
                kind = item.kind or "file"
            except Exception:
                name, kind = "attachment", "file"
            rejected.append(RejectedAttachment(kind=kind, name=name[:255], status="rejected", code=error.code, reason=error.reason))
        except (TypeError, ValueError) as error:
            try:
                item = normalize_weixin_attachment(raw)
                name = item.name or "attachment"
                kind = item.kind or "file"
            except Exception:
                name, kind = "attachment", "file"
            rejected.append(RejectedAttachment(kind=kind, name=name[:255], status="rejected", code="ATTACHMENT_INVALID", reason="附件元数据无效。"))
    return AttachmentBatch(records=tuple(records), rejected=tuple(rejected), legacy_text=legacy_attachment_text(records, rejected))


class WeixinAttachmentIngestor:
    """Object form of :func:`persist_weixin_attachments` for channel wiring."""

    def __init__(self, store: AttachmentStore):
        self.store = store

    def ingest(self, session_id: str, message_id: str, attachments: Iterable[WeixinAttachmentInput | Mapping[str, Any] | object]) -> AttachmentBatch:
        return persist_weixin_attachments(self.store, session_id=session_id, message_id=message_id, attachments=attachments)


def parse_legacy_attachment_markers(text: str) -> tuple[tuple[AttachmentKind, str], ...]:
    """Parse old markers for display/migration; never treats them as safe paths."""

    return tuple(("image" if label == "图片" else "file", value.strip()) for label, value in _LEGACY_MARKER_RE.findall(text))
