"""Deterministic sales actions for narrowly recognisable user requests.

Small local models may invoke the correct tool and then rewrite its numbers
incorrectly. For statistics and source-backed Moments drafts, the final result
is therefore formatted from the tool output itself. Other questions continue
through the normal LLM loop; no file content is treated as an instruction.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, NamedTuple, Optional, Sequence


class SalesDispatch(NamedTuple):
    tool_name: str
    arguments: dict
    tool_result: Any
    response: str


def _source_lines(sources: Any) -> str:
    if not isinstance(sources, list) or not sources:
        return "来源文件未返回。"
    labels = []
    for item in sources:
        if not isinstance(item, Mapping):
            continue
        file_name = str(item.get("fileName") or "未命名文件")
        collection = "隔离虚构演示资料" if item.get("collection") == "demo" else "网站授权上传资料"
        labels.append(f"《{file_name}》（{collection}）")
    return "、".join(labels) if labels else "来源文件未返回。"


def _statistics_response(data: Mapping[str, Any]) -> str:
    metrics = data.get("metrics")
    if not isinstance(metrics, Mapping):
        return "销售统计工具没有返回有效指标；不会猜测经营数据。"
    percent = metrics.get("developmentToWonPercent")
    conversion = "无新开发客户，转化率不可计算" if percent is None else f"{percent}%"
    won_ids = data.get("wonCustomerIds")
    won_label = "、".join(str(value) for value in won_ids) if isinstance(won_ids, list) and won_ids else "无"
    duplicates = data.get("duplicates")
    skipped = len(duplicates) if isinstance(duplicates, list) else 0
    return (
        "我是 LumaFlow 销售助手。根据当前授权销售结果文件，按客户 ID 去重计算：\n"
        f"- 新开发客户：{metrics.get('newCustomerCount')}\n"
        f"- 已报价客户：{metrics.get('quotedCustomerCount')}\n"
        f"- 成交客户：{metrics.get('wonCustomerCount')}（{won_label}）\n"
        f"- 成交金额：{metrics.get('wonAmount')} 元\n"
        f"- 开发到成交转化率：{conversion}\n"
        f"- 表格内完全重复记录跳过：{skipped} 条；叙述性备注不作额外记录，冲突记录不会合并。\n"
        f"来源：{_source_lines(data.get('sources'))}。缺失毛利、成本或退款数据时不估计。"
    )


def _moments_response(data: Mapping[str, Any]) -> str:
    body = data.get("body")
    if not isinstance(body, str) or not body:
        return "朋友圈草稿工具没有返回可用正文；不会自行补写产品事实。"
    image_brief = str(data.get("imageBrief") or "暂无可核对的配图需求")
    return (
        f"【正文】\n{body}\n\n"
        f"【配图建议】\n{image_brief}（这里只给建议，尚未生成图片。）\n\n"
        f"【发布核对】\n来源：{_source_lines(data.get('sources'))}。"
        "内容为草稿，未发布朋友圈；演示资料不得用于真实销售宣传。"
    )


def _custom_moments_response(data: Mapping[str, Any]) -> str:
    if data.get("mode") == "help":
        return (
            "朋友圈有两个模式：\n"
            "1. 资料模式：先在 LumaFlow 知识库上传并授权产品资料和运营简报，"
            "然后发“朋友圈资料模式：生成文案”。我会从授权材料生成待核对草稿。\n"
            "2. 自定义模式：发“自定义模式(你写好的原文)”，全角括号也可以。"
            "括号里的内容原样接收，没有字数、SKU、简报或配图要求。\n"
            "资料模式提供核对草稿；要发布请将核对后的正文放进自定义模式括号里，再回复确认发布。"
            "个人微信 iLink 只负责聊天，获授权会话确认后由本机已登录的 Windows 微信桌面完成朋友圈操作。"
        )
    if data.get("mode") == "cancel":
        return "已取消待发布正文，本次没有发布。" if data.get("publicationStatus") == "cancelled" else "当前没有待发布正文。"
    body = data.get("body")
    if not isinstance(body, str) or not body:
        return "没有收到可用的朋友圈正文；未发布。"
    status = str(data.get("publicationStatus") or "awaiting_confirmation")
    notice = str(data.get("notice") or "")
    if data.get("mode") == "verification":
        state = "核验成功：这条正文已发布到当前账户的朋友圈。" if status == "published_verified" else "本次未能核验成功。"
        return f"【朋友圈正文】\n{body}\n\n【状态】{state}本次仅核验，没有重复发表。{notice}"
    if status == "awaiting_confirmation":
        state = "已准备，尚未发布。请回复“确认发布”执行；回复“取消发布”撤销。"
    elif status == "published_verified":
        state = f"发布成功，已在当前登录的 Windows 微信朋友圈核验。{notice}"
    elif status == "submitted_unverified":
        state = f"已尝试发表，尚未核验成功。{notice}待发布正文已清除，避免重复发布。"
    elif status == "cancelled":
        state = "已取消，本次没有发布。"
    else:
        state = f"发布器未执行发表。{notice}"
    return f"【你写的朋友圈正文】\n{body}\n\n【状态】{state}"


def _custom_moments_request(message: str) -> Optional[dict]:
    text = message or ""
    verification = re.fullmatch(r"\s*核验朋友圈\s*(?:\((?P<ascii>[\s\S]*)\)|（(?P<wide>[\s\S]*)）)\s*", text)
    if verification:
        return {"action": "verify", "body": verification.group("ascii") if verification.group("ascii") is not None else verification.group("wide")}
    if re.fullmatch(r"\s*(?:确认发布|发布确认|确认发朋友圈|确认发布朋友圈)[。！!，,、；;]?\s*", text):
        return {"action": "publish"}
    if re.fullmatch(r"\s*(?:取消发布|取消发朋友圈|撤销发布)[。！!，,、；;]?\s*", text):
        return {"action": "cancel"}
    if re.fullmatch(r"\s*朋友圈模式\s*[?？]?\s*", text):
        return {"action": "help"}
    parenthesised = re.fullmatch(
        r"\s*(?:朋友圈)?自定义模式\s*(?:\((?P<ascii>[\s\S]*)\)|（(?P<wide>[\s\S]*)）)\s*",
        text,
    )
    if parenthesised:
        return {"body": parenthesised.group("ascii") if parenthesised.group("ascii") is not None else parenthesised.group("wide")}
    custom_mode = re.match(r"^\s*(?:朋友圈)?自定义模式\s*(?:(?:内容|正文)\s*)?[:：]\s*(.*)$", text, re.S)
    if custom_mode:
        return {"body": custom_mode.group(1).strip()}
    marker = re.search(r"(?:内容|正文)\s*[:：]", text)
    if marker:
        instruction = text[:marker.start()]
        if "朋友圈" in instruction and any(word in instruction for word in ("发", "发布", "自定义")):
            return {"body": text[marker.end():].strip()}
    command = re.match(
        r"^\s*(?:(?:你)?现在)?(?:请)?(?:直接)?(?:帮我)?(?:发|发布)(?:一条|个)?朋友圈\s*[:：]\s*(.*)$",
        text, re.S,
    )
    if command:
        return {"body": command.group(1).strip()}
    command = re.match(r"^\s*自定义朋友圈\s*[:：]\s*(.*)$", text, re.S)
    if command:
        return {"body": command.group(1).strip()}
    compact = re.sub(r"\s+", "", text)
    if "朋友圈" in compact and any(word in compact for word in ("发", "发布")) and not any(
        word in compact for word in ("文案", "草稿", "重新生成", "运营简报")
    ) and len(compact) <= 24:
        return {"body": ""}
    return None


def _requested_tool(message: str) -> Optional[tuple[str, dict]]:
    custom = _custom_moments_request(message)
    if custom is not None:
        return "moments_custom", custom
    compact = re.sub(r"\s+", "", message or "")
    if compact.startswith(("朋友圈资料模式", "资料模式生成朋友圈", "资料模式朋友圈")):
        variant = 2 if "第二版" in compact or "重新生成" in compact else 3 if "第三版" in compact else 1
        return "moments_draft", {"variant": variant}
    # An edit of the user's own copy is a creative conversation, not a
    # template regeneration. Keep it in the LLM loop for that distinction.
    if "朋友圈" in compact and any(word in compact for word in ("文案", "草稿", "重新生成", "运营简报")):
        if any(word in compact for word in ("我写的", "自己写的", "按我修改", "编辑我")):
            return None
        variant = 3 if any(word in compact for word in ("第三版", "第3版", "variant=3")) else 2 if any(
            word in compact for word in ("第二版", "第2版", "variant=2", "重新生成")
        ) else 1
        return "moments_draft", {"variant": variant}
    if (
        ("销售结果" in compact or "开发到成交转化率" in compact)
        and any(word in compact for word in ("统计", "计算", "去重", "客户数", "成交金额", "转化率"))
    ):
        return "sales_statistics", {}
    return None


def try_sales_dispatch(message: str, tools: Sequence[Any]) -> Optional[SalesDispatch]:
    choice = _requested_tool(message)
    if choice is None:
        return None
    tool_name, arguments = choice
    tool = next((item for item in tools if getattr(item, "name", None) == tool_name), None)
    try:
        available = tool is not None and tool.is_available()
    except Exception:
        available = False
    if not available:
        if tool_name == "moments_custom":
            return SalesDispatch(tool_name, arguments, None, "自定义朋友圈模式暂不可用；未发布，且不需要 SKU 或运营简报。")
        return SalesDispatch(tool_name, arguments, None, "当前网站知识桥接尚未就绪；无法核对授权文件，不会编造结果。")
    try:
        result = tool.execute(arguments)
    except Exception:
        if tool_name == "moments_custom":
            return SalesDispatch(tool_name, arguments, None, "自定义朋友圈模式处理失败；未发布，请重试。")
        return SalesDispatch(tool_name, arguments, None, "授权资料工具执行失败；不会编造结果，请检查本机服务。")
    if result.status != "success":
        if tool_name == "moments_custom":
            if isinstance(result.result, Mapping):
                return SalesDispatch(tool_name, arguments, result, _custom_moments_response(result.result))
            return SalesDispatch(tool_name, arguments, result, f"{result.result} 未发布朋友圈。")
        return SalesDispatch(tool_name, arguments, result, f"无法根据当前授权文件完成请求：{result.result}")
    data = result.result
    if not isinstance(data, Mapping):
        return SalesDispatch(tool_name, arguments, result, "工具返回格式无效；不会猜测产品或销售数据。")
    response = (
        _statistics_response(data) if tool_name == "sales_statistics"
        else _custom_moments_response(data) if tool_name == "moments_custom"
        else _moments_response(data)
    )
    return SalesDispatch(tool_name, arguments, result, response)
