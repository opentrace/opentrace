# Copyright 2026 OpenTrace Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Tests for the SWE-bench agent module (unit tests, no API key needed)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from opentrace_agent.benchmarks.agent import (
    CLAUDE_CODE_PROMPT,
    OPENTRACE_TOOLS,
    SYSTEM_PROMPT,
    ToolDispatcher,
    create_claude_code_agent_fn,
)

FIXTURES_ROOT = Path(__file__).resolve().parents[2] / "fixtures"
LEVEL1 = FIXTURES_ROOT / "level1"


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------


class TestToolDefinitions:
    def test_all_tools_have_required_fields(self):
        for tool in OPENTRACE_TOOLS:
            assert "name" in tool
            assert "description" in tool
            assert "input_schema" in tool
            assert tool["input_schema"]["type"] == "object"

    def test_tool_names(self):
        names = {t["name"] for t in OPENTRACE_TOOLS}
        assert "search_graph" in names
        assert "list_nodes" in names
        assert "get_node" in names
        assert "traverse_graph" in names
        assert "get_stats" in names
        assert "read_file" in names
        assert "list_directory" in names
        assert "generate_patch" in names

    def test_system_prompt_has_placeholders(self):
        # Verify the template can be formatted both ways
        with_ot = SYSTEM_PROMPT.format(
            opentrace_section="OT tools here",
            graph_strategy="Use graph",
        )
        assert "OT tools here" in with_ot

        without_ot = SYSTEM_PROMPT.format(
            opentrace_section="",
            graph_strategy="Use files",
        )
        assert "Use files" in without_ot


# ---------------------------------------------------------------------------
# ToolDispatcher
# ---------------------------------------------------------------------------


class TestToolDispatcher:
    def test_read_file(self):
        dispatcher = ToolDispatcher(LEVEL1)
        result = dispatcher.dispatch("read_file", {"path": "app.py"})
        assert "Calculator" in result
        assert "def main" in result

    def test_read_file_not_found(self):
        dispatcher = ToolDispatcher(LEVEL1)
        result = dispatcher.dispatch("read_file", {"path": "nonexistent.py"})
        parsed = json.loads(result)
        assert "error" in parsed

    def test_read_file_path_traversal(self):
        dispatcher = ToolDispatcher(LEVEL1)
        result = dispatcher.dispatch("read_file", {"path": "../../../etc/passwd"})
        parsed = json.loads(result)
        assert "error" in parsed
        assert "traversal" in parsed["error"].lower()

    def test_list_directory(self):
        dispatcher = ToolDispatcher(LEVEL1)
        result = dispatcher.dispatch("list_directory", {"path": "."})
        entries = json.loads(result)
        names = {e["name"] for e in entries}
        assert "app.py" in names

    def test_list_directory_not_found(self):
        dispatcher = ToolDispatcher(LEVEL1)
        result = dispatcher.dispatch("list_directory", {"path": "nonexistent"})
        parsed = json.loads(result)
        assert "error" in parsed

    def test_generate_patch(self):
        dispatcher = ToolDispatcher(LEVEL1)
        patch = "--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-old\n+new"
        result = dispatcher.dispatch("generate_patch", {"patch": patch})
        assert "submitted" in result.lower()
        assert dispatcher.patch == patch

    def test_patch_starts_none(self):
        dispatcher = ToolDispatcher(LEVEL1)
        assert dispatcher.patch is None

    def test_mcp_tools_not_available(self):
        dispatcher = ToolDispatcher(LEVEL1, mcp_tools=None)
        result = dispatcher.dispatch("search_graph", {"query": "test"})
        parsed = json.loads(result)
        assert "error" in parsed
        assert "not available" in parsed["error"]

    def test_mcp_tools_dispatch(self):
        mock_tool = MagicMock()
        mock_tool.fn.return_value = json.dumps([{"name": "Calculator"}])
        mcp_tools = {"search_graph": mock_tool}

        dispatcher = ToolDispatcher(LEVEL1, mcp_tools=mcp_tools)
        result = dispatcher.dispatch("search_graph", {"query": "Calculator", "nodeTypes": "Class"})
        parsed = json.loads(result)
        assert parsed[0]["name"] == "Calculator"
        mock_tool.fn.assert_called_once_with(query="Calculator", nodeTypes="Class")

    def test_unknown_tool(self):
        dispatcher = ToolDispatcher(LEVEL1)
        result = dispatcher.dispatch("nonexistent_tool", {})
        parsed = json.loads(result)
        assert "error" in parsed


# ---------------------------------------------------------------------------
# create_agent_fn
# ---------------------------------------------------------------------------


class TestCreateAgentFn:
    def test_import_error_without_anthropic(self, monkeypatch):
        """create_agent_fn should raise ImportError when anthropic isn't installed."""
        import importlib
        import sys

        # Temporarily hide anthropic
        saved = sys.modules.get("anthropic")
        sys.modules["anthropic"] = None  # type: ignore[assignment]
        try:
            # Reload the module to trigger fresh import
            from opentrace_agent.benchmarks import agent

            importlib.reload(agent)
            with pytest.raises(ImportError, match="anthropic"):
                agent.create_agent_fn()
        finally:
            if saved is not None:
                sys.modules["anthropic"] = saved
            else:
                sys.modules.pop("anthropic", None)

    def test_missing_api_key(self, monkeypatch):
        """Should raise ValueError when no API key is available."""
        pytest.importorskip("anthropic")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

        from opentrace_agent.benchmarks.agent import create_agent_fn

        with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
            create_agent_fn(api_key=None)


# ---------------------------------------------------------------------------
# Claude Code agent
# ---------------------------------------------------------------------------


class TestClaudeCodeAgent:
    def test_prompt_template(self):
        rendered = CLAUDE_CODE_PROMPT.format(
            problem_statement="Fix the bug",
            repo_path="/tmp/repo",
            explore_instruction="Use OT tools",
        )
        assert "Fix the bug" in rendered
        assert "/tmp/repo" in rendered
        assert "Use OT tools" in rendered

    def test_create_raises_if_claude_not_found(self, monkeypatch):
        monkeypatch.setattr("shutil.which", lambda _cmd: None)
        with pytest.raises(FileNotFoundError, match="not found on PATH"):
            create_claude_code_agent_fn(claude_cmd="claude-nonexistent")

    def test_create_returns_callable(self):
        """If claude is on PATH, create should return a callable."""
        import shutil

        if shutil.which("claude") is None:
            pytest.skip("claude CLI not on PATH")
        fn = create_claude_code_agent_fn()
        assert callable(fn)

    def test_mcp_config_injected_in_args(self, monkeypatch, tmp_path):
        """Verify that when mcp_config has db_path, the MCP config file is created."""
        import shutil

        if shutil.which("claude") is None:
            pytest.skip("claude CLI not on PATH")

        captured_args = []

        def mock_run(args, **kwargs):
            captured_args.extend(args)
            result = type("Result", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            return result

        monkeypatch.setattr("subprocess.run", mock_run)

        fn = create_claude_code_agent_fn()
        fn(
            "Fix the bug",
            tmp_path,
            {"db_path": "/tmp/test.db", "command": "opentraceai"},
        )

        args_str = " ".join(captured_args)
        assert "--mcp-config" in args_str
        assert "--strict-mcp-config" in args_str
        # MCP config is written to a temp file — read it to verify contents
        mcp_idx = captured_args.index("--mcp-config")
        mcp_file = Path(captured_args[mcp_idx + 1])
        assert mcp_file.exists()
        config = json.loads(mcp_file.read_text())
        assert "opentrace-oss" in config["mcpServers"]
        assert "test.db" in str(config["mcpServers"]["opentrace-oss"]["args"])
