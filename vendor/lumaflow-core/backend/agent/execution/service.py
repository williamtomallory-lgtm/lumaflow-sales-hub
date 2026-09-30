"""Execution routing facade used by channel entry points."""

from __future__ import annotations

import threading
from typing import Iterable, Optional

from common.log import logger

from agent.execution.router import ExecutionRouter
from agent.execution.types import ExecutionDecision, ExecutionMode


class ExecutionService:
    """Classify once, constrain suggested tools, and stamp turn metadata."""

    def __init__(self, router: Optional[ExecutionRouter] = None):
        self.router = router or ExecutionRouter()

    def decide_and_stamp(
        self,
        query: str,
        context=None,
        tools: Iterable[object] = (),
        explicit_mode: object = None,
    ) -> ExecutionDecision:
        available = [
            str(getattr(tool, "name", "") or "").strip()
            for tool in (tools or ())
        ]
        available = [name for name in available if name]

        if self._is_internal(context):
            decision = ExecutionDecision(
                intent="internal_task",
                mode=ExecutionMode.WORK,
                confidence=1.0,
                title="内部任务",
                requires_approval=False,
                suggested_tools=available,
                reason_code="internal_task_bypass",
            )
        else:
            selected = explicit_mode
            if selected is None and context is not None:
                selected = context.get("execution_mode", ExecutionMode.AUTO.value)
            decision = self.router.route(
                query=query,
                explicit_mode=selected or ExecutionMode.AUTO,
                available_tools=available,
            )

        if context is not None:
            context["execution_mode"] = decision.mode.value
            context["execution_decision"] = decision.to_dict()

        logger.info(
            "[Execution] mode=%s intent=%s confidence=%.2f approval=%s reason=%s",
            decision.mode.value,
            decision.intent,
            decision.confidence,
            decision.requires_approval,
            decision.reason_code,
        )
        return decision

    @staticmethod
    def _is_internal(context) -> bool:
        if context is None:
            return False
        return bool(
            context.get("is_scheduled_task")
            or context.get("is_delegated_task")
            or context.get("is_internal_task")
            or context.get("task_source")
        )


_instance = None
_lock = threading.Lock()


def get_execution_service() -> ExecutionService:
    global _instance
    if _instance is None:
        with _lock:
            if _instance is None:
                _instance = ExecutionService()
    return _instance
