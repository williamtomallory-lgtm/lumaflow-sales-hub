"""The WeChat sales Agent must not let the model rewrite tool facts."""

from unittest.mock import patch

import pytest

from agent.protocol.agent import Agent
from agent.tools.base_tool import BaseTool, ToolResult
from agent.tools.moments_custom import MomentsCustom


class _FakeTool(BaseTool):
    def __init__(self, name, result):
        self.name = name
        self.result = result
        self.calls = []

    def execute(self, args):
        self.calls.append(args)
        return self.result


def _agent(*tools, sales=True):
    agent = Agent("test", model=None, tools=list(tools), enable_skills=False)
    agent.sales_runtime = sales
    return agent


def test_sales_metrics_are_formatted_from_tool_not_model_and_persisted_as_tool_chain():
    tool = _FakeTool("sales_statistics", ToolResult.success({
        "metrics": {"newCustomerCount": 5, "quotedCustomerCount": 3, "wonCustomerCount": 1,
                    "wonAmount": "2975.00", "developmentToWonPercent": "20.00"},
        "wonCustomerIds": ["SYN-03"],
        "sources": [{"fileName": "03-sales-results.txt", "collection": "demo"}],
        "duplicates": [],
    }))
    agent = _agent(tool)
    events = []
    answer = agent.run_stream("根据销售结果文件按客户ID去重计算成交金额与转化率", on_event=events.append)
    assert "新开发客户：5" in answer
    assert "成交客户：1（SYN-03）" in answer
    assert "20.00%" in answer
    assert "03-sales-results.txt" in answer
    assert tool.calls == [{}]
    assert [item["role"] for item in agent._last_run_new_messages] == ["user", "assistant", "user", "assistant"]
    assert agent._last_run_new_messages[1]["content"][0]["name"] == "sales_statistics"
    assert [event["type"] for event in events][-2:] == ["message_end", "agent_end"]


def test_moments_body_is_copied_exactly_and_regeneration_selects_variant_two():
    body = "验收轨道射灯 A，18W、压铸铝，适用于服装店、展厅。黑色、白色外观与3000K、4000K色温可选，便于按空间风格和陈列需求挑选。资料注明2 年质保；实际配置与安装条件请提前核对。"
    tool = _FakeTool("moments_draft", ToolResult.success({
        "body": body,
        "bodyCharacters": len(body),
        "imageBrief": "干净的服装店灯光场景；标注 AI 示意图",
        "sources": [{"fileName": "01-products.txt", "collection": "demo"},
                    {"fileName": "04-moments-brief.txt", "collection": "demo"}],
        "publicationStatus": "draft_only", "imageStatus": "not_generated",
    }))
    agent = _agent(tool)
    answer = agent.run_stream("请基于网站运营简报，重新生成第二版朋友圈草稿，不要发布")
    assert answer.split("【正文】\n", 1)[1].split("\n\n【配图建议】", 1)[0] == body
    assert "未发布朋友圈" in answer
    assert "尚未生成图片" in answer
    assert tool.calls == [{"variant": 2}]


def test_missing_authorised_source_fails_closed_without_model_hallucination():
    tool = _FakeTool("sales_statistics", ToolResult.fail("当前 Agent 没有可统计的授权知识文件。"))
    agent = _agent(tool)
    answer = agent.run_stream("销售结果按客户ID去重统计客户数")
    assert "没有可统计的授权知识文件" in answer
    assert "成交金额：" not in answer


def test_general_agent_and_customer_question_keep_normal_model_path():
    tool = _FakeTool("sales_statistics", ToolResult.success({"metrics": {}}))
    general = _agent(tool, sales=False)
    with pytest.raises(ValueError, match="No model available"):
        general.run_stream("销售结果按客户ID去重统计客户数")
    sales = _agent(tool)
    with pytest.raises(ValueError, match="No model available"):
        sales.run_stream("PTEST-739 有什么材质？")
    assert not tool.calls


def test_user_edited_moments_copy_is_not_overwritten_by_template():
    tool = _FakeTool("moments_draft", ToolResult.success({"body": "template"}))
    agent = _agent(tool)
    with pytest.raises(ValueError, match="No model available"):
        agent.run_stream("请把我写的朋友圈草稿改短一些，保留我的语气")
    assert not tool.calls


@pytest.mark.parametrize("message", [
    "你现在帮我发个朋友圈 内容：test",
    "直接发布朋友圈：test",
    "自定义朋友圈：test",
    "朋友圈自定义模式 内容：test",
    "自定义模式(test)",
    "自定义模式（test）",
])
def test_user_authored_moments_are_preserved_without_sku_or_brief(message):
    template = _FakeTool("moments_draft", ToolResult.fail("缺少 SKU"))
    agent = _agent(MomentsCustom(), template)
    answer = agent.run_stream(message)
    assert "【你写的朋友圈正文】\ntest" in answer
    assert "尚未发布" in answer
    assert "确认发布" in answer
    assert "LUM-3000" not in answer
    assert not template.calls
    assert agent._last_run_new_messages[1]["content"][0]["name"] == "moments_custom"


def test_custom_moments_preserve_multiline_body_and_fail_closed_without_text():
    agent = _agent(MomentsCustom())
    answer = agent.run_stream("发朋友圈 内容：第一行\n第二行 #新品")
    assert "第一行\n第二行 #新品" in answer
    assert "未发布" in answer
    empty = agent.run_stream("帮我发朋友圈")
    assert "请把要发的原文放进" in empty
    assert "未发布朋友圈" in empty


def test_custom_moments_tool_stages_body_until_explicit_confirmation():
    tool = MomentsCustom()
    result = tool.execute({"body": "这只是我写的内容"})
    assert result.status == "success"
    assert result.result["body"] == "这只是我写的内容"
    assert result.result["source"] == "user_authored"
    assert result.result["publicationStatus"] == "awaiting_confirmation"
    assert tool.execute({"body": " "}).status == "error"
    assert tool.execute({"body": "x", "agentId": "other"}).status == "error"
    assert tool.execute({"body": " Test\n"}).result["body"] == " Test\n"


def test_confirmed_moments_body_calls_desktop_publisher_and_returns_receipt(monkeypatch):
    tool = MomentsCustom()
    tool.bind_runtime("owner", "wechat-service")
    monkeypatch.setenv("LUMAFLOW_MOMENTS_ALLOWED_SESSIONS", '{"wechat-service":["owner"]}')
    tool.execute({"body": "已确认的朋友圈正文"})
    with patch(
        "agent.tools.moments_custom.moments_custom.publish_moments",
        return_value=type("Result", (), {
            "status": "published_verified",
            "message": "已通过当前登录的 Windows 微信朋友圈窗口提交。",
            "provider": "windows_desktop",
        })(),
    ) as publish:
        result = tool.execute({"action": "publish"})
    publish.assert_called_once_with("已确认的朋友圈正文")
    assert result.status == "success"
    assert result.result["publicationStatus"] == "published_verified"
    assert tool.execute({"action": "publish"}).status == "error"


def test_explicit_two_mode_menu_and_source_backed_mode_are_distinct():
    custom = MomentsCustom()
    draft = _FakeTool("moments_draft", ToolResult.success({
        "body": "只依据授权文件生成的测试文案",
        "imageBrief": "仅为配图建议",
        "sources": [{"fileName": "04-moments-brief.txt", "collection": "demo"}],
    }))
    agent = _agent(custom, draft)
    menu = agent.run_stream("朋友圈模式")
    assert "1. 资料模式" in menu
    assert "2. 自定义模式" in menu
    assert "自定义模式(你写好的原文)" in menu
    assert "确认发布" in menu
    assert not draft.calls
    source_answer = agent.run_stream("朋友圈资料模式：生成文案")
    assert "只依据授权文件生成的测试文案" in source_answer
    assert "04-moments-brief.txt" in source_answer
    assert draft.calls == [{"variant": 1}]
    custom_answer = agent.run_stream("朋友圈自定义模式 内容：我的原文")
    assert "我的原文" in custom_answer
    assert draft.calls == [{"variant": 1}]


def _authorized_tool(monkeypatch, session="owner", agent_id="wechat-service"):
    monkeypatch.setenv("LUMAFLOW_MOMENTS_ALLOWED_SESSIONS", '{"wechat-service":["owner"]}')
    tool = MomentsCustom()
    tool.bind_runtime(session, agent_id)
    return tool


def test_publisher_requires_trusted_allowed_session(monkeypatch):
    for session, agent_id in (("stranger", "wechat-service"), ("owner", "other"), (None, "wechat-service")):
        tool = _authorized_tool(monkeypatch, session, agent_id)
        tool.execute({"body": "Test"})
        with patch("agent.tools.moments_custom.moments_custom.publish_moments") as publish:
            assert tool.execute({"action": "publish"}).status == "error"
            publish.assert_not_called()


def test_publication_uncertainty_clears_pending_and_does_not_claim_success(monkeypatch):
    tool = _authorized_tool(monkeypatch)
    agent = _agent(tool)
    agent.run_stream("自定义模式(Test)")
    with patch("agent.tools.moments_custom.moments_custom.publish_moments", return_value=type("Result", (), {
        "status": "submitted_unverified", "message": "检查朋友圈，暂勿重复确认。", "provider": "windows_desktop"
    })()) as publish:
        answer = agent.run_stream("确认发布")
        assert "尚未核验成功" in answer
        assert "发布成功" not in answer
        agent.run_stream("确认发布")
        publish.assert_called_once_with("Test")


def test_verified_post_is_success_and_second_confirmation_does_not_duplicate(monkeypatch):
    tool = _authorized_tool(monkeypatch)
    agent = _agent(tool)
    agent.run_stream("自定义模式(Test)")
    with patch("agent.tools.moments_custom.moments_custom.publish_moments", return_value=type("Result", (), {
        "status": "published_verified", "message": "正文已核验", "provider": "windows_desktop"
    })()) as publish:
        assert "发布成功" in agent.run_stream("确认发布！")
        assert "没有待确认" in agent.run_stream("确认发布")
        publish.assert_called_once_with("Test")


def test_pending_post_expiration_cancel_and_cross_session_isolation(monkeypatch):
    tool = _authorized_tool(monkeypatch)
    tool.execute({"body": "Test"})
    tool._pending_at -= 601
    with patch("agent.tools.moments_custom.moments_custom.publish_moments") as publish:
        assert "超过10分钟" in tool.execute({"action": "publish"}).result
        publish.assert_not_called()
    tool.execute({"body": "Test"})
    assert "已取消" in _agent(tool).run_stream("取消发布")
    assert tool._pending_body is None
    other = _authorized_tool(monkeypatch)
    tool.execute({"body": "only this session"})
    assert "没有待确认" in other.execute({"action": "publish"}).result


def test_read_only_verification_reconciles_actual_post_without_republishing(monkeypatch):
    tool = _authorized_tool(monkeypatch)
    agent = _agent(tool)
    with patch("agent.tools.moments_custom.moments_custom.publish_moments", return_value=type("Result", (), {
        "status": "published_verified", "message": "已核对正文和时间", "provider": "windows_desktop"
    })()) as publish:
        answer = agent.run_stream("核验朋友圈(Test)")
        assert "核验成功" in answer
        assert "已发布" in answer
        assert "没有重复发表" in answer
        publish.assert_called_once_with("Test", verify_only=True)


def test_verification_does_not_claim_a_failed_check_published(monkeypatch):
    tool = _authorized_tool(monkeypatch)
    with patch("agent.tools.moments_custom.moments_custom.publish_moments", return_value=type("Result", (), {
        "status": "submitted_unverified", "message": "未核对到正文", "provider": "windows_desktop"
    })()):
        answer = _agent(tool).run_stream("核验朋友圈(Test)")
        assert "未能核验成功" in answer
        assert "已尝试发表" not in answer
        assert "这条正文已发布" not in answer
