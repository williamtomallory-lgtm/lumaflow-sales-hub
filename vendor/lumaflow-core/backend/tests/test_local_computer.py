import json
from agent.tools.local_computer.local_computer import LocalComputer, execute_local, owner_authorized, validate_operation_permission


def test_work_owner_binding_cannot_be_overridden_by_model_args(tmp_path, monkeypatch):
    monkeypatch.setattr("config.get_data_root", lambda: str(tmp_path))
    from agent.registry import AgentProfile, AgentRegistry
    monkeypatch.setattr("agent.registry.get_agent_registry", lambda: AgentRegistry([AgentProfile("a", "A", str(tmp_path))], "a"))
    (tmp_path / "computer-access.json").write_text(json.dumps({"enabled": True, "allowedSessions": {"a": ["owner"]}}))
    tool = LocalComputer({"cwd": str(tmp_path)})
    tool.bind_runtime("customer", "a")
    tool.work_enabled = True
    result = tool.execute({"action": "write_file", "path": "never.txt", "content": "bad", "sessionId": "owner"})
    assert result.status != "success"
    assert not (tmp_path / "never.txt").exists()
    tool.bind_runtime("owner", "a")
    tool.work_enabled = False
    assert tool.execute({"action": "list_files"}).status != "success"
    tool.work_enabled = True
    assert tool.execute({"action": "write_file", "path": "ok.txt", "content": "中文内容"}).status == "success"
    assert (tmp_path / "ok.txt").read_text(encoding="utf-8") == "中文内容"
    assert not owner_authorized("owner", "different-agent")


def test_actual_command_exit_output_and_metadata_log(tmp_path, monkeypatch):
    monkeypatch.setattr("config.get_data_root", lambda: str(tmp_path))
    receipt = execute_local({"action": "command", "command": "echo computer-executor-ok"}, tmp_path)
    assert receipt["exitCode"] == 0
    assert "computer-executor-ok" in receipt["stdout"]
    history = json.loads((tmp_path / "computer-tasks.jsonl").read_text(encoding="utf-8"))
    assert history["taskId"] == receipt["taskId"]
    assert "stdout" not in history


def test_failed_command_has_nonzero_exit_and_readable_error(tmp_path, monkeypatch):
    monkeypatch.setattr("config.get_data_root", lambda: str(tmp_path))
    receipt = execute_local({"action": "command", "command": "lumaflow-command-that-does-not-exist"}, tmp_path)
    assert receipt["exitCode"] != 0
    assert receipt["stderr"]
    assert "CLIXML" not in receipt["stderr"]


def test_empty_command_does_not_claim_execution(tmp_path):
    import pytest
    with pytest.raises(ValueError):
        execute_local({"action": "command", "command": ""}, tmp_path)


def test_file_permissions_and_workspace_boundary(tmp_path):
    import pytest
    from agent.registry import AgentProfile
    profile = AgentProfile("files", "Files", str(tmp_path), permissions={"read": True, "create": True, "modify": False, "delete": False, "tools": False})
    validate_operation_permission(profile, {"action": "write_file", "path": "ok.txt"})
    with pytest.raises(ValueError, match="modify"):
        existing = tmp_path / "existing.txt"
        existing.write_text("original", encoding="utf-8")
        validate_operation_permission(profile, {"action": "write_file", "path": str(existing)})
    with pytest.raises(ValueError, match="Workspace"):
        validate_operation_permission(profile, {"action": "read_file", "path": str(tmp_path.parent / "outside.txt")})
    with pytest.raises(ValueError, match="工具"):
        validate_operation_permission(profile, {"action": "command", "command": "echo no"})
    wechat = AgentProfile("wx", "WX", str(tmp_path), type="wechat", agent_type="weixin_personal")
    with pytest.raises(ValueError, match="微信 Agent"):
        validate_operation_permission(wechat, {"action": "write_file", "path": "no.txt"})


def test_file_read_is_paged_and_edit_preserves_other_content(tmp_path, monkeypatch):
    monkeypatch.setattr("config.get_data_root", lambda: str(tmp_path))
    path = tmp_path / "example.txt"
    path.write_text("a" * 4500 + "paused = false;", encoding="utf-8")
    first = execute_local({"action": "read_file", "path": "example.txt"}, tmp_path)
    assert len(first["content"]) == 4000
    assert first["nextOffset"] == 4000
    last = execute_local({"action": "read_file", "path": "example.txt", "offsetCharacters": 4000}, tmp_path)
    assert last["content"].endswith("paused = false;")
    assert last["nextOffset"] is None
    result = execute_local({"action": "edit_file", "path": "example.txt", "oldText": "paused = false;", "newText": "paused = true;"}, tmp_path)
    assert result["saved"] is True
    assert path.read_text(encoding="utf-8") == "a" * 4500 + "paused = true;"


def test_ambiguous_edit_does_not_change_file(tmp_path):
    import pytest
    path = tmp_path / "example.txt"
    path.write_text("same same", encoding="utf-8")
    with pytest.raises(ValueError, match="不唯一"):
        execute_local({"action": "edit_file", "path": "example.txt", "oldText": "same", "newText": "new"}, tmp_path)
    assert path.read_text(encoding="utf-8") == "same same"
