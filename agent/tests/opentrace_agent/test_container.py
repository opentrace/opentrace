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

"""Tests for the AppContainer DI wiring."""

from __future__ import annotations

from dependency_injector import providers

from opentrace_agent.config import AgentConfig
from opentrace_agent.container import AppContainer
from opentrace_agent.graph.mapper import GraphMapper
from opentrace_agent.graph.mcp_client import SimpleMCPClient
from opentrace_agent.sources.code.directory_walker import DirectoryWalker
from opentrace_agent.sources.code.extractors import (
    GoExtractor,
    PythonExtractor,
    TypeScriptExtractor,
)
from opentrace_agent.sources.code.git_cloner import GitCloner
from opentrace_agent.sources.code.github_loader import GitHubCodeLoader
from opentrace_agent.sources.code.symbol_attacher import SymbolAttacher
from opentrace_agent.sources.issue.gitlab_loader import GitLabIssueLoader
from opentrace_agent.sources.issue.linear_loader import LinearIssueLoader
from opentrace_agent.sources.registry import SourceRegistry


class TestAppContainer:
    def test_creates_registry_with_expected_sources(self):
        container = AppContainer(config=AgentConfig())
        registry = container.source_registry()

        assert isinstance(registry, SourceRegistry)
        assert "code" in registry.all_sources
        assert "issue" in registry.all_sources

    def test_registry_is_singleton(self):
        container = AppContainer(config=AgentConfig())
        r1 = container.source_registry()
        r2 = container.source_registry()
        assert r1 is r2

    def test_separate_containers_have_separate_singletons(self):
        c1 = AppContainer(config=AgentConfig())
        c2 = AppContainer(config=AgentConfig())
        assert c1.source_registry() is not c2.source_registry()

    def test_mcp_client_is_factory(self):
        container = AppContainer(config=AgentConfig())
        c1 = container.mcp_client(url="http://a/sse")
        c2 = container.mcp_client(url="http://b/sse")
        assert c1 is not c2
        assert isinstance(c1, SimpleMCPClient)
        assert c1.url == "http://a/sse"
        assert c2.url == "http://b/sse"

    def test_graph_mapper_is_factory(self):
        container = AppContainer(config=AgentConfig())
        mock_mcp_a = object()
        mock_mcp_b = object()
        m1 = container.graph_mapper(mcp=mock_mcp_a)
        m2 = container.graph_mapper(mcp=mock_mcp_b)
        assert m1 is not m2
        assert isinstance(m1, GraphMapper)

    def test_override_provider(self):
        container = AppContainer(config=AgentConfig())
        sentinel = object()
        container.mcp_client.override(providers.Object(sentinel))
        assert container.mcp_client() is sentinel
        container.mcp_client.reset_override()
        # After reset, factory behaviour is restored
        assert isinstance(container.mcp_client(url="http://x/sse"), SimpleMCPClient)

    def test_singleton_types(self):
        container = AppContainer(config=AgentConfig())
        assert isinstance(container.python_extractor(), PythonExtractor)
        assert isinstance(container.go_extractor(), GoExtractor)
        assert isinstance(container.typescript_extractor(), TypeScriptExtractor)
        assert isinstance(container.git_cloner(), GitCloner)
        assert isinstance(container.directory_walker(), DirectoryWalker)
        assert isinstance(container.symbol_attacher(), SymbolAttacher)
        assert isinstance(container.github_code_loader(), GitHubCodeLoader)
        assert isinstance(container.gitlab_issue_loader(), GitLabIssueLoader)
        assert isinstance(container.linear_issue_loader(), LinearIssueLoader)

    def test_extractors_list(self):
        container = AppContainer(config=AgentConfig())
        extractors = container.extractors()
        assert len(extractors) == 3
        types = {type(e) for e in extractors}
        assert types == {PythonExtractor, TypeScriptExtractor, GoExtractor}

    def test_github_loader_receives_injected_dependencies(self):
        container = AppContainer(config=AgentConfig())
        loader = container.github_code_loader()
        # The loader should have the same singleton instances the container provides
        assert loader._cloner is container.git_cloner()
        assert loader._walker is container.directory_walker()
        assert loader._attacher is container.symbol_attacher()
