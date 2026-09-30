from types import SimpleNamespace

import pytest

from channel.web import web_channel as wc
from channel.web.web_channel import WeixinQrHandler
from channel.wecom_bot.wecom_bot_channel import WecomBotChannel


class _Registry:
    def __init__(self, agent_type):
        self.profile = SimpleNamespace(id="sales", agent_type=agent_type)

    def get(self, agent_id, require_enabled=True):
        assert agent_id == "sales"
        return self.profile


class _Service:
    def __init__(self, agent_type):
        self.registry = _Registry(agent_type)

    def _load(self):
        return {}

    def _registry(self, settings):
        return self.registry


def test_weixin_qr_sessions_are_keyed_per_agent_instance(monkeypatch):
    monkeypatch.setattr(wc, "_agent_admin_service", lambda: _Service("weixin_personal"))

    first = WeixinQrHandler._validate_identity("weixin-sales", "sales")
    assert first == ("weixin-sales", "sales")
    assert WeixinQrHandler._state_key(first[0]) == "weixin-sales"


def test_group_agent_cannot_use_personal_weixin_qr(monkeypatch):
    monkeypatch.setattr(wc, "_agent_admin_service", lambda: _Service("wecom_group"))

    with pytest.raises(ValueError, match="personal Weixin Agent"):
        WeixinQrHandler._validate_identity("weixin-sales", "sales")


def test_group_agent_ignores_private_wecom_messages(monkeypatch):
    from agent import registry as registry_module

    monkeypatch.setattr(registry_module, "get_agent_registry", lambda: _Registry("wecom_group"))
    channel = WecomBotChannel()
    channel.bound_agent_id = "sales"

    assert channel._build_context({"msgtype": "text"}, is_group=False) is None


def test_one_personal_wechat_account_cannot_back_two_agents(tmp_path, monkeypatch):
    import json
    monkeypatch.setattr(wc, "get_weixin_credentials_path", lambda instance_id="": str(tmp_path / (f"wechat.{instance_id}.json" if instance_id else "wechat.json")))
    (tmp_path / "wechat.weixin-first.json").write_text(json.dumps({"user_id": "owner", "bot_id": "bot-first"}), encoding="utf-8")
    assert WeixinQrHandler._account_already_bound("weixin-second", "owner", "bot-second")
    assert WeixinQrHandler._account_already_bound("weixin-second", "other", "bot-first")
    assert not WeixinQrHandler._account_already_bound("weixin-first", "owner", "bot-first")
