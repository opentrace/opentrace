"""Tests for opentrace_agent.sources.code.source."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from opentrace_agent.sources.code.git_cloner import GitCloner
from opentrace_agent.sources.code.github_loader import GitHubCodeLoader
from opentrace_agent.sources.code.source import CodeSource


def _make_loader(tmp_path: Path) -> GitHubCodeLoader:
    """Create a GitHubCodeLoader with a mocked cloner pointing at tmp_path."""
    (tmp_path / "main.py").write_text("x = 1\n")
    mock_cloner = MagicMock(spec=GitCloner)
    mock_cloner.clone.return_value = tmp_path
    return GitHubCodeLoader(cloner=mock_cloner)


class TestCodeSource:
    def test_source_type(self):
        assert CodeSource().source_type == "code"

    def test_register_loader(self):
        source = CodeSource()
        loader = GitHubCodeLoader()
        source.register_loader(loader)
        assert len(source.loaders) == 1
        assert source.loaders[0].provider_name == "github"

    @pytest.mark.anyio
    async def test_collect_no_config(self):
        source = CodeSource()
        source.register_loader(GitHubCodeLoader())
        trees = await source.collect({})
        assert trees == []

    @pytest.mark.anyio
    async def test_collect_with_config(self, tmp_path: Path):
        source = CodeSource()
        source.register_loader(_make_loader(tmp_path))
        trees = await source.collect({"github": {"repos": [{"owner": "org", "name": "repo"}]}})
        assert len(trees) == 1
        assert trees[0].origin == "code"
        assert trees[0].root.name == "repo"
