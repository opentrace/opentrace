"""Tests for opentrace_agent.sources.code.github_loader."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from opentrace_agent.sources.code.git_cloner import GitCloner
from opentrace_agent.sources.code.github_loader import GitHubCodeLoader


class TestGitHubCodeLoader:
    def test_provider_name(self):
        assert GitHubCodeLoader().provider_name == "github"

    @pytest.mark.anyio
    async def test_load_no_repos(self):
        loader = GitHubCodeLoader()
        trees = await loader.load({})
        assert trees == []

    @pytest.mark.anyio
    async def test_load_with_repo(self, tmp_path: Path):
        """Full pipeline test with mocked cloner, real walker and attacher."""
        # Set up a small file tree on disk
        (tmp_path / "main.py").write_text("class App:\n    def run(self): pass\n")
        (tmp_path / "utils.py").write_text("def helper(): pass\n")

        # Mock the cloner to return our tmp_path instead of cloning
        mock_cloner = MagicMock(spec=GitCloner)
        mock_cloner.clone.return_value = tmp_path

        loader = GitHubCodeLoader(cloner=mock_cloner)
        trees = await loader.load({"repos": [{"owner": "org", "name": "repo", "branch": "develop"}]})

        assert len(trees) == 1
        tree = trees[0]
        assert tree.origin == "code"
        assert tree.root.id == "org/repo"
        assert tree.root.name == "repo"
        assert tree.counters["repos"] == 1
        assert tree.counters["files"] >= 2
        assert tree.counters["classes"] >= 1  # App
        assert tree.counters["functions"] >= 2  # run, helper

        # Cloner should have been called with the right URL
        mock_cloner.clone.assert_called_once()
        call_kwargs = mock_cloner.clone.call_args[1]
        assert "github.com/org/repo" in call_kwargs["repo_url"]
        assert call_kwargs["ref"] == "develop"

    @pytest.mark.anyio
    async def test_load_with_token(self, tmp_path: Path):
        mock_cloner = MagicMock(spec=GitCloner)
        mock_cloner.clone.return_value = tmp_path

        loader = GitHubCodeLoader(cloner=mock_cloner)
        await loader.load({"repos": [{"owner": "o", "name": "r", "token": "secret123"}]})

        call_kwargs = mock_cloner.clone.call_args[1]
        assert call_kwargs["token"] == "secret123"

    @pytest.mark.anyio
    async def test_load_continues_on_error(self, tmp_path: Path):
        """If one repo fails, the rest should still be processed."""
        (tmp_path / "ok.py").write_text("x = 1\n")

        mock_cloner = MagicMock(spec=GitCloner)
        # First call fails, second succeeds
        mock_cloner.clone.side_effect = [
            RuntimeError("auth failed"),
            tmp_path,
        ]

        loader = GitHubCodeLoader(cloner=mock_cloner)
        trees = await loader.load(
            {
                "repos": [
                    {"owner": "bad", "name": "repo"},
                    {"owner": "good", "name": "repo"},
                ]
            }
        )

        # Only the successful one should produce a tree
        assert len(trees) == 1
        assert trees[0].root.id == "good/repo"

    @pytest.mark.anyio
    async def test_load_cleans_up_tmp_dir(self, tmp_path: Path):
        """Temporary directory should be cleaned up after processing."""
        mock_cloner = MagicMock(spec=GitCloner)
        mock_cloner.clone.return_value = tmp_path

        with (
            patch("opentrace_agent.sources.code.github_loader.tempfile") as mock_tempfile,
            patch("opentrace_agent.sources.code.github_loader.shutil") as mock_shutil,
        ):
            mock_tempfile.mkdtemp.return_value = str(tmp_path)

            loader = GitHubCodeLoader(cloner=mock_cloner)
            await loader.load({"repos": [{"owner": "o", "name": "r"}]})

            # shutil.rmtree should have been called for cleanup
            mock_shutil.rmtree.assert_called_once()

    @pytest.mark.anyio
    async def test_load_multiple_repos(self, tmp_path: Path):
        dir_a = tmp_path / "a"
        dir_b = tmp_path / "b"
        dir_a.mkdir()
        dir_b.mkdir()
        (dir_a / "a.py").write_text("def a(): pass\n")
        (dir_b / "b.py").write_text("def b(): pass\n")

        mock_cloner = MagicMock(spec=GitCloner)
        mock_cloner.clone.side_effect = [dir_a, dir_b]

        loader = GitHubCodeLoader(cloner=mock_cloner)
        trees = await loader.load(
            {
                "repos": [
                    {"owner": "org", "name": "alpha"},
                    {"owner": "org", "name": "beta"},
                ]
            }
        )

        assert len(trees) == 2
        ids = {t.root.id for t in trees}
        assert ids == {"org/alpha", "org/beta"}
