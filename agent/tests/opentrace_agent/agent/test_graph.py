"""Tests for opentrace_agent.agent.graph."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from opentrace_agent.agent.graph import build_agent_graph
from opentrace_agent.graph.mapper import GraphMapper
from opentrace_agent.sources.code.git_cloner import GitCloner
from opentrace_agent.sources.code.github_loader import GitHubCodeLoader
from opentrace_agent.sources.code.source import CodeSource
from opentrace_agent.sources.issue.gitlab_loader import GitLabIssueLoader
from opentrace_agent.sources.issue.linear_loader import LinearIssueLoader
from opentrace_agent.sources.issue.source import IssueSource
from opentrace_agent.sources.registry import SourceRegistry

from tests.conftest import MockMCPClient


def _build_registry(tmp_path: Path) -> SourceRegistry:
    """Build a registry with a mocked git cloner."""
    (tmp_path / "main.py").write_text("class App:\n    def run(self): pass\n")

    mock_cloner = MagicMock(spec=GitCloner)
    mock_cloner.clone.return_value = tmp_path

    registry = SourceRegistry()

    code_source = CodeSource()
    code_source.register_loader(GitHubCodeLoader(cloner=mock_cloner))
    registry.register(code_source)

    issue_source = IssueSource()
    issue_source.register_loader(GitLabIssueLoader())
    issue_source.register_loader(LinearIssueLoader())
    registry.register(issue_source)

    return registry


class TestAgentGraph:
    @pytest.mark.anyio
    async def test_no_sources_configured(self):
        registry = SourceRegistry()
        mapper = GraphMapper(MockMCPClient())
        agent = build_agent_graph(registry, mapper)

        result = await agent.ainvoke({"sources_config": {}})

        assert result["sources_to_run"] == []
        assert result["mapping_result"] is None

    @pytest.mark.anyio
    async def test_full_pipeline(self, tmp_path: Path):
        registry = _build_registry(tmp_path)
        mapper = GraphMapper(MockMCPClient())
        agent = build_agent_graph(registry, mapper)

        result = await agent.ainvoke(
            {
                "sources_config": {
                    "code": {
                        "github": {
                            "repos": [{"owner": "org", "name": "repo"}],
                        },
                    },
                },
            }
        )

        assert "code" in result["sources_to_run"]
        assert len(result["trees"]) == 1
        mr = result["mapping_result"]
        assert mr is not None
        assert mr.nodes_created > 0

    @pytest.mark.anyio
    async def test_multiple_sources(self, tmp_path: Path):
        registry = _build_registry(tmp_path)
        mapper = GraphMapper(MockMCPClient())
        agent = build_agent_graph(registry, mapper)

        result = await agent.ainvoke(
            {
                "sources_config": {
                    "code": {
                        "github": {"repos": [{"owner": "o", "name": "r"}]},
                    },
                    "issue": {
                        "linear": {"teams": [{"key": "ENG", "name": "Eng"}]},
                    },
                },
            }
        )

        assert set(result["sources_to_run"]) == {"code", "issue"}
        assert len(result["trees"]) == 2
