"""Contract tests for deterministic-first sales execution routing."""

import json
import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from agent.execution import ExecutionMode, ExecutionRouter, ExecutionService


TOOLS = [
    "product_search",
    "inventory_lookup",
    "quotation_draft",
    "export_spreadsheet",
    "create_work_item",
]


class ExecutionRouterTest(unittest.TestCase):
    def setUp(self):
        self.router = ExecutionRouter()

    def test_inventory_question_is_chat(self):
        decision = self.router.route("18W黑色轨道灯还有多少？", available_tools=TOOLS)
        self.assertEqual(decision.mode, ExecutionMode.CHAT)
        self.assertEqual(decision.intent, "sales_lookup")
        self.assertIn("inventory_lookup", decision.suggested_tools)

    def test_inventory_export_is_work(self):
        decision = self.router.route("帮我生成全部轨道灯库存Excel", available_tools=TOOLS)
        self.assertEqual(decision.mode, ExecutionMode.WORK)
        self.assertIn("export_spreadsheet", decision.suggested_tools)
        self.assertIn("create_work_item", decision.suggested_tools)

    def test_lookup_then_quote_is_hybrid(self):
        decision = self.router.route("查200个High Bay库存，然后做报价", available_tools=TOOLS)
        self.assertEqual(decision.mode, ExecutionMode.HYBRID)
        self.assertIn("inventory_lookup", decision.suggested_tools)
        self.assertIn("quotation_draft", decision.suggested_tools)

    def test_consequential_work_requires_approval(self):
        decision = self.router.route("给客户做特价报价并直接发给他", available_tools=TOOLS)
        self.assertEqual(decision.mode, ExecutionMode.WORK)
        self.assertTrue(decision.requires_approval)

    def test_suggested_tools_are_intersected_with_actual_agent_tools(self):
        decision = self.router.route(
            "查库存然后做报价",
            available_tools=["inventory_lookup"],
        )
        self.assertEqual(decision.suggested_tools, ["inventory_lookup"])

    def test_classifier_handles_ambiguous_request(self):
        classifier = lambda query, tools: json.dumps({
            "intent": "daily_review",
            "mode": "work",
            "confidence": 0.83,
            "title": "今日复盘",
            "requires_approval": False,
            "suggested_tools": ["create_work_item", "made_up_tool"],
            "reason_code": "qwen_classifier",
        })
        decision = ExecutionRouter(classifier).route("复盘一下", available_tools=TOOLS)
        self.assertEqual(decision.mode, ExecutionMode.WORK)
        self.assertEqual(decision.suggested_tools, ["create_work_item"])

    def test_classifier_failure_falls_back_to_chat(self):
        def broken(*_):
            raise RuntimeError("model offline")

        decision = ExecutionRouter(broken).route("随便处理一下", available_tools=TOOLS)
        self.assertEqual(decision.mode, ExecutionMode.CHAT)
        self.assertEqual(decision.reason_code, "safe_chat_fallback")

    def test_deterministic_work_does_not_depend_on_classifier(self):
        def broken(*_):
            raise RuntimeError("model offline")

        decision = ExecutionRouter(broken).route("批量导出客户Excel", available_tools=TOOLS)
        self.assertEqual(decision.mode, ExecutionMode.WORK)
        self.assertEqual(decision.reason_code, "deterministic_work")

    def test_explicit_mode_wins(self):
        decision = self.router.route(
            "生成库存Excel",
            explicit_mode="chat",
            available_tools=TOOLS,
        )
        self.assertEqual(decision.mode, ExecutionMode.CHAT)
        self.assertEqual(decision.reason_code, "explicit_chat")


class ExecutionServiceTest(unittest.TestCase):
    def test_stamps_context(self):
        from bridge.context import Context

        ctx = Context(kwargs={})
        tools = [SimpleNamespace(name=name) for name in TOOLS]
        decision = ExecutionService().decide_and_stamp(
            "查库存然后做报价", ctx, tools
        )
        self.assertEqual(ctx.get("execution_mode"), "hybrid")
        self.assertEqual(ctx.get("execution_decision"), decision.to_dict())

    def test_internal_task_bypasses_user_classifier(self):
        called = []
        router = ExecutionRouter(lambda *_: called.append(True))
        service = ExecutionService(router)
        from bridge.context import Context

        ctx = Context(kwargs={"is_scheduled_task": True})
        decision = service.decide_and_stamp("你好", ctx, [])
        self.assertEqual(decision.mode, ExecutionMode.WORK)
        self.assertEqual(decision.reason_code, "internal_task_bypass")
        self.assertEqual(called, [])


if __name__ == "__main__":
    unittest.main()
