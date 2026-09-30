"""Compute sales metrics from authorised website knowledge tables.

This tool intentionally does not accept rows from the model.  It asks the
existing ``website_knowledge`` bridge for the current Agent's authorised
documents, parses a small, explicit table contract, and performs all totals
with :class:`decimal.Decimal`.  Narrative text around a table is never used
as a source of rows, which keeps a chat document from becoming an instruction
or an accidental second data source.
"""

from __future__ import annotations

import csv
import io
import re
import unicodedata
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from agent.tools.base_tool import BaseTool, ToolResult
from agent.tools.website_knowledge.website_knowledge import WebsiteKnowledge
from common.runtime_identity import current_identity


DEFAULT_QUERY = "销售结果"
MAX_QUERY_LENGTH = 500
DEFAULT_LIMIT = 6
MIN_LIMIT = 1
MAX_LIMIT = 6
NOTICE = "缺失毛利、退款、成本等数据，不能估算毛利、退款或其它未提供的经营指标。"

_BOOL_VALUES = {
    "是": True,
    "否": False,
    "true": True,
    "false": False,
    "yes": True,
    "no": False,
}
_MONEY_QUANTUM = Decimal("0.01")

# Header matching is intentionally conservative.  The normaliser below
# removes separators and full-width punctuation, so these aliases cover the
# Chinese contract and common English/CSV exports without accepting arbitrary
# prose as a column.
_HEADER_ALIASES: Mapping[str, Set[str]] = {
    "customer_id": frozenset(
        {
            "客户id",
            "客户编号",
            "客户标识",
            "customerid",
            "clientid",
            "customeridentifier",
            "clientidentifier",
        }
    ),
    "is_new": frozenset(
        {
            "是否新开发",
            "新开发",
            "新客户",
            "isnew",
            "isnewcustomer",
            "newcustomer",
            "newcustomerflag",
            "new",
        }
    ),
    "is_quoted": frozenset(
        {
            "是否已报价",
            "已报价",
            "是否报价",
            "isquoted",
            "quoted",
            "quotedcustomer",
            "quotedflag",
        }
    ),
    "is_won": frozenset(
        {
            "是否已成交",
            "已成交",
            "是否成交",
            "iswon",
            "won",
            "closedwon",
            "closed",
            "wonflag",
        }
    ),
    "amount": frozenset(
        {
            "成交金额",
            "成交金额元",
            "成交金额人民币",
            "成交金额cny",
            "dealamount",
            "wonamount",
            "closedamount",
            "amount",
            "amountcny",
            "revenue",
        }
    ),
}
_REQUIRED_COLUMNS = ("customer_id", "is_new", "is_quoted", "is_won", "amount")
_RMB_MARKERS = ("人民币", "rmb", "cny", "¥", "￥", "元")
_FOREIGN_MARKERS = (
    "usd",
    "us$​",
    "dollar",
    "dollars",
    "美元",
    "$",
    "eur",
    "€",
    "euro",
    "gbp",
    "£",
    "jpy",
    "日元",
    "yen",
    "cad",
    "加元",
)
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_SEPARATOR_RE = re.compile(r"^:?-{3,}:?$")
_NUMBER_RE = re.compile(r"^[+]?\d+(?:\.\d+)?$")
_GROUPED_NUMBER_RE = re.compile(r"^[+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$")


@dataclass(frozen=True)
class _Source:
    file_name: str
    collection: str
    citation: str

    def as_dict(self) -> dict:
        return {
            "fileName": self.file_name,
            "collection": self.collection,
            "citation": self.citation,
        }


@dataclass(frozen=True)
class _Record:
    customer_id: str
    is_new: bool
    is_quoted: bool
    is_won: bool
    amount: Decimal
    extra: Tuple[str, ...]
    source: _Source
    row_number: int

    @property
    def signature(self) -> Tuple[Any, ...]:
        # Decimal values compare numerically, so 2975 and 2975.00 are the same
        # record after validation.  Extra cells are retained: same metrics but
        # different notes are not "completely identical" rows.
        return (
            self.customer_id,
            self.is_new,
            self.is_quoted,
            self.is_won,
            self.amount,
            self.extra,
        )


class _TableError(ValueError):
    """A safe, model-readable table contract error."""


def _normalise_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return unicodedata.normalize("NFKC", value).strip()


def _normalise_header(value: Any) -> str:
    value = _normalise_text(value).casefold()
    # Header punctuation is presentation, not part of the column identity.
    return re.sub(r"[\s_\-./:：,，;；!?！？()（）\[\]{}]", "", value)


def _header_kind(value: Any) -> Optional[str]:
    normalised = _normalise_header(value)
    if not normalised:
        return None
    for kind, aliases in _HEADER_ALIASES.items():
        if normalised in aliases:
            return kind
        # Permit a unit/boolean hint after a known base header, e.g.
        # ``成交金额（人民币）`` or ``是否新开发（是/否）``.  Do not use a
        # loose substring match, which would turn an arbitrary note into a
        # column.
        if any(normalised.startswith(alias) for alias in aliases if len(alias) >= 3):
            suffix = normalised[len(max((a for a in aliases if normalised.startswith(a)), key=len)):]
            if suffix in {"是或否", "是否", "人民币", "元", "rmb", "cny", "yesorno", "truefalse"}:
                return kind
    return None


def _header_mapping(cells: Sequence[str]) -> Optional[Dict[str, int]]:
    mapping: Dict[str, int] = {}
    for index, cell in enumerate(cells):
        kind = _header_kind(cell)
        if kind is None:
            continue
        if kind in mapping:
            # Ambiguous duplicate headers are not safe to guess.
            return None
        mapping[kind] = index
    if any(kind not in mapping for kind in _REQUIRED_COLUMNS):
        return None
    return mapping


def _split_pipe_row(line: str) -> List[str]:
    value = line.strip()
    if value.startswith("|"):
        value = value[1:]
    if value.endswith("|") and not value.endswith("\\|"):
        value = value[:-1]
    return [_normalise_text(cell) for cell in value.split("|")]


def _is_separator_row(cells: Sequence[str]) -> bool:
    nonempty = [cell.replace(" ", "") for cell in cells if cell.strip()]
    return bool(nonempty) and all(_SEPARATOR_RE.fullmatch(cell) for cell in nonempty)


def _is_blank_row(cells: Sequence[str]) -> bool:
    return not any(cell.strip() for cell in cells)


def _parse_bool(value: str, field: str) -> bool:
    key = _normalise_text(value).casefold()
    if key not in _BOOL_VALUES:
        raise _TableError(
            "%s 只能使用 是/否、true/false 或 yes/no，实际值无效。" % field
        )
    return _BOOL_VALUES[key]


def _currency_kind(value: str) -> Tuple[str, str]:
    """Return ``(currency, numeric_text)`` after validating markers.

    The table's amount column is人民币 by contract.  Unmarked numbers inherit
    that currency.  A foreign marker is always rejected rather than silently
    converting or mixing currencies.
    """

    text = _normalise_text(value)
    lowered = text.casefold().replace(" ", "")
    foreign = [marker for marker in _FOREIGN_MARKERS if marker in lowered]
    if foreign:
        raise _TableError("成交金额包含非人民币或混用币种（%s），请人工核对。" % foreign[0])

    # Remove RMB markers only after the foreign check.  This allows forms such
    # as "人民币 2,975.00" and "¥2975" while keeping other letters invalid.
    numeric = text
    for marker in _RMB_MARKERS:
        numeric = re.sub(re.escape(marker), "", numeric, flags=re.IGNORECASE)
    numeric = numeric.replace(" ", "").replace("　", "")
    if not numeric or not (_NUMBER_RE.fullmatch(numeric) or _GROUPED_NUMBER_RE.fullmatch(numeric)):
        raise _TableError("成交金额必须是有限、非负且最多两位小数的人民币金额。")
    if "," in numeric:
        numeric = numeric.replace(",", "")
    try:
        amount = Decimal(numeric)
    except (InvalidOperation, ValueError):
        raise _TableError("成交金额不是有效的人民币数字。")
    if not amount.is_finite() or amount < 0:
        raise _TableError("成交金额必须是有限、非负的人民币金额。")
    exponent = amount.as_tuple().exponent
    if isinstance(exponent, int) and exponent < -2:
        raise _TableError("成交金额最多允许两位小数。")
    return "rmb", numeric


def _parse_amount(value: str) -> Decimal:
    _currency, numeric = _currency_kind(value)
    try:
        return Decimal(numeric).quantize(_MONEY_QUANTUM)
    except (InvalidOperation, ValueError):
        raise _TableError("成交金额不是有效的人民币数字。")


def _parse_record(
    cells: Sequence[str], mapping: Mapping[str, int], source: _Source, row_number: int
) -> _Record:
    required_max = max(mapping.values())
    if len(cells) <= required_max:
        raise _TableError("第 %s 行缺少销售表格字段，请人工核对。" % row_number)
    customer_id = _normalise_text(cells[mapping["customer_id"]])
    if not customer_id or _CONTROL_RE.search(customer_id):
        raise _TableError("第 %s 行客户 ID 无效，请人工核对。" % row_number)
    if len(customer_id) > 200:
        raise _TableError("第 %s 行客户 ID 过长，请人工核对。" % row_number)
    is_new = _parse_bool(cells[mapping["is_new"]], "是否新开发")
    is_quoted = _parse_bool(cells[mapping["is_quoted"]], "是否已报价")
    is_won = _parse_bool(cells[mapping["is_won"]], "是否已成交")
    amount = _parse_amount(cells[mapping["amount"]])

    # Preserve non-required columns in the duplicate signature.  We do not
    # derive any metrics from them, but silently merging rows with different
    # notes would violate the "completely identical" requirement.
    extra = tuple(
        _normalise_text(cell)
        for index, cell in enumerate(cells)
        if index not in mapping.values()
    )
    return _Record(
        customer_id=customer_id,
        is_new=is_new,
        is_quoted=is_quoted,
        is_won=is_won,
        amount=amount,
        extra=extra,
        source=source,
        row_number=row_number,
    )


def _looks_like_header(cells: Sequence[str]) -> bool:
    return _header_mapping(cells) is not None


def _parse_pipe_tables(text: str, source: _Source) -> List[_Record]:
    lines = text.splitlines()
    records: List[_Record] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if "|" not in line:
            index += 1
            continue
        header_cells = _split_pipe_row(line)
        mapping = _header_mapping(header_cells)
        if mapping is None:
            index += 1
            continue
        index += 1
        table_records = 0
        while index < len(lines):
            row_line = lines[index]
            if not row_line.strip():
                break
            if "|" not in row_line:
                break
            cells = _split_pipe_row(row_line)
            row_number = index + 1
            if _is_separator_row(cells):
                index += 1
                continue
            if _looks_like_header(cells):
                # A repeated header starts the next block; leave it for the
                # outer loop rather than consuming it as a data row.
                break
            _parse = _parse_record(cells, mapping, source, row_number)
            records.append(_parse)
            table_records += 1
            index += 1
        if table_records == 0:
            # A recognised header with no legal data is not a valid sales
            # table.  This is clearer than returning zero-valued statistics.
            raise _TableError("文件中的销售表格没有合法数据行。")
        # A blank/non-table line ended this table.  Advance once and continue
        # searching for another explicitly headed table.
        index += 1
    return records


def _csv_rows(text: str) -> List[List[str]]:
    try:
        reader = csv.reader(io.StringIO(text))
        return [[_normalise_text(cell) for cell in row] for row in reader]
    except (csv.Error, TypeError, ValueError) as exc:
        raise _TableError("CSV 销售表格格式无效，请人工核对。") from exc


def _parse_csv_tables(text: str, source: _Source) -> List[_Record]:
    rows = _csv_rows(text)
    records: List[_Record] = []
    header_index: Optional[int] = None
    mapping: Optional[Dict[str, int]] = None
    for index, row in enumerate(rows):
        candidate = _header_mapping(row)
        if candidate is not None:
            header_index = index
            mapping = candidate
            break
    if header_index is None or mapping is None:
        return []

    for index in range(header_index + 1, len(rows)):
        row = rows[index]
        if _is_blank_row(row):
            if records:
                break
            continue
        if _is_separator_row(row):
            continue
        if _looks_like_header(row):
            continue
        # A one-cell narrative line after a CSV table marks the end.  A row
        # with several cells is data-shaped and must fail loudly if malformed.
        if len(row) <= 1 and records:
            break
        records.append(_parse_record(row, mapping, source, index + 1))
    if header_index is not None and not records:
        raise _TableError("文件中的销售表格没有合法数据行。")
    return records


def _parse_document(document: Mapping[str, Any]) -> Tuple[List[_Record], _Source]:
    file_name = document.get("fileName")
    collection = document.get("collection")
    citation = document.get("citation")
    text = document.get("text")
    if not all(isinstance(value, str) and value.strip() for value in (file_name, collection, citation)):
        raise _TableError("网站知识文件缺少安全来源信息，无法统计。")
    if collection not in ("demo", "uploaded"):
        raise _TableError("网站知识文件 collection 无效，无法统计。")
    if document.get("truncated") is True:
        raise _TableError("文件 %s 标记 truncated=true，拒绝全量统计；请提供完整表格。" % file_name)
    if not isinstance(text, str) or not text.strip():
        return [], _Source(file_name, collection, citation)

    source = _Source(file_name, collection, citation)
    pipe_records = _parse_pipe_tables(text, source)
    if pipe_records:
        return pipe_records, source
    csv_records = _parse_csv_tables(text, source)
    return csv_records, source


def _source_key(source: _Source) -> Tuple[str, str, str]:
    return source.file_name, source.collection, source.citation


def _format_decimal(value: Decimal) -> str:
    return format(value.quantize(_MONEY_QUANTUM), "f")


def _percent(won: int, developed: int) -> Optional[str]:
    if developed == 0:
        return None  # Undefined denominator is not a zero conversion rate.
    value = (Decimal(won) * Decimal("100") / Decimal(developed)).quantize(_MONEY_QUANTUM)
    return format(value, "f")


class SalesStatistics(BaseTool):
    """Deterministically compute sales counts from an authorised table."""

    name: str = "sales_statistics"
    description: str = (
        "从当前 Agent 已授权的网站知识文件中读取销售结果表格并确定性计算客户统计。"
        "仅接受可选 documentId、q（最多 500 字符，默认“销售结果”）和 limit（1–6）；"
        "不接受模型直接传入 rows 或 agentId。只解析包含客户 ID、是否新开发、是否已报价、"
        "是否已成交、成交金额(元)列的管道表格/CSV；重复 ID 仅完全相同才跳过，冲突须人工核对。"
        "truncated=true 或无合法表格时拒绝统计；金额只按人民币 Decimal 计算，不估算毛利或退款。"
    )
    params: dict = {
        "type": "object",
        "properties": {
            "documentId": {
                "type": "string",
                "description": "可选的当前 Agent 已授权销售文件 ID。",
            },
            "q": {
                "type": "string",
                "maxLength": MAX_QUERY_LENGTH,
                "default": DEFAULT_QUERY,
                "description": "检索词，最多 500 个字符；默认检索销售结果。",
            },
            "limit": {
                "type": "integer",
                "minimum": MIN_LIMIT,
                "maximum": MAX_LIMIT,
                "default": DEFAULT_LIMIT,
                "description": "读取授权文件数，范围 1–6。",
            },
        },
        "additionalProperties": False,
    }

    def __init__(self, config: Optional[dict] = None):
        super().__init__()
        self.config = config or {}
        self.website_knowledge = WebsiteKnowledge(self.config)

    def is_available(self) -> bool:
        return self.website_knowledge.is_available()

    # -------------------------------------------------------------- arguments
    @staticmethod
    def _parse_args(args: Any) -> Tuple[Optional[dict], Optional[str]]:
        if not isinstance(args, Mapping):
            return None, "sales_statistics 参数必须是对象。"
        allowed = {"documentId", "q", "limit"}
        unexpected = set(args) - allowed
        if unexpected:
            # In particular this rejects model-supplied rows/agentId rather
            # than silently letting a caller smuggle data around the bridge.
            return None, "sales_statistics 不接受 rows、records 或 agentId；数据必须来自授权知识文件。"

        document_id = args.get("documentId")
        if document_id is not None and (
            not isinstance(document_id, str)
            or not document_id
            or len(document_id) > 80
            or _CONTROL_RE.search(document_id)
        ):
            return None, "sales_statistics 的 documentId 无效。"

        query = args.get("q", DEFAULT_QUERY)
        if not isinstance(query, str):
            return None, "sales_statistics 的 q 必须是字符串。"
        if len(query) > MAX_QUERY_LENGTH:
            return None, "sales_statistics 的 q 不能超过 500 个字符。"

        limit = args.get("limit", DEFAULT_LIMIT)
        if isinstance(limit, bool):
            return None, "sales_statistics 的 limit 必须在 1 到 6 之间。"
        if isinstance(limit, float) and limit.is_integer():
            limit = int(limit)
        elif isinstance(limit, str) and limit.strip().isdigit():
            limit = int(limit.strip())
        if not isinstance(limit, int) or not MIN_LIMIT <= limit <= MAX_LIMIT:
            return None, "sales_statistics 的 limit 必须在 1 到 6 之间。"
        return {"documentId": document_id, "q": query, "limit": limit}, None

    # -------------------------------------------------------------- extraction
    @staticmethod
    def _documents_from_result(result: ToolResult) -> Tuple[Optional[List[Mapping[str, Any]]], Optional[str]]:
        if not isinstance(result, ToolResult):
            return None, "网站知识工具返回格式无效，无法统计。"
        if result.status != "success":
            # WebsiteKnowledge's failure messages are already sanitised.
            return None, str(result.result or "网站知识检索失败，无法统计。")
        payload = result.result
        if not isinstance(payload, Mapping):
            return None, "网站知识工具返回格式无效，无法统计。"
        data = payload.get("data")
        if not isinstance(data, Mapping):
            return None, "网站知识工具缺少 data，无法统计。"
        expected = current_identity().agent_id
        if not isinstance(expected, str) or not expected.strip() or data.get("agentId") != expected:
            return None, "网站知识返回的 Agent 身份与当前运行时不一致，已拒绝统计。"
        documents = data.get("documents")
        if not isinstance(documents, list) or len(documents) > MAX_LIMIT:
            return None, "网站知识工具返回的文件列表无效，无法统计。"
        if not all(isinstance(document, Mapping) for document in documents):
            return None, "网站知识工具返回的文档无效，无法统计。"
        return documents, None

    @staticmethod
    def _deduplicate(
        records: Iterable[_Record],
    ) -> Tuple[List[_Record], List[dict]]:
        unique: List[_Record] = []
        by_id: Dict[str, _Record] = {}
        duplicates: List[dict] = []
        for record in records:
            previous = by_id.get(record.customer_id)
            if previous is None:
                by_id[record.customer_id] = record
                unique.append(record)
                continue
            if previous.signature == record.signature:
                duplicates.append(
                    {
                        "customerId": record.customer_id,
                        "fileName": record.source.file_name,
                        "collection": record.source.collection,
                        "row": record.row_number,
                        "duplicateOf": {
                            "fileName": previous.source.file_name,
                            "collection": previous.source.collection,
                            "row": previous.row_number,
                        },
                        "reason": "完全相同记录，已跳过，不重复计数。",
                    }
                )
                continue
            raise _TableError(
                "客户 ID %s 存在冲突记录（%s 与 %s），不会跨文件合并，请人工核对。"
                % (
                    record.customer_id,
                    previous.source.file_name,
                    record.source.file_name,
                )
            )
        return unique, duplicates

    @staticmethod
    def _metrics(records: Sequence[_Record]) -> Tuple[dict, List[str], List[str], List[str]]:
        new_ids = [record.customer_id for record in records if record.is_new]
        quoted_ids = [record.customer_id for record in records if record.is_quoted]
        won_records = [record for record in records if record.is_won]
        won_ids = [record.customer_id for record in won_records]
        won_amount = sum((record.amount for record in won_records), Decimal("0"))
        return {
            "newCustomerCount": len(new_ids),
            "quotedCustomerCount": len(quoted_ids),
            "wonCustomerCount": len(won_ids),
            "wonAmount": _format_decimal(won_amount),
            "developmentToWonPercent": _percent(
                sum(record.is_new for record in won_records), len(new_ids)
            ),
        }, new_ids, quoted_ids, won_ids

    # ---------------------------------------------------------------- execute
    def execute(self, args: Dict[str, Any]) -> ToolResult:
        parsed, error = self._parse_args(args)
        if error:
            return ToolResult.fail(error)

        # Never add identity or rows here. WebsiteKnowledge itself resolves
        # current_identity() and rejects model-supplied identity overrides.
        website_args = {"q": parsed["q"], "limit": parsed["limit"]}
        if parsed.get("documentId") is not None:
            website_args["documentId"] = parsed["documentId"]
        website_result = self.website_knowledge.execute(website_args)
        documents, error = self._documents_from_result(website_result)
        if error:
            return ToolResult.fail(error)
        if not documents:
            return ToolResult.fail("当前 Agent 没有可统计的授权知识文件。")

        all_records: List[_Record] = []
        source_map: Dict[Tuple[str, str, str], _Source] = {}
        found_table = False
        try:
            for document in documents:
                records, source = _parse_document(document)
                if records:
                    found_table = True
                    all_records.extend(records)
                    source_map[_source_key(source)] = source
        except _TableError as exc:
            return ToolResult.fail(str(exc))

        if not found_table:
            return ToolResult.fail("授权文件中没有合法的销售结果管道表格或 CSV，无法统计。")

        try:
            unique, duplicates = self._deduplicate(all_records)
        except _TableError as exc:
            return ToolResult.fail(str(exc))

        metrics, new_ids, quoted_ids, won_ids = self._metrics(unique)
        result = {
            "metrics": metrics,
            "newCustomerIds": new_ids,
            "quotedCustomerIds": quoted_ids,
            "wonCustomerIds": won_ids,
            "sources": [source.as_dict() for source in source_map.values()],
            "duplicates": duplicates,
            "notice": NOTICE,
        }
        return ToolResult.success(result)


__all__ = ["SalesStatistics"]
