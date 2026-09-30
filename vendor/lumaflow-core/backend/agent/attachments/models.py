"""Small, dependency-free attachment contracts shared by agent channels.

The channel is deliberately kept out of these contracts.  An attachment is a
reference to a managed local file, not the file contents themselves.  This
keeps message logging and model prompts from accidentally containing binary
data while still allowing the Weixin adapter to retain the old text marker.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal

AttachmentKind = Literal["image", "file"]
AttachmentStatus = Literal["stored", "duplicate", "rejected"]


@dataclass(frozen=True, slots=True)
class AttachmentMetadata:
    """The persisted, structured representation of one inbound attachment.

    ``path`` is always the managed copy created by :class:`AttachmentStore`,
    never an untrusted path supplied by a channel.  It is absolute so channel
    code can hand it to existing file-cache consumers; callers should not put
    it in logs or expose it outside the local agent boundary.
    """

    id: str
    session_id: str
    message_id: str
    kind: AttachmentKind
    name: str
    path: str
    mime: str
    size: int
    hash: str
    source: str
    status: AttachmentStatus
    created_at: str

    def as_dict(self) -> dict[str, Any]:
        """Return the stable wire/database shape (including the ``hash`` key)."""

        return asdict(self)

    # ``to_dict`` is a convenient spelling for channel/API serializers while
    # ``as_dict`` remains the explicit dataclass-oriented name.
    to_dict = as_dict

    @property
    def sha256(self) -> str:
        """Explicit alias for code that avoids the built-in ``hash`` name."""

        return self.hash


@dataclass(frozen=True, slots=True)
class RejectedAttachment:
    """A non-persisted attachment rejected before it could enter the store.

    The untrusted path is intentionally not retained here.  A UI can show the
    safe name and error code without echoing a path supplied by a message.
    """

    kind: AttachmentKind | str
    name: str
    status: Literal["rejected"]
    code: str
    reason: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)

    to_dict = as_dict


@dataclass(frozen=True, slots=True)
class AttachmentBatch:
    """Result of ingesting all attachments attached to one inbound message."""

    records: tuple[AttachmentMetadata, ...]
    rejected: tuple[RejectedAttachment, ...]
    legacy_text: str

    @property
    def all_succeeded(self) -> bool:
        return not self.rejected

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(record.id for record in self.records)

    @property
    def attachments(self) -> tuple[AttachmentMetadata, ...]:
        """Compatibility spelling used by message persistence callers."""

        return self.records

    def as_dict(self) -> dict[str, Any]:
        return {
            "attachments": [record.as_dict() for record in self.records],
            "rejected": [item.as_dict() for item in self.rejected],
            "legacy_text": self.legacy_text,
        }

    to_dict = as_dict
