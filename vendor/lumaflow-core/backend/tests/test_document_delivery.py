from types import SimpleNamespace

import pytest

from agent.tools.create_document.create_document import create_document
from agent.tools.local_computer.local_computer import execute_local, validate_operation_permission
from agent.tools.base_tool import ToolResult
from agent.wechat_conversations import WechatConversationStore
from agent.wechat_runtime import WechatAgentRuntime


@pytest.fixture(autouse=True)
def isolated_task_history(tmp_path, monkeypatch):
    monkeypatch.setattr("config.get_data_root", lambda: str(tmp_path))


@pytest.mark.parametrize("fmt", ["pdf", "docx", "xlsx", "pptx"])
def test_generated_documents_are_readable(tmp_path, fmt):
    args = {"format": fmt, "path": f"测试.{fmt}", "content": "# 测试报告\n第一条内容\n第二条内容"}
    if fmt == "xlsx":
        args["rows"] = [["项目", "数量"], ["灯具", 12], ["总数", "=SUM(B2:B2)"]]
    result = create_document(args, tmp_path)
    path = result["path"]
    assert result["saved"] and result["bytes"] > 100
    extracted = execute_local({"action": "read_file", "path": path, "maxCharacters": 4000}, tmp_path)
    assert extracted["extractedDocument"]
    assert ("灯具" if fmt == "xlsx" else "第一条内容") in extracted["content"]
    if fmt == "pdf":
        from pypdf import PdfReader
        assert "第一条内容" in PdfReader(path).pages[0].extract_text()
    elif fmt == "docx":
        from docx import Document
        assert "第一条内容" in [p.text for p in Document(path).paragraphs]
    elif fmt == "xlsx":
        from openpyxl import load_workbook
        assert load_workbook(path).active["B3"].value == "=SUM(B2:B2)"
    else:
        from pptx import Presentation
        assert "第一条内容" in Presentation(path).slides[0].placeholders[1].text


def test_document_paths_and_overwrites_are_guarded(tmp_path):
    args = {"format": "txt", "path": "report.txt", "content": "original"}
    create_document(args, tmp_path)
    with pytest.raises(ValueError, match="exists"):
        create_document({**args, "content": "replacement"}, tmp_path)
    assert (tmp_path / "report.txt").read_text() == "original"
    with pytest.raises(ValueError, match="inside"):
        create_document({**args, "path": "../report.txt"}, tmp_path)


def test_structured_creation_uses_file_grants_and_python_uses_runtime(tmp_path):
    profile = SimpleNamespace(type="local", agent_type="", workspace=str(tmp_path), allowed_paths=[],
                              permissions={"read": True, "create": True, "modify": False, "delete": False, "tools": False})
    operation = {"action": "create_document", "format": "docx", "path": "report.docx", "content": "正文"}
    validate_operation_permission(profile, operation)
    assert execute_local(operation, tmp_path)["saved"]
    with pytest.raises(ValueError, match="modify"):
        validate_operation_permission(profile, operation)
    with pytest.raises(ValueError, match="工具权限"):
        validate_operation_permission(profile, {"action": "python", "script": "print(4)"})
    result = execute_local({"action": "python", "script": "import docx; print('中文分析完成')"}, tmp_path)
    assert result["exitCode"] == 0 and "中文分析完成" in result["stdout"]


def test_title_uses_first_task_and_manual_rename_wins(tmp_path):
    store = WechatConversationStore(tmp_path)
    conversation = store.create_conversation("o9cq@im.wechat")
    cid = conversation["id"]
    store.add_message(cid, "user", "请帮我创建一个PDF。正文如下", "work")
    store.add_message(cid, "user", "现在改成Excel", "work")
    store.set_receiver(cid, "owner", contact_name="o9cq@im.wechat")
    assert store.get_conversation(cid)["title"] == "创建一个PDF"
    store.update_conversation(cid, {"title": "我的项目"})
    assert store.get_conversation(cid)["title"] == "我的项目"


def test_wechat_file_send_delivers_to_bound_receiver_and_reports_failure(tmp_path, monkeypatch):
    store = WechatConversationStore(tmp_path)
    cid = store.create_conversation("任务")["id"]
    store.set_receiver(cid, "owner")
    runtime = WechatAgentRuntime(store=store, profile_id="wechat-agent")
    monkeypatch.setattr(runtime, "_config", lambda: {"workspace": str(tmp_path), "syncEnabled": True})
    calls = []
    channel = SimpleNamespace(_get_context_token=lambda receiver: "token", send_file_strict=lambda *args: calls.append(args))
    monkeypatch.setattr(runtime, "_channel", lambda: channel)
    file = tmp_path / "report.pdf"
    file.write_bytes(b"test")
    result = ToolResult.success({"type": "file_to_send", "path": str(file)})
    sent = runtime.deliver_tool_file(cid, result)
    assert sent.result["deliveryStatus"] == "sent"
    assert calls == [(str(file), "owner", "token")]
    channel.send_file_strict = lambda *_: (_ for _ in ()).throw(RuntimeError("transport failed"))
    failed = runtime.deliver_tool_file(cid, result)
    assert failed.status == "error" and failed.result["deliveryStatus"] == "failed"
    assert runtime.deliver_tool_file(cid, ToolResult.success({"type": "file_to_send", "path": str(tmp_path.parent / "secret.txt")})).status == "error"


def test_automatic_wechat_task_creates_and_sends_pdf_without_approval(tmp_path, monkeypatch):
    from agent.tools.create_document.create_document import CreateDocument
    from agent.tools.send.send import Send
    from agent.wechat_runtime import _ApprovalTool
    store = WechatConversationStore(tmp_path)
    cid = store.create_conversation("PDF任务")["id"]
    store.set_receiver(cid, "owner")
    message = store.add_message(cid, "assistant", "", "work")
    runtime = WechatAgentRuntime(store=store, profile_id="wechat-agent")
    monkeypatch.setattr(runtime, "_config", lambda: {"workspace": str(tmp_path), "syncEnabled": True,
        "permissions": {key: "auto" for key in ["read", "create", "modify", "tools", "send", "delete", "moments"]}})
    sent = []
    channel = SimpleNamespace(_get_context_token=lambda _: "token", send_file_strict=lambda *args: sent.append(args))
    monkeypatch.setattr(runtime, "_channel", lambda: channel)
    create = _ApprovalTool(runtime, CreateDocument(), cid, message["id"])
    create.set_cwd(str(tmp_path))
    assert create.execute_tool({"format": "pdf", "path": "test.pdf", "content": "测试正文"}).status == "success"
    send = _ApprovalTool(runtime, Send(), cid, message["id"])
    send.set_cwd(str(tmp_path))
    assert send.execute_tool({"path": "test.pdf"}).result["deliveryStatus"] == "sent"
    assert len(sent) == 1 and not store.list_messages(cid)["pendingActions"]


def test_python_analysis_creates_a_real_chart_and_reports_script_failure(tmp_path):
    from agent.tools.python_analysis.python_analysis import PythonAnalysis
    tool = PythonAnalysis()
    tool.cwd = str(tmp_path)
    result = tool.execute({"script": "import pandas as pd; import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; values=pd.Series([1,2,3]); values.plot(); plt.savefig('chart.png'); print(values.sum())"})
    assert result.status == "success" and result.result["stdout"].strip() == "6"
    assert (tmp_path / "chart.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    failed = tool.execute({"script": "raise ValueError('bad data')"})
    assert failed.status == "error" and failed.result["exitCode"] != 0


def test_strict_wechat_file_upload_rejects_remote_errors(tmp_path, monkeypatch):
    from channel.weixin import weixin_channel as module
    uploaded = []
    monkeypatch.setattr(module, "upload_media_to_cdn", lambda *args, **kwargs: uploaded.append(args) or {
        "encrypt_query_param": "encrypted", "aes_key_b64": "key", "raw_size": 4})
    channel = SimpleNamespace(api=SimpleNamespace(send_file_item=lambda **kwargs: {"ret": 429}),
                              _check_send_response=lambda *_: None)
    file = tmp_path / "report.pdf"
    file.write_bytes(b"test")
    with pytest.raises(RuntimeError, match="rejected"):
        module.WeixinChannel.__wrapped__.send_file_strict(channel, str(file), "owner", "token")
    assert len(uploaded) == 1
