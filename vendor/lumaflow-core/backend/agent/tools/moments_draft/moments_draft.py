"""Prepare an auditable draft from the current Agent's authorised files.

This deliberately returns copy and an image brief, never a publication receipt.
The copy uses only structured fields actually found in the authorised product
file and the matching brief, so an 8B model need not invent missing specs.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Mapping, Optional

from agent.tools.base_tool import BaseTool, ToolResult
from agent.tools.website_knowledge.website_knowledge import WebsiteKnowledge
from common.runtime_identity import current_identity

_SKU_RE = re.compile(r"\b[A-Z][A-Z0-9]{1,19}-[A-Z0-9-]{1,39}\b")
_FIELDS = ("名称", "功率", "材质", "颜色", "色温", "适用场景", "质保")
_BANNED = re.compile(r"色温.{0,12}(可调|调节)|可调.{0,12}色温|限时折扣|全国销量第一|当天发货|今天发货|库存|单价|专业级|高品质")


def _field(text: str, name: str) -> Optional[str]:
    match = re.search(r"(?:^|[。；;])\s*" + re.escape(name) + r"\s*[:：]\s*([^\r\n]{1,120})\s*$", text, re.M)
    return match.group(1).strip() if match else None


def _sku_product(text: str, sku: str) -> Optional[dict]:
    sections = re.split(r"(?=^SKU\s*[:：])", text, flags=re.M)
    for section in sections:
        if re.search(r"^SKU\s*[:：]\s*" + re.escape(sku) + r"\s*$", section, re.M):
            found = {name: _field(section, name) for name in _FIELDS}
            if all(found.values()):
                return found
    return None


def _draft(fields: Mapping[str, str], variant: int) -> str:
    name, power, material = (fields[key] for key in ("名称", "功率", "材质"))
    colors, temperature, scenes, warranty = (fields[key] for key in ("颜色", "色温", "适用场景", "质保"))
    if variant == 2:
        body = (
            f"{scenes}的照明方案，可以先了解{name}：{power}功率、{material}材质。"
            f"{colors}外观和{temperature}色温可选，可按空间风格与陈列需求挑选。"
            f"资料注明{warranty}质保，实际配置和安装条件请在确定方案前逐项核对。"
        )
    elif variant == 3:
        body = (
            f"想为{scenes}挑选灯光？{name}采用{material}材质，功率{power}。"
            f"{colors}外观、{temperature}色温可选，便于结合空间风格与使用需求比较。"
            f"资料注明{warranty}质保；建议先核对具体配置与安装条件，再确定方案。"
        )
    else:
        body = (
            f"{name}，{power}、{material}，适用于{scenes}。"
            f"{colors}外观与{temperature}色温可选，便于按空间风格和陈列需求挑选。"
            f"资料注明{warranty}质保；实际配置与安装条件请提前核对。"
        )
    if len(body) < 80:
        body += "欢迎告知使用空间与所需数量，我们再整理相应资料供您确认。"
    if not 80 <= len(body) <= 120 or _BANNED.search(body):
        raise ValueError("资料字段太长或存在未经证实的描述，无法安全生成 80–120 字草稿。")
    return body


class MomentsDraft(BaseTool):
    name = "moments_draft"
    description = (
        "从当前 Agent 已授权的网站运营简报和产品资料生成可核对的朋友圈正文与配图需求。"
        "自动保证正文 80–120 字，只把颜色/色温写成可选配置，不写价格、库存或未经证实的承诺。"
        "支持 variant=1/2/3 重新生成；输出只是草稿和配图建议，不会生成真实图片或发布朋友圈。"
        "最终回答请原样复制工具返回的 body 到【正文】，不要改写产品事实。"
    )
    params = {
        "type": "object",
        "properties": {
            "sku": {"type": "string", "description": "可选：运营简报中明确出现的 SKU。"},
            "variant": {"type": "integer", "minimum": 1, "maximum": 3, "default": 1,
                        "description": "草稿版本；重新生成可改为 2 或 3。"},
        },
        "additionalProperties": False,
    }

    def __init__(self, config: Optional[dict] = None):
        super().__init__()
        self.website_knowledge = WebsiteKnowledge(config or {})

    def is_available(self) -> bool:
        return self.website_knowledge.is_available()

    def execute(self, args: Dict[str, Any]) -> ToolResult:
        if not isinstance(args, Mapping) or set(args) - {"sku", "variant"}:
            return ToolResult.fail("moments_draft 只接受 sku 与 variant，Agent 身份由运行时决定。")
        variant = args.get("variant", 1)
        if type(variant) is not int or variant not in (1, 2, 3):
            return ToolResult.fail("variant 只能是 1、2 或 3。")
        requested_sku = args.get("sku")
        if requested_sku is not None and (not isinstance(requested_sku, str) or not _SKU_RE.fullmatch(requested_sku)):
            return ToolResult.fail("sku 格式无效。")
        response = self.website_knowledge.execute({"q": "运营简报", "limit": 6})
        if response.status != "success":
            return ToolResult.fail(str(response.result or "网站知识不可读取。"))
        payload = response.result
        data = payload.get("data") if isinstance(payload, Mapping) else None
        if not isinstance(data, Mapping) or data.get("agentId") != current_identity().agent_id:
            return ToolResult.fail("授权文件的 Agent 身份不匹配，拒绝生成。")
        documents = data.get("documents")
        if not isinstance(documents, list):
            return ToolResult.fail("网站知识返回格式无效。")
        briefs = [doc for doc in documents if isinstance(doc, Mapping) and isinstance(doc.get("text"), str)
                  and _field(doc["text"], "目标") and _field(doc["text"], "配图需求")]
        if len(briefs) != 1:
            return ToolResult.fail("当前授权资料中需要恰好一份可读运营简报；请先确认文件授权。")
        brief = briefs[0]
        if brief.get("truncated") is True:
            return ToolResult.fail("运营简报正文被截断，不能安全生成完整草稿。")
        target = _field(brief["text"], "目标") or ""
        candidates = _SKU_RE.findall(target)
        if requested_sku and requested_sku not in candidates:
            return ToolResult.fail("请求的 SKU 不在当前授权运营简报目标中。")
        if len(set(candidates)) != 1:
            return ToolResult.fail("运营简报目标缺少唯一 SKU，请人工核对。")
        sku = candidates[0]
        product_matches = []
        for doc in documents:
            if not isinstance(doc, Mapping) or doc.get("collection") != brief.get("collection") or not isinstance(doc.get("text"), str):
                continue
            fields = _sku_product(doc["text"], sku)
            if fields:
                product_matches.append((doc, fields))
        if len(product_matches) != 1:
            return ToolResult.fail("找不到唯一、同集合且字段齐全的产品资料，不能生成。")
        product, fields = product_matches[0]
        if product.get("truncated") is True:
            return ToolResult.fail("产品正文被截断，不能安全生成草稿。")
        try:
            body = _draft(fields, variant)
        except ValueError as error:
            return ToolResult.fail(str(error))
        picture = _field(brief["text"], "配图需求") or ""
        return ToolResult.success({
            "body": body,
            "bodyCharacters": len(body),
            "imageBrief": picture.rstrip("。；; ") + "；如使用 AI 合成图须注明 AI 示意图/非真实产品实拍。",
            "imageStatus": "not_generated",
            "publicationStatus": "draft_only",
            "sku": sku,
            "variant": variant,
            "sources": [
                {"fileName": product.get("fileName"), "collection": product.get("collection"), "citation": product.get("citation")},
                {"fileName": brief.get("fileName"), "collection": brief.get("collection"), "citation": brief.get("citation")},
            ],
            "notice": "所有资料均来自当前 Agent 授权文件；示意图不是已生成图片，草稿不是已发布朋友圈。",
        })
