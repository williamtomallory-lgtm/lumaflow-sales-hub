"""Focused invariants for the canonical personal WeChat Agent runtime."""

from __future__ import annotations

import base64
import tempfile
import threading
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent.wechat_conversations import WechatConversationStore
from agent import wechat_runtime as wechat_runtime_module
from agent.wechat_runtime import WechatAgentRuntime


class _Runtime(WechatAgentRuntime):
    """Runtime with transport/model work replaced by deterministic hooks."""

    def __init__(self, store, profile_id="wechat-agent"):
        super().__init__(store=store, profile_id=profile_id)
        self.scheduled = []

    @property
    def profile_id(self):
        return self._profile_id or "wechat-agent"

    def _config(self):
        return {
            "workspace": "",
            "receiveEnabled": True,
            "syncEnabled": True,
            "dndEnabled": False,
            "permissions": {
                "read": "auto",
                "create": "auto",
                "modify": "confirm",
                "tools": "confirm",
                "delete": "confirm",
                "send": "confirm",
                "moments": "confirm",
            },
        }

    def _schedule_turn(self, *args):
        self.scheduled.append(args)

    def _activity(self, *_args):
        return None


class _Channel:
    instance_id = "weixin-wechat-agent"
    bound_agent_id = "wechat-agent"

    def __init__(self):
        self.sent = []

    def _get_context_token(self, receiver):
        return f"token:{receiver}"

    def send_text_strict(self, text, receiver, token):
        self.sent.append((text, receiver, token))


class _Manager:
    def __init__(self, channel):
        self.channel = channel

    def get_channel(self, instance_id):
        return self.channel if instance_id == self.channel.instance_id else None


def _store(tmp_path):
    return WechatConversationStore(Path(tmp_path) / "workspace")


def test_store_deduplicates_client_and_incoming_messages(tmp_path):
    store = _store(tmp_path)
    conversation = store.create_conversation("work")
    client_id = str(uuid.uuid4())

    first = store.add_message(
        conversation["id"], "user", "hello", "work",
        client_message_id=client_id,
        status="running",
    )
    replay = store.add_message(
        conversation["id"], "user", "hello", "work",
        client_message_id=client_id,
        status="running",
    )
    assert replay["id"] == first["id"]

    with pytest.raises(ValueError, match="another conversation"):
        other = store.create_conversation("other")
        store.add_message(
            other["id"], "user", "cross", "work", client_message_id=client_id
        )

    inbound, created = store.record_incoming("wx-1", "wechat:one:user", "inbound")
    replay_inbound, replay_created = store.record_incoming(
        "wx-1", "wechat:one:user", "inbound"
    )
    assert created is True
    assert replay_created is False
    assert replay_inbound["id"] == inbound["id"]


def test_work_message_keeps_work_source_in_wechat_conversation(tmp_path):
    store = _store(tmp_path)
    runtime = _Runtime(store)
    conversation = store.create_conversation("bound")["id"]
    store.set_receiver(conversation, "owner")

    runtime.send(conversation, "typed in Work", str(uuid.uuid4()))
    messages = store.list_messages(conversation)["items"]
    assert messages[-1]["source"] == "work"


def test_connection_exposes_png_data_url_for_qr_payload(tmp_path, monkeypatch):
    class QrChannel(_Channel):
        login_status = "waiting_scan"
        LOGIN_STATUS_OK = "logged_in"
        api = None
        _current_qr_url = "https://ilinkai.weixin.qq.com/qr/opaque-token"

    channel = QrChannel()
    manager = _Manager(channel)
    monkeypatch.setattr(
        WechatAgentRuntime, "_channel_manager", staticmethod(lambda: manager)
    )
    runtime = _Runtime(_store(tmp_path))

    state = runtime.connection()

    assert state["status"] == "waiting"
    assert state["qrCodeUrl"] == channel._current_qr_url
    image = state["qrCodeDataUrl"]
    assert image.startswith("data:image/png;base64,")
    png = base64.b64decode(image.split(",", 1)[1])
    assert png.startswith(b"\x89PNG\r\n\x1a\n")


def test_image_avatar_marker_maps_to_revisioned_public_url(tmp_path, monkeypatch):
    avatar_dir = Path(tmp_path) / "avatars"
    avatar_dir.mkdir()
    (avatar_dir / "wechat-agent.png").write_bytes(b"png")
    monkeypatch.setattr(
        "common.state_dir.shared_root", lambda: Path(tmp_path)
    )

    profile = SimpleNamespace(id="wechat-agent", avatar="image")
    url = wechat_runtime_module._public_avatar_url(profile)

    assert url.startswith("/api/v1/cowagent/agents/wechat-agent/avatar?v=")
    assert url != "image"


@pytest.mark.parametrize("field", ["name", "avatarUrl"])
def test_identity_edits_are_disabled_for_fixed_wechat_identity(tmp_path, monkeypatch, field):
    monkeypatch.setattr(
        WechatAgentRuntime, "_channel_manager", staticmethod(lambda: None)
    )
    runtime = _Runtime(_store(tmp_path))

    with pytest.raises(ValueError, match="固定名称和头像"):
        runtime.update_config({field: "new-value"})


def test_conversation_metadata_persists_without_changing_messages(tmp_path):
    store = _store(tmp_path)
    conversation = store.create_conversation("original")
    cid = conversation["id"]
    store.add_message(cid, "user", "keep this message", "work")
    store.update_conversation(cid, {"title": "renamed", "pinned": True, "archived": True})
    reopened = _store(tmp_path)
    item = next(item for item in reopened.list_conversations()["items"] if item["id"] == cid)
    assert item["title"] == "renamed"
    assert item["pinned"] and item["archived"]
    assert reopened.list_messages(cid)["items"][0]["text"] == "keep this message"
    reopened.set_receiver(cid, "test-owner", contact_name="new contact label")
    assert reopened.get_conversation(cid)["title"] == "renamed"
    reopened.update_conversation(cid, {"archived": False})
    assert not reopened.get_conversation(cid)["archived"]


def test_conversation_delete_clears_transcript_and_current_selection(tmp_path):
    store = _store(tmp_path)
    cid = store.create_conversation("delete me")["id"]
    store.add_message(cid, "user", "local fixture", "work")
    store.delete_conversation(cid)
    assert store.current_conversation_id() is None
    assert not any(item["id"] == cid for item in store.list_conversations()["items"])
    assert store.list_messages(cid)["items"] == []


def test_conversation_delete_rejects_queued_jobs(tmp_path):
    store = _store(tmp_path)
    cid = store.create_conversation("working")["id"]
    store.enqueue_job("turn", cid, text="test task")
    with pytest.raises(ValueError, match="正在工作"):
        store.delete_conversation(cid)
    assert store.get_conversation(cid) is not None


def test_conversation_delete_rejects_pending_approvals(tmp_path):
    store = _store(tmp_path)
    cid = store.create_conversation("approval")["id"]
    store.create_action(cid, "send", "test pending send")
    with pytest.raises(ValueError, match="待确认"):
        store.delete_conversation(cid)
    assert store.get_conversation(cid) is not None


def test_public_wechat_identity_is_fixed_without_deleting_saved_assets(tmp_path, monkeypatch):
    store = _store(tmp_path)
    store.set_config({"name": "legacy name", "avatarUrl": "/legacy-avatar.png"})
    profile = SimpleNamespace(id="wechat-agent", name="legacy name", avatar="", system_prompt="", workspace=str(tmp_path), knowledge_base_ids=None)
    runtime = WechatAgentRuntime(store=store, profile_id="wechat-agent")
    monkeypatch.setattr(runtime, "_resolve_profile", lambda: profile)
    config = runtime._config()
    assert config["name"] == "WeixinClawBot"
    assert config["avatarUrl"] == "/wechat-clawbot.svg"
    assert store.get_config()["avatarUrl"] == "/legacy-avatar.png"


def test_permission_gate_honors_create_modify_and_external_invariants(tmp_path):
    runtime = _Runtime(_store(tmp_path))
    assert runtime.tool_action_type("read", {}) is None
    assert runtime.tool_action_type(
        "write", {"path": "new.txt"}, cwd=str(tmp_path / "missing")
    ) is None
    assert runtime.tool_action_type(
        "edit", {"path": "new.txt"}, cwd=str(tmp_path / "missing")
    ) == "modify"
    assert runtime.tool_action_type("bash", {"command": "echo hi"}) == "command"
    assert runtime.tool_action_type("send", {"path": "x"}) == "send"
    assert runtime.tool_action_type("moments_custom", {}) == "moments"


def test_pending_tool_action_keeps_assistant_awaiting_confirmation(tmp_path):
    store = _store(tmp_path)

    class PendingAgent:
        def __init__(self):
            self.messages = []
            self.messages_lock = threading.RLock()
            self.runtime = None
            self.conversation_id = ""
            self.assistant_id = ""

        def run_stream(self, _text, on_event=None):
            self.runtime.create_tool_action(
                self.conversation_id,
                self.assistant_id,
                "bash",
                {"command": "echo pending"},
                "command",
                cwd="",
            )
            return "执行前需要你的确认。"

    class PendingRuntime(_Runtime):
        def __init__(self, store):
            super().__init__(store)
            self.agent = PendingAgent()

        def _agent_for(self, conversation_id, *, knowledge_context=None):
            self.agent.runtime = self
            self.agent.conversation_id = conversation_id
            return self.agent

        def _bind_turn_tools(self, _agent, conversation_id, assistant_id):
            self.agent.conversation_id = conversation_id
            self.agent.assistant_id = assistant_id

        def _queue_wechat_delivery(self, *_args, **_kwargs):
            self.delivered = _args

    runtime = PendingRuntime(store)
    conversation = store.create_conversation("pending")['id']
    store.set_receiver(conversation, "owner", channel_instance_id="weixin-wechat-agent")
    user = store.add_message(conversation, "user", "run", "work", status="running")
    runtime._run_turn(conversation, user["id"], "run", "work")

    page = store.list_messages(conversation)
    assistant = [item for item in page["items"] if item["role"] == "assistant"][-1]
    assert assistant["status"] == "awaiting_confirmation"
    assert runtime.delivered == (conversation, assistant["id"], "执行前需要你的确认。")
    assert any(
        action["state"] == "pending" and action.get("messageId") == assistant["id"]
        for action in page["pendingActions"]
    )


def test_approval_cannot_follow_receiver_to_another_conversation(tmp_path, monkeypatch):
    store = _store(tmp_path)
    runtime = _Runtime(store)
    channel = _Channel()
    manager = _Manager(channel)
    monkeypatch.setattr(
        WechatAgentRuntime, "_channel_manager", staticmethod(lambda: manager)
    )

    conversation = store.create_conversation("one")["id"]
    store.set_receiver(conversation, "receiver-one", channel_instance_id=channel.instance_id)
    message = store.add_message(
        conversation, "assistant", "reply", "wechat",
        status="completed", delivery_status="pending",
    )
    action = store.create_action(
        conversation,
        "send",
        "send",
        payload={
            "kind": "wechat_message",
            "conversationId": conversation,
            "messageId": message["id"],
            "receiver": "receiver-one",
            "channelInstanceId": channel.instance_id,
            "contextToken": "token:receiver-one",
            "text": "reply",
        },
        message_id=message["id"],
    )
    claimed = store.claim_action(action["id"], True)
    assert claimed is not None
    assert store.claim_action(action["id"], True) is None

    store.set_receiver(conversation, "receiver-two", channel_instance_id=channel.instance_id)
    with pytest.raises(ValueError, match="receiver"):
        runtime._execute_wechat_send(claimed, claimed["payload"])
    assert channel.sent == []


def test_inbound_message_is_canonical_and_retired_profile_is_swallowed(tmp_path):
    store = _store(tmp_path)
    runtime = _Runtime(store)

    class Wx:
        content = "hello from WeChat"
        sender_name = "Owner"
        receiver_name = "Me"

    channel = _Channel()
    raw = {"from_user_id": "owner", "message_id": "m-1"}
    context = {"content": Wx.content}
    assert runtime.receive_wechat(channel=channel, raw_msg=raw, wx_msg=Wx(), context=context)
    assert runtime.receive_wechat(channel=channel, raw_msg=raw, wx_msg=Wx(), context=context)
    assert len(runtime.scheduled) == 1
    conversation_id = "wechat:weixin-wechat-agent:owner"
    messages = store.list_messages(conversation_id)["items"]
    assert len(messages) == 1
    assert messages[0]["source"] == "wechat"

    retired = _Channel()
    retired.bound_agent_id = "old-wechat-agent"
    assert runtime.receive_wechat(
        channel=retired, raw_msg={"from_user_id": "other", "message_id": "m-2"},
        wx_msg=Wx(), context=context
    ) is True
    assert len(runtime.scheduled) == 1


def test_normal_reply_is_delivered_without_confirmation_and_only_once(tmp_path, monkeypatch):
    store = _store(tmp_path)
    runtime = _Runtime(store)
    channel = _Channel()
    monkeypatch.setattr(runtime, "_channel", lambda: channel)
    monkeypatch.setattr(WechatAgentRuntime, "_channel_manager", staticmethod(lambda: _Manager(channel)))
    conversation = store.create_conversation("bound")["id"]
    store.set_receiver(conversation, "owner", channel_instance_id=channel.instance_id)
    message = store.add_message(conversation, "assistant", "reply", "work", status="completed")
    runtime._queue_wechat_delivery(conversation, message["id"], "reply")
    assert channel.sent == [("reply", "owner", "token:owner")]
    assert store.get_message(message["id"])["deliveryStatus"] == "sent"
    assert store.get_message(message["id"])["status"] == "completed"
    assert not any(action["state"] == "pending" for action in store.list_messages(conversation)["pendingActions"])
    runtime._queue_wechat_delivery(conversation, message["id"], "reply")
    assert len(channel.sent) == 1


def test_browser_session_binds_only_to_single_paired_owner(tmp_path, monkeypatch):
    store = _store(tmp_path)
    runtime = _Runtime(store)
    channel = _Channel()
    owners = ["owner"]
    channel.cfg = lambda key, default=None: owners if key == "weixin_allowed_sender_ids" else True
    monkeypatch.setattr(runtime, "_channel", lambda: channel)
    conversation = store.create_conversation("local")["id"]
    runtime.send(conversation, "hello", str(uuid.uuid4()))
    assert store.get_receiver(conversation) == "owner"
    owners.append("another")
    other = store.create_conversation("ambiguous")["id"]
    runtime.send(other, "hello", str(uuid.uuid4()))
    assert store.get_receiver(other) is None


def test_transport_failure_is_visible_in_delivery_status(tmp_path, monkeypatch):
    store = _store(tmp_path)
    runtime = _Runtime(store)
    channel = _Channel()
    def fail(*args):
        raise RuntimeError("transport unavailable")
    channel.send_text_strict = fail
    monkeypatch.setattr(runtime, "_channel", lambda: channel)
    monkeypatch.setattr(WechatAgentRuntime, "_channel_manager", staticmethod(lambda: _Manager(channel)))
    conversation = store.create_conversation("bound")["id"]
    store.set_receiver(conversation, "owner", channel_instance_id=channel.instance_id)
    message = store.add_message(conversation, "assistant", "reply", "wechat", status="completed")
    runtime._queue_wechat_delivery(conversation, message["id"], "reply")
    assert store.get_message(message["id"])["deliveryStatus"] == "failed"


def test_old_reply_approval_resumes_on_read_without_duplicate_delivery(tmp_path, monkeypatch):
    store = _store(tmp_path)
    runtime = _Runtime(store)
    channel = _Channel()
    monkeypatch.setattr(runtime, "_channel", lambda: channel)
    monkeypatch.setattr(WechatAgentRuntime, "_channel_manager", staticmethod(lambda: _Manager(channel)))
    class Immediate:
        def submit(self, fn, *args):
            fn(*args)
    runtime._executor.shutdown(wait=True)
    runtime._executor = Immediate()
    conversation = store.create_conversation("old")["id"]
    store.set_receiver(conversation, "owner", channel_instance_id=channel.instance_id)
    message = store.add_message(conversation, "assistant", "old reply", "work", status="awaiting_confirmation", delivery_status="pending")
    store.create_action(conversation, "send", "发送回复到微信", payload={"kind": "wechat_message", "conversationId": conversation, "messageId": message["id"], "receiver": "owner", "channelInstanceId": channel.instance_id, "contextToken": "token:owner", "text": "old reply"}, message_id=message["id"])
    runtime.messages(conversation)
    runtime.messages(conversation)
    assert channel.sent == [("old reply", "owner", "token:owner")]
    assert store.get_message(message["id"])["status"] == "completed"
    assert store.get_message(message["id"])["deliveryStatus"] == "sent"


def test_full_automatic_mode_migrates_legacy_settings_and_bypasses_tool_approval(tmp_path, monkeypatch):
    store = _store(tmp_path)
    store.set_config({"permissions": {"read": "auto", "create": "auto", "modify": "auto"}})
    permissions = store.get_config()["permissions"]
    assert set(permissions.values()) == {"auto"}
    runtime = _Runtime(store)
    monkeypatch.setattr(runtime, "_config", lambda: {"permissions": permissions})
    for tool, args in [("bash", {"command": "python -V"}), ("send", {}), ("moments_custom", {}), ("edit", {"path": "test.txt"}), ("write", {"path": "new.txt"})]:
        assert runtime.tool_action_type(tool, args, cwd=str(tmp_path)) is None
    assert runtime.tool_action_type("unknown_unavailable_tool", {}) == "command"
