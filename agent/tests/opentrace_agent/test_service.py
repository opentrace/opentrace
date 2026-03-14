"""Tests for opentrace_agent.service."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from dependency_injector import providers

from opentrace_agent.config import AgentConfig
from opentrace_agent.container import AppContainer
from opentrace_agent.gen.opentrace.v1 import agent_service_pb2 as pb2
from opentrace_agent.gen.opentrace.v1 import job_config_pb2
from opentrace_agent.service import (
    AgentServiceServicer,
    _git_integrations_to_sources_config,
)


# ---------------------------------------------------------------------------
# _git_integrations_to_sources_config
# ---------------------------------------------------------------------------


class TestGitIntegrationsToSourcesConfig:
    def test_empty_list(self):
        assert _git_integrations_to_sources_config([]) == {}

    def test_basic_url_parsing(self):
        integration = job_config_pb2.GitIntegrationConfig(
            repo_url="https://github.com/myorg/myrepo",
            ref="develop",
            personal_access_token="tok123",
        )
        result = _git_integrations_to_sources_config([integration])

        repos = result["code"]["github"]["repos"]
        assert len(repos) == 1
        assert repos[0]["owner"] == "myorg"
        assert repos[0]["name"] == "myrepo"
        assert repos[0]["branch"] == "develop"
        assert repos[0]["token"] == "tok123"

    def test_url_with_git_suffix(self):
        integration = job_config_pb2.GitIntegrationConfig(
            repo_url="https://github.com/org/repo.git",
        )
        result = _git_integrations_to_sources_config([integration])

        repos = result["code"]["github"]["repos"]
        assert repos[0]["name"] == "repo"

    def test_no_ref_or_token_omitted(self):
        integration = job_config_pb2.GitIntegrationConfig(
            repo_url="https://github.com/org/repo",
        )
        result = _git_integrations_to_sources_config([integration])
        repo = result["code"]["github"]["repos"][0]

        assert "branch" not in repo
        assert "token" not in repo

    def test_multiple_integrations(self):
        integrations = [
            job_config_pb2.GitIntegrationConfig(
                repo_url="https://github.com/a/alpha",
            ),
            job_config_pb2.GitIntegrationConfig(
                repo_url="https://github.com/b/beta",
            ),
        ]
        result = _git_integrations_to_sources_config(integrations)

        repos = result["code"]["github"]["repos"]
        assert len(repos) == 2
        names = {r["name"] for r in repos}
        assert names == {"alpha", "beta"}

    def test_invalid_url_skipped(self):
        integrations = [
            job_config_pb2.GitIntegrationConfig(repo_url="not-a-url"),
            job_config_pb2.GitIntegrationConfig(
                repo_url="https://github.com/ok/repo",
            ),
        ]
        result = _git_integrations_to_sources_config(integrations)

        repos = result["code"]["github"]["repos"]
        assert len(repos) == 1
        assert repos[0]["name"] == "repo"

    def test_all_invalid_returns_empty(self):
        integrations = [
            job_config_pb2.GitIntegrationConfig(repo_url="bad"),
        ]
        assert _git_integrations_to_sources_config(integrations) == {}


# ---------------------------------------------------------------------------
# RunJob integration tests
# ---------------------------------------------------------------------------


class _ClosableMockMCPClient:
    """MockMCPClient with a trackable async close() method."""

    def __init__(self):
        self.close = AsyncMock()

    def __getattr__(self, name: str) -> AsyncMock:
        if name.startswith("_"):
            raise AttributeError(name)
        return AsyncMock(return_value='{"status": "ok"}')


async def _collect_events(
    request: pb2.RunJobRequest,
    container: AppContainer | None = None,
) -> list[pb2.RunJobEvent]:
    """Run the servicer and collect all streamed events."""
    if container is None:
        container = AppContainer(config=AgentConfig())
    servicer = AgentServiceServicer(container)
    events = []
    async for event in servicer.RunJob(request, context=None):
        events.append(event)
    return events


def _make_request(
    *repo_urls: str,
    mcp_url: str = "http://localhost:9999/sse",
    api_key: str = "test-key",
) -> pb2.RunJobRequest:
    integrations = [
        job_config_pb2.GitIntegrationConfig(
            repo_url=url,
            ref="main",
            personal_access_token="tok",
        )
        for url in repo_urls
    ]
    return pb2.RunJobRequest(
        mcp_url=mcp_url,
        api_key=api_key,
        git_integrations=integrations,
    )


class TestRunJob:
    @pytest.mark.anyio
    async def test_empty_integrations_yields_error(self):
        """No integrations -> ERROR event."""
        request = pb2.RunJobRequest(mcp_url="http://localhost/sse")
        events = await _collect_events(request)

        assert len(events) >= 2  # STARTING + ERROR
        assert events[-1].phase == pb2.JOB_PHASE_ERROR

    @pytest.mark.anyio
    async def test_full_pipeline_phase_order(self, mock_mcp, tmp_path):
        """Happy path: STARTING -> PLANNING -> LOADING -> MAPPING -> DONE."""
        (tmp_path / "main.py").write_text("def hello(): pass\n")

        mock_cloner = MagicMock()
        mock_cloner.clone.return_value = tmp_path

        request = _make_request("https://github.com/testorg/testrepo")

        container = AppContainer(config=AgentConfig())
        container.git_cloner.override(providers.Object(mock_cloner))
        container.mcp_client.override(providers.Object(mock_mcp))

        events = await _collect_events(request, container)

        phases = [e.phase for e in events]
        assert phases[0] == pb2.JOB_PHASE_STARTING
        assert phases[1] == pb2.JOB_PHASE_PLANNING
        loading_events = [e for e in events if e.phase == pb2.JOB_PHASE_LOADING]
        assert len(loading_events) >= 1
        assert phases[-2] == pb2.JOB_PHASE_MAPPING
        assert phases[-1] == pb2.JOB_PHASE_DONE

        done_event = events[-1]
        assert done_event.result.nodes_created > 0
        assert done_event.result.repos_processed == 1

    @pytest.mark.anyio
    async def test_mcp_client_closed_on_success(self, tmp_path):
        """MCP client should be closed even after successful run."""
        (tmp_path / "a.py").write_text("x = 1\n")

        mock_cloner = MagicMock()
        mock_cloner.clone.return_value = tmp_path

        mock_client = _ClosableMockMCPClient()

        request = _make_request("https://github.com/o/r")

        container = AppContainer(config=AgentConfig())
        container.git_cloner.override(providers.Object(mock_cloner))
        container.mcp_client.override(providers.Object(mock_client))

        events = await _collect_events(request, container)

        mock_client.close.assert_awaited_once()

    @pytest.mark.anyio
    async def test_error_during_loading_yields_error(self, tmp_path):
        """When all sources fail during loading, an ERROR event is emitted.

        The MCP client is only created in the mapping phase, so if loading
        fails and no trees are produced, the pipeline returns early and no
        MCP client is ever instantiated (or closed).
        """
        # Make all sources fail during collect()
        mock_source = MagicMock()
        mock_source.source_type = "code"
        mock_source.loaders = [MagicMock(provider_name="github")]
        mock_source.collect = AsyncMock(side_effect=RuntimeError("load failed"))

        mock_registry = MagicMock()
        mock_registry.all_sources = {"code": mock_source}
        mock_registry.get.return_value = mock_source

        request = _make_request("https://github.com/o/r")

        container = AppContainer(config=AgentConfig())
        container.source_registry.override(providers.Object(mock_registry))

        events = await _collect_events(request, container)

        # Should get ERROR because no trees were produced
        assert any(e.phase == pb2.JOB_PHASE_ERROR for e in events)
        error_events = [e for e in events if e.phase == pb2.JOB_PHASE_ERROR]
        assert any("load failed" in str(e.errors) for e in error_events)

    @pytest.mark.anyio
    async def test_error_in_registry_yields_error_event(self):
        """If source_registry() raises, we still get an ERROR event."""
        request = _make_request("https://github.com/o/r")

        container = AppContainer(config=AgentConfig())
        container.source_registry.override(
            providers.Factory(MagicMock, side_effect=RuntimeError("boom")),
        )

        # Override so calling the provider raises
        def _boom():
            raise RuntimeError("boom")

        container.source_registry.override(providers.Callable(_boom))

        events = await _collect_events(request, container)

        assert any(e.phase == pb2.JOB_PHASE_ERROR for e in events)
        error_event = [e for e in events if e.phase == pb2.JOB_PHASE_ERROR][0]
        assert "boom" in error_event.message

    @pytest.mark.anyio
    async def test_loading_event_has_repo_url(self, mock_mcp, tmp_path):
        """LOADING events should include the repo URL."""
        (tmp_path / "f.py").write_text("pass\n")

        mock_cloner = MagicMock()
        mock_cloner.clone.return_value = tmp_path

        request = _make_request("https://github.com/org/myrepo")

        container = AppContainer(config=AgentConfig())
        container.git_cloner.override(providers.Object(mock_cloner))
        container.mcp_client.override(providers.Object(mock_mcp))

        events = await _collect_events(request, container)

        loading = [e for e in events if e.phase == pb2.JOB_PHASE_LOADING]
        assert len(loading) >= 1
        assert "github.com/org/myrepo" in loading[0].repo_url
