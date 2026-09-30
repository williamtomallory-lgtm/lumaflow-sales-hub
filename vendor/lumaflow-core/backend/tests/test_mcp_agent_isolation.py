"""Shared desktop MCP tools must not become available to channel Agents."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from agent.registry import AgentProfile
from agent.tools.mcp.mcp_tool import McpTool
from agent.tools.tool_manager import ToolManager


@pytest.mark.parametrize("as_dict", [True, False])
def test_hot_reload_only_grants_shared_mcp_to_local_profiles(tmp_path, as_dict):
    manager = ToolManager()
    previous = manager._mcp_tool_instances
    desktop = McpTool(Mock(), {"name": "Snapshot", "inputSchema": {"type": "object"}}, "local-tools", "local_")
    other = McpTool(Mock(), {"name": "Lookup", "inputSchema": {"type": "object"}}, "other", "other_")
    manager._mcp_tool_instances = {desktop.name: desktop, other.name: other}
    try:
        for kind, channel, expect_desktop in (("local", None, True), ("wechat", "weixin_personal", False)):
            profile = AgentProfile(kind, kind, str(tmp_path / kind), type=kind, agent_type=channel)
            agent = SimpleNamespace(tools={} if as_dict else [], agent_profile=profile)
            manager.sync_mcp_into_agent(agent)
            names = set(agent.tools if as_dict else (tool.name for tool in agent.tools))
            assert (desktop.name in names) is expect_desktop
            assert (other.name in names) is expect_desktop
    finally:
        manager._mcp_tool_instances = previous
