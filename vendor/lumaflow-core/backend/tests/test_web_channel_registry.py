"""The web API must see channels registered by app.py's live runtime."""

from types import SimpleNamespace

from common import channel_registry
from channel.web.web_channel import ChannelsHandler, WeixinQrHandler
from channel.web import web_channel


def test_weixin_instance_status_uses_process_registry(monkeypatch, tmp_path):
    channel = SimpleNamespace(login_status="logged_in")
    manager = SimpleNamespace(get_channel=lambda key: channel if key == "weixin-sales" else None)
    monkeypatch.setattr(channel_registry, "_channel_manager", manager)
    monkeypatch.setattr(web_channel, "conf", lambda: {
        "agent_workspace": str(tmp_path),
        "channel_instances": [{
            "instance_id": "weixin-sales", "channel_type": "weixin", "agent_id": "sales",
        }],
    })

    rows = ChannelsHandler._channel_instances_view()
    assert len(rows) == 1
    assert rows[0]["active"] is True
    assert rows[0]["login_status"] == "logged_in"
    assert rows[0]["agent_id"] == "sales"
    assert WeixinQrHandler._get_running_channel("weixin-sales") is channel
    assert WeixinQrHandler._get_running_channel("weixin-other") is None


def test_legacy_weixin_login_reads_same_live_manager(monkeypatch):
    channel = SimpleNamespace(login_status="waiting_scan")
    manager = SimpleNamespace(get_channel=lambda key: channel if key == "weixin" else None)
    monkeypatch.setattr(channel_registry, "_channel_manager", manager)
    assert ChannelsHandler._get_weixin_login_status() == "waiting_scan"


def test_no_registered_manager_reports_no_running_channel(monkeypatch):
    monkeypatch.setattr(channel_registry, "_channel_manager", None)
    assert ChannelsHandler._channel_mgr() is None
    assert WeixinQrHandler._get_running_channel("weixin-sales") is None
