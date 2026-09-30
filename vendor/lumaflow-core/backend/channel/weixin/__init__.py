"""Weixin channel attachment persistence helpers."""

from .attachments import (
    WeixinAttachmentIngestor,
    WeixinAttachmentInput,
    append_legacy_attachment_text,
    legacy_attachment_text,
    normalize_weixin_attachment,
    parse_legacy_attachment_markers,
    persist_weixin_attachments,
)

__all__ = [
    "WeixinAttachmentIngestor", "WeixinAttachmentInput", "append_legacy_attachment_text",
    "legacy_attachment_text", "normalize_weixin_attachment", "parse_legacy_attachment_markers",
    "persist_weixin_attachments",
]
