"""Tests for opentrace_agent.sources.code.git_cloner."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from opentrace_agent.sources.code.git_cloner import GitCloner, _inject_token


class TestInjectToken:
    def test_github_https(self):
        url = _inject_token("https://github.com/owner/repo", "tok123")
        assert url == "https://oauth2:tok123@github.com/owner/repo"

    def test_gitlab_https(self):
        url = _inject_token("https://gitlab.com/owner/repo.git", "abc")
        assert url == "https://oauth2:abc@gitlab.com/owner/repo.git"

    def test_url_with_port(self):
        url = _inject_token("https://git.example.com:8443/repo", "t")
        assert url == "https://oauth2:t@git.example.com:8443/repo"

    def test_rejects_ssh_url(self):
        with pytest.raises(ValueError, match="HTTPS"):
            _inject_token("git@github.com:owner/repo.git", "tok")


class TestGitCloner:
    @patch("opentrace_agent.sources.code.git_cloner.git.Repo.clone_from")
    def test_clone_with_token(self, mock_clone: MagicMock, tmp_path: Path):
        cloner = GitCloner()
        dest = tmp_path / "clone"
        dest.mkdir()

        result = cloner.clone(
            repo_url="https://github.com/owner/repo",
            ref="main",
            token="secret",
            dest=dest,
        )

        assert result == dest
        mock_clone.assert_called_once()
        call_args = mock_clone.call_args
        # URL should have token injected
        assert "oauth2:secret@github.com" in call_args[0][0]
        assert call_args[0][1] == str(dest)
        assert call_args[1]["branch"] == "main"
        assert call_args[1]["depth"] == 1

    @patch("opentrace_agent.sources.code.git_cloner.git.Repo.clone_from")
    def test_clone_without_token(self, mock_clone: MagicMock, tmp_path: Path):
        cloner = GitCloner()
        dest = tmp_path / "clone"
        dest.mkdir()

        cloner.clone(repo_url="https://github.com/o/r", dest=dest)

        call_args = mock_clone.call_args
        # URL should NOT have oauth2 prefix
        assert call_args[0][0] == "https://github.com/o/r"

    @patch("opentrace_agent.sources.code.git_cloner.git.Repo.clone_from")
    def test_clone_creates_temp_dir_when_no_dest(self, mock_clone: MagicMock):
        cloner = GitCloner()
        result = cloner.clone(repo_url="https://github.com/o/r")
        # Should return a Path that starts with the temp prefix
        assert isinstance(result, Path)
        assert "ot-clone-" in str(result)

    @patch("opentrace_agent.sources.code.git_cloner.git.Repo.clone_from")
    def test_clone_env_strips_git_vars(self, mock_clone: MagicMock, tmp_path: Path):
        cloner = GitCloner()
        cloner.clone(repo_url="https://github.com/o/r", dest=tmp_path)

        env = mock_clone.call_args[1]["env"]
        assert env["GIT_TERMINAL_PROMPT"] == "0"
        # No GIT_* vars from the host environment should leak through
        # (except the ones we explicitly set)
        for key in env:
            if key.startswith("GIT_") and key != "GIT_TERMINAL_PROMPT" and key != "GIT_ASKPASS":
                pytest.fail(f"Unexpected GIT_ env var: {key}")
