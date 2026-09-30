from types import SimpleNamespace

from agent.capabilities import build_capability_prompt, build_sales_system_prompt, constrain_sales_tools, effective_role_ids, uses_sales_runtime


def _profile(**overrides):
    values = {
        "id": "wechat-service",
        "name": "微信客服 Agent",
        "description": "处理客户咨询",
        "agent_type": "weixin_personal",
        "role_ids": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_legacy_named_agent_gets_its_matching_role():
    assert effective_role_ids(_profile()) == ("wechat-service",)


def test_composed_roles_are_injected_with_publish_boundary():
    prompt = build_capability_prompt(
        _profile(role_ids=("wechat-service", "sales-review", "moments-operator"))
    )

    assert "微信客服" in prompt
    assert "销售复盘" in prompt
    assert "朋友圈运营" in prompt
    assert "第二次明确确认" in prompt
    assert "只有本机明确授权的会话" in prompt
    assert "其他会话不得操作本机账户" in prompt


def test_sales_runtime_omits_general_admin_tools_and_keeps_actual_knowledge_reads():
    tools = [SimpleNamespace(name=name) for name in ("read", "bash", "browser", "website_knowledge", "env_config", "write", "memory_search")]
    assert [tool.name for tool in constrain_sales_tools(_profile(), tools)] == ["read", "website_knowledge"]
    general = _profile(id="default", agent_type=None, role_ids=None)
    assert not uses_sales_runtime(general)
    assert constrain_sales_tools(general, tools) is tools


def test_sales_prompt_is_compact_and_reports_the_effective_runtime_model():
    prompt = build_sales_system_prompt(_profile(role_ids=("wechat-service", "sales-review", "moments-operator")), {"_get_model": lambda: "lumaflow-qwen3-8b:latest"})
    assert "我是 LumaFlow 销售助手" in prompt
    assert "lumaflow-qwen3-8b:latest" in prompt
    assert "调用工具后继续回答这个问题" in prompt
    assert "fileName" in prompt
    assert "色温调节" in prompt
    assert "仅正文计算字数" in prompt
    assert len(prompt) < 3500


def test_general_code_generation_does_not_grant_computer_control():
    prompt = build_sales_system_prompt(_profile(), {"model": "ternary-bonsai-2-27b"})
    assert "不要因为销售角色而拒绝" in prompt
    assert "生成代码不等于执行代码" in prompt
    assert "不能擅自运行命令" in prompt
    assert "闭合标签" in prompt
    tools = [SimpleNamespace(name=name) for name in ("bash", "write", "browser", "website_knowledge")]
    assert [tool.name for tool in constrain_sales_tools(_profile(), tools)] == ["website_knowledge"]
