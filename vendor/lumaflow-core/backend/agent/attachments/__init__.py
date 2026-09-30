"""Shared local attachment contracts and safe persistence."""

from .models import AttachmentBatch, AttachmentMetadata, AttachmentKind, AttachmentStatus, RejectedAttachment
from .store import (
    DEFAULT_CHUNK_BYTES,
    DEFAULT_MAX_ATTACHMENT_BYTES,
    AttachmentError,
    AttachmentNotFoundError,
    AttachmentPathError,
    AttachmentSizeError,
    AttachmentStore,
    AttachmentTypeError,
)

__all__ = [
    "AttachmentBatch", "AttachmentError", "AttachmentKind", "AttachmentMetadata",
    "AttachmentNotFoundError", "AttachmentPathError", "AttachmentSizeError",
    "AttachmentStatus", "AttachmentStore", "AttachmentTypeError",
    "DEFAULT_CHUNK_BYTES", "DEFAULT_MAX_ATTACHMENT_BYTES", "RejectedAttachment",
]
