"""Prompt contract for an optional Qwen execution classifier."""

CLASSIFIER_SYSTEM_PROMPT = """You route requests for a sales workspace.
Return one JSON object only, with keys:
intent, mode, confidence, title, requires_approval, suggested_tools, reason_code.
mode must be chat, work, or hybrid.

chat: answer or retrieve information immediately.
work: create/update/export/batch-process a durable business artifact.
hybrid: an immediate lookup is required before durable work.
requires_approval must be true for external sends, discounts, payment terms,
delivery promises, contracts, destructive changes, or other consequential writes.
Never invent tool names; choose only from the supplied allowlist.
"""


def build_classifier_prompt(query: str, available_tools) -> str:
    tools = ", ".join(sorted({str(item) for item in available_tools if item})) or "none"
    return f"Available tools: {tools}\nUser request: {query}"
