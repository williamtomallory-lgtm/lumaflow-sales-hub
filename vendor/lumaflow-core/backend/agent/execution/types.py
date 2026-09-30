"""Small, transport-neutral types for execution routing."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Dict, Iterable, List


class ExecutionMode(str, Enum):
    """How a user turn should be executed."""

    AUTO = "auto"
    CHAT = "chat"
    WORK = "work"
    HYBRID = "hybrid"

    @classmethod
    def parse(cls, value: Any, default: "ExecutionMode" = None) -> "ExecutionMode":
        if isinstance(value, cls):
            return value
        try:
            return cls(str(value or "").strip().lower())
        except ValueError:
            return default or cls.AUTO


@dataclass(frozen=True)
class ExecutionDecision:
    """Auditable result of routing one turn."""

    intent: str
    mode: ExecutionMode
    confidence: float
    title: str
    requires_approval: bool = False
    suggested_tools: List[str] = field(default_factory=list)
    reason_code: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(self, "mode", ExecutionMode.parse(self.mode, ExecutionMode.CHAT))
        object.__setattr__(self, "confidence", max(0.0, min(1.0, float(self.confidence))))
        object.__setattr__(
            self,
            "suggested_tools",
            _unique_strings(self.suggested_tools),
        )

    def to_dict(self) -> Dict[str, Any]:
        result = asdict(self)
        result["mode"] = self.mode.value
        return result

    @classmethod
    def from_mapping(cls, value: Dict[str, Any]) -> "ExecutionDecision":
        return cls(
            intent=str(value.get("intent") or "general_chat"),
            mode=ExecutionMode.parse(value.get("mode"), ExecutionMode.CHAT),
            confidence=_as_float(value.get("confidence"), 0.5),
            title=str(value.get("title") or "处理用户请求")[:120],
            requires_approval=bool(value.get("requires_approval", False)),
            suggested_tools=_unique_strings(value.get("suggested_tools") or []),
            reason_code=str(value.get("reason_code") or "classifier"),
        )

    def with_allowed_tools(self, available: Iterable[str]) -> "ExecutionDecision":
        allowlist = {str(name) for name in available if name}
        return ExecutionDecision(
            intent=self.intent,
            mode=self.mode,
            confidence=self.confidence,
            title=self.title,
            requires_approval=self.requires_approval,
            suggested_tools=[name for name in self.suggested_tools if name in allowlist],
            reason_code=self.reason_code,
        )


def _unique_strings(values: Iterable[Any]) -> List[str]:
    if isinstance(values, str):
        values = [values]
    result: List[str] = []
    for value in values:
        item = str(value or "").strip()
        if item and item not in result:
            result.append(item)
    return result


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
