"""Tests for opentrace_agent.sources.registry."""

from opentrace_agent.sources.code.source import CodeSource
from opentrace_agent.sources.issue.source import IssueSource
from opentrace_agent.sources.registry import SourceRegistry


class TestSourceRegistry:
    def test_register_and_get(self):
        registry = SourceRegistry()
        source = CodeSource()
        registry.register(source)

        assert registry.get("code") is source
        assert registry.get("nonexistent") is None

    def test_all_sources(self):
        registry = SourceRegistry()
        registry.register(CodeSource())
        registry.register(IssueSource())
        assert set(registry.all_sources.keys()) == {"code", "issue"}
