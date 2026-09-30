"""The Moments draft is source-backed and cannot publish or invent photos."""

from pathlib import Path
from unittest.mock import patch

from agent.tools.base_tool import ToolResult
from agent.tools.moments_draft import MomentsDraft
from common.runtime_identity import identity_scope


ROOT = Path(__file__).resolve().parents[2] / "docs" / "test-data" / "personal-agent"


def _doc(file_name, text, collection="demo", truncated=False):
    return {"fileName": file_name, "text": text, "collection": collection,
            "truncated": truncated, "citation": file_name + " · 隔离虚构演示"}


def _source_documents():
    return [
        _doc("04-moments-brief.txt", (ROOT / "04-moments-brief.txt").read_text(encoding="utf-8")),
        _doc("01-products.txt", (ROOT / "01-products.txt").read_text(encoding="utf-8")),
    ]


def _run(documents=None, args=None, result=None, agent_id="wechat-service"):
    if result is None:
        result = ToolResult.success({"data": {"agentId": agent_id,
                                               "documents": documents if documents is not None else _source_documents()}})
    with patch("agent.tools.moments_draft.moments_draft.WebsiteKnowledge.execute", return_value=result) as read:
        with identity_scope(agent_id="wechat-service"):
            outcome = MomentsDraft().execute(args or {})
    return outcome, read


def test_three_rewrite_variants_use_actual_files_and_never_publish():
    bodies = []
    for variant in (1, 2, 3):
        result, read = _run(args={"variant": variant})
        assert result.status == "success"
        payload = result.result
        assert 80 <= payload["bodyCharacters"] <= 120
        assert payload["bodyCharacters"] == len(payload["body"])
        assert all(term in payload["body"] for term in ("18W", "压铸铝", "色温可选", "2 年质保"))
        assert all(term not in payload["body"] for term in ("库存", "119", "色温调节", "专业级"))
        assert [source["fileName"] for source in payload["sources"]] == ["01-products.txt", "04-moments-brief.txt"]
        assert payload["imageStatus"] == "not_generated"
        assert payload["publicationStatus"] == "draft_only"
        assert "AI 示意图" in payload["imageBrief"]
        read.assert_called_once_with({"q": "运营简报", "limit": 6})
        bodies.append(payload["body"])
    assert len(set(bodies)) == 3


def test_changed_authorised_product_data_changes_generated_copy():
    docs = _source_documents()
    docs[1]["text"] = docs[1]["text"].replace("功率：18W", "功率：19W", 1)
    result, _ = _run(docs)
    assert result.status == "success"
    assert "19W" in result.result["body"]
    assert "18W" not in result.result["body"]


def test_missing_product_or_brief_fails_closed():
    for documents in (_source_documents()[:1], _source_documents()[1:], []):
        result, _ = _run(documents)
        assert result.status == "error"


def test_cross_agent_and_truncation_fails_closed():
    mismatch, _ = _run(agent_id="other-agent")
    assert mismatch.status == "error"
    docs = _source_documents()
    docs[0]["truncated"] = True
    truncated, _ = _run(docs)
    assert truncated.status == "error"


def test_model_cannot_supply_agent_or_unknown_sku():
    for args in ({"agentId": "other-agent"}, {"variant": 0}, {"sku": "OTHER-1"}):
        result, read = _run(args=args)
        assert result.status == "error"
        if "agentId" in args or "variant" in args:
            read.assert_not_called()


def test_missing_bridge_fails_without_publication_claim():
    failure, _ = _run(result=ToolResult.fail("网站知识检索未配置授权凭据。"))
    assert failure.status == "error"
    assert "授权凭据" in failure.result
