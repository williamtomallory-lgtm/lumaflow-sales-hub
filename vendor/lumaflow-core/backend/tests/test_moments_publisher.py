from pathlib import Path
from types import SimpleNamespace
import base64
import json
import subprocess

import pytest

from agent.tools.moments_custom import publisher


def test_non_windows_or_disabled_mode_fails_closed(monkeypatch):
    monkeypatch.setenv("LUMAFLOW_MOMENTS_PUBLISHER", "disabled")
    result = publisher.publish_moments("不会真正发送")
    assert result.status == "unavailable"
    assert "没有启用" in result.message


@pytest.fixture
def windows_publisher(monkeypatch, tmp_path):
    monkeypatch.setenv("LUMAFLOW_MOMENTS_PUBLISHER", "windows_desktop")
    monkeypatch.setattr(publisher, "_is_windows", lambda: True)
    monkeypatch.setattr(publisher, "_script_path", lambda: tmp_path / "weixin-moments-publish.ps1")
    Path(tmp_path / "weixin-moments-publish.ps1").write_text("", encoding="utf-8")


def test_windows_publisher_passes_confirmed_body_to_visible_script(monkeypatch, windows_publisher):
    calls = []

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=0, stdout=json.dumps({"status": "published_verified", "message": "已核验"}), stderr="")

    monkeypatch.setattr(publisher.subprocess, "run", fake_run)
    result = publisher.publish_moments("确认后的内容")
    assert result.status == "published_verified"
    assert result.provider == "windows_desktop"
    assert calls and "-Action" in calls[0][0] and "publish" in calls[0][0]
    assert "确认后的内容" not in calls[0][0]  # body is UTF-8 base64, not plain CLI text
    args = calls[0][0]
    assert base64.b64decode(args[args.index("-BodyBase64") + 1]).decode("utf-8") == "确认后的内容"


@pytest.mark.parametrize("receipt", ["submitted", "{}", "[]", "not JSON", '{"status":"ready","message":"ok"}'])
def test_invalid_receipts_never_claim_success_or_invite_retry(monkeypatch, windows_publisher, receipt):
    monkeypatch.setattr(publisher.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0, stdout=receipt))
    result = publisher.publish_moments("Test")
    assert result.status == "submitted_unverified"
    assert "暂勿重复确认" in result.message


def test_timeout_is_uncertain_not_retryable(monkeypatch, windows_publisher):
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("powershell.exe", 45)
    monkeypatch.setattr(publisher.subprocess, "run", timeout)
    assert publisher.publish_moments("Test").status == "submitted_unverified"


def test_verified_pre_click_failure_remains_failed(monkeypatch, windows_publisher):
    monkeypatch.setattr(publisher.subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=0, stdout=json.dumps({"status": "failed", "message": "尚未点击发表"})))
    assert publisher.publish_moments("Test").status == "failed"


def test_images_are_not_silently_dropped(monkeypatch, windows_publisher):
    monkeypatch.setattr(publisher.subprocess, "run", lambda *a, **k: pytest.fail("Must not publish text without supplied images"))
    assert publisher.publish_moments("Test", ["photo.png"]).status == "unavailable"


def test_unsupported_platform_fails_closed(monkeypatch):
    monkeypatch.setenv("LUMAFLOW_MOMENTS_PUBLISHER", "windows_desktop")
    monkeypatch.setattr(publisher, "_is_windows", lambda: False)
    assert publisher.publish_moments("Test").status == "unavailable"


@pytest.mark.skipif(not publisher._is_windows(), reason="Windows PowerShell regression test")
def test_powershell_ocr_coordinates_are_scalar_without_controlling_weixin():
    # Only load pure functions through AST; never execute the UI script body.
    script = publisher._script_path()
    command = r'''
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($args[0],[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'Script parse failed'}
    foreach($name in @('Convert-OcrResult','Menu-Point')){
        $fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
        Invoke-Expression $fn.Extent.Text
    }
    $raw=[pscustomobject]@{Text='menu';Lines=@([pscustomobject]@{Text='line';Words=@(
        [pscustomobject]@{BoundingRect=[pscustomobject]@{X=20.0;Y=80.0;Width=30.0;Height=20.0}},
        [pscustomobject]@{BoundingRect=[pscustomobject]@{X=55.0;Y=80.0;Width=40.0;Height=20.0}}
    )})}
    $ocr=Convert-OcrResult $raw
    $point=Menu-Point ([pscustomobject]@{Left=1269;Top=177}) $ocr.Lines[0].Words[0]
    if($point.X -ne 1304 -or $point.Y -ne 267){throw 'Wrong coordinates'}
    if($ocr.Lines[0].Words.Count -ne 2){throw 'Lost words'}
    'ok'
    '''
    # File path is injected as a quoted literal, not a script argument after -Command.
    command = command.replace("$args[0]", "'" + str(script).replace("'", "''") + "'")
    completed = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                               capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "ok"
