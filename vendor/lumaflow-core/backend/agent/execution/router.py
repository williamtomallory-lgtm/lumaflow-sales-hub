"""Deterministic-first router for chat and durable sales work."""

from __future__ import annotations

import json
import re
from typing import Callable, Iterable, Optional

from agent.execution.types import ExecutionDecision, ExecutionMode

Classifier = Callable[[str, Iterable[str]], object]


class ExecutionRouter:
    """Route common intents without spending an LLM call.

    An optional structured classifier handles ambiguous language. Classifier
    failures are deliberately safe: a normal chat reply remains possible and
    no durable work starts by accident.
    """

    _WORK_PATTERNS = (
        r"整理(?:全部|所有|一下)", r"批量", r"导出", r"生成.*(?:excel|xlsx|pdf|报告|表格)",
        r"做.*报价", r"生成(?:一份|个)?报价", r"创建(?:一份|个)?报价",
        r"更新(?:crm|客户|跟进)", r"写入(?:crm|系统|数据库)", r"建(?:立|一个).*(?:任务|提醒)",
        r"(?:创建|新增|安排).*(?:跟进|提醒|任务)", r"分析(?:最近|过去|本周|本月|今天)",
        r"汇总(?:今天|本周|本月|全部|所有)", r"生成.*(?:计划|清单)",
        r"export\b", r"create\b.*(?:quote|report|task|follow.?up)", r"update\b.*(?:crm|customer)",
    )
    _LOOKUP_PATTERNS = (
        r"查(?:一下|询)?", r"有没有", r"还有多少", r"库存", r"规格", r"参数", r"价格",
        r"图片", r"证书", r"对比", r"推荐", r"怎么回复", r"哪(?:个|款)", r"多少[瓦w]",
        r"\bfind\b", r"\bsearch\b", r"\blook\s*up\b", r"\bstock\b", r"\binventory\b",
    )
    _APPROVAL_PATTERNS = (
        r"特价", r"折扣", r"优惠", r"付款条款", r"账期", r"承诺.*(?:交货|发货)",
        r"签(?:署|订).*合同", r"退款", r"删除", r"群发", r"直接发(?:给|到)",
        r"special price", r"discount", r"payment terms", r"contract", r"refund", r"send to customer",
    )

    def __init__(self, classifier: Optional[Classifier] = None):
        self.classifier = classifier

    def route(
        self,
        query: str,
        explicit_mode: object = ExecutionMode.AUTO,
        available_tools: Iterable[str] = (),
    ) -> ExecutionDecision:
        text = str(query or "").strip()
        mode = ExecutionMode.parse(explicit_mode)
        available = list(available_tools)

        if re.match(r"^\s*(?:/work\b|工作模式[:：])", text, re.I):
            return ExecutionDecision(intent="local_computer_work", mode=ExecutionMode.WORK,
                                     confidence=1.0, title=self._title(text), requires_approval=False,
                                     suggested_tools=["local_computer"], reason_code="explicit_computer_work").with_allowed_tools(available)

        if mode is not ExecutionMode.AUTO:
            return self._explicit(text, mode).with_allowed_tools(available)

        work = self._matches_any(text, self._WORK_PATTERNS)
        lookup = self._matches_any(text, self._LOOKUP_PATTERNS)
        approval = self._matches_any(text, self._APPROVAL_PATTERNS)

        if work:
            # A report/export may naturally contain data words such as "库存";
            # that is still one durable job. HYBRID is reserved for an explicit
            # two-stage request (look something up, *then* create/update work).
            chained = lookup and self._matches_any(
                text,
                (r"然后", r"再(?:做|生成|创建|更新|导出)", r"之后", r"接着", r"\bthen\b"),
            )
            decision_mode = ExecutionMode.HYBRID if chained else ExecutionMode.WORK
            intent = "lookup_then_business_work" if chained else "business_work"
            return ExecutionDecision(
                intent=intent,
                mode=decision_mode,
                confidence=0.94 if chained else 0.92,
                title=self._title(text),
                requires_approval=approval,
                suggested_tools=self._suggest_tools(text, decision_mode),
                reason_code="deterministic_hybrid" if chained else "deterministic_work",
            ).with_allowed_tools(available)

        if lookup:
            return ExecutionDecision(
                intent="sales_lookup",
                mode=ExecutionMode.CHAT,
                confidence=0.90,
                title=self._title(text),
                requires_approval=approval,
                suggested_tools=self._suggest_tools(text, ExecutionMode.CHAT),
                reason_code="deterministic_lookup",
            ).with_allowed_tools(available)

        classified = self._classify(text, available)
        if classified is not None:
            return classified.with_allowed_tools(available)

        return ExecutionDecision(
            intent="general_chat",
            mode=ExecutionMode.CHAT,
            confidence=0.55,
            title=self._title(text),
            requires_approval=approval,
            reason_code="safe_chat_fallback",
        )

    def _classify(self, query: str, available_tools) -> Optional[ExecutionDecision]:
        if not self.classifier:
            return None
        try:
            value = self.classifier(query, available_tools)
            if isinstance(value, str):
                value = json.loads(value)
            if not isinstance(value, dict):
                return None
            decision = ExecutionDecision.from_mapping(value)
            if decision.mode is ExecutionMode.AUTO:
                return None
            return decision
        except Exception:
            return None

    @staticmethod
    def _matches_any(text: str, patterns) -> bool:
        return any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in patterns)

    @staticmethod
    def _title(text: str) -> str:
        compact = re.sub(r"\s+", " ", text).strip()
        return (compact[:60] or "处理用户请求")

    def _suggest_tools(self, text: str, mode: ExecutionMode):
        result = []
        if self._matches_any(text, (r"产品", r"灯", r"sku", r"规格", r"参数", r"推荐")):
            result.append("product_search")
        if self._matches_any(text, (r"库存", r"还有多少", r"stock", r"inventory")):
            result.append("inventory_lookup")
        if self._matches_any(text, (r"报价", r"quote", r"价格")):
            result.append("quotation_draft")
        if self._matches_any(text, (r"excel", r"xlsx", r"表格", r"导出")):
            result.append("export_spreadsheet")
        if mode in (ExecutionMode.WORK, ExecutionMode.HYBRID):
            result.append("create_work_item")
        return result

    def _explicit(self, text: str, mode: ExecutionMode) -> ExecutionDecision:
        return ExecutionDecision(
            intent="explicit_execution_mode",
            mode=mode,
            confidence=1.0,
            title=self._title(text),
            requires_approval=self._matches_any(text, self._APPROVAL_PATTERNS),
            suggested_tools=self._suggest_tools(text, mode),
            reason_code=f"explicit_{mode.value}",
        )
