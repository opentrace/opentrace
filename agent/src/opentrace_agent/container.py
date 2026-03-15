"""Dependency injection container for the OpenTrace agent.

Uses ``dependency-injector`` to centralise object creation and lifecycle.

- **Singletons** (app scope): config, extractors, walker, cloner, attacher,
  loaders, registry — created once per container, never change.
- **Factories** (request scope): MCP client, graph mapper — new instance per
  call because URL and auth headers come from each request.
"""

from __future__ import annotations

from dependency_injector import containers, providers

from opentrace_agent.config import AgentConfig
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
from opentrace_agent.sources.code.source import CodeSource
from opentrace_agent.sources.code.symbol_attacher import SymbolAttacher
from opentrace_agent.sources.issue.gitlab_loader import GitLabIssueLoader
from opentrace_agent.sources.issue.linear_loader import LinearIssueLoader
from opentrace_agent.sources.issue.source import IssueSource
from opentrace_agent.sources.registry import SourceRegistry
from opentrace_agent.summarizer.base import SummarizerConfig
from opentrace_agent.summarizer.flan_t5 import FlanT5Summarizer


def _build_summarizer_config(config: AgentConfig) -> SummarizerConfig:
    """Build a :class:`SummarizerConfig` from the agent configuration."""
    return SummarizerConfig(
        enabled=config.summarization_enabled,
        model=config.summarizer_model,
        max_input_length=config.summarizer_max_input_length,
        batch_size=config.summarizer_batch_size,
        cache_dir=config.summarizer_cache_dir or None,
    )


def _build_summarizer(cfg: SummarizerConfig) -> FlanT5Summarizer | None:
    """Build a summarizer if enabled, else return None."""
    if not cfg.enabled:
        return None
    return FlanT5Summarizer(cfg)


def _build_registry(
    github_code_loader: GitHubCodeLoader,
    gitlab_issue_loader: GitLabIssueLoader,
    linear_issue_loader: LinearIssueLoader,
) -> SourceRegistry:
    """Assemble a :class:`SourceRegistry` from fully-constructed loaders.

    This bridges the imperative ``register_loader()`` API with declarative DI
    — each loader is created by the container and passed in here.
    """
    registry = SourceRegistry()

    code_source = CodeSource()
    code_source.register_loader(github_code_loader)
    registry.register(code_source)

    issue_source = IssueSource()
    issue_source.register_loader(gitlab_issue_loader)
    issue_source.register_loader(linear_issue_loader)
    registry.register(issue_source)

    return registry


class AppContainer(containers.DeclarativeContainer):
    """Root DI container for the OpenTrace agent."""

    # --- Configuration (must be provided at construction) ---
    config = providers.Dependency(instance_of=AgentConfig)

    # --- App singletons: extractors ---
    python_extractor = providers.Singleton(PythonExtractor)
    go_extractor = providers.Singleton(GoExtractor)
    typescript_extractor = providers.Singleton(TypeScriptExtractor)
    extractors = providers.List(python_extractor, typescript_extractor, go_extractor)

    # --- App singletons: summarizer ---
    summarizer_config = providers.Singleton(_build_summarizer_config, config=config)
    summarizer = providers.Singleton(_build_summarizer, cfg=summarizer_config)

    # --- App singletons: code pipeline ---
    git_cloner = providers.Singleton(GitCloner)
    directory_walker = providers.Singleton(DirectoryWalker)
    symbol_attacher = providers.Singleton(
        SymbolAttacher,
        extractors=extractors,
        summarizer=summarizer,
    )

    # --- App singletons: loaders ---
    github_code_loader = providers.Singleton(
        GitHubCodeLoader,
        cloner=git_cloner,
        walker=directory_walker,
        attacher=symbol_attacher,
    )
    gitlab_issue_loader = providers.Singleton(GitLabIssueLoader)
    linear_issue_loader = providers.Singleton(LinearIssueLoader)

    # --- App singleton: registry (assembled via factory fn) ---
    source_registry = providers.Singleton(
        _build_registry,
        github_code_loader=github_code_loader,
        gitlab_issue_loader=gitlab_issue_loader,
        linear_issue_loader=linear_issue_loader,
    )

    # --- Request factories (new instance per call) ---
    mcp_client = providers.Factory(SimpleMCPClient)
    graph_mapper = providers.Factory(GraphMapper)
