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

"""Tests for the post-commit git hook CLI (``opentraceai hook``)."""

from __future__ import annotations

import stat
from pathlib import Path

import click
import pytest
from click.testing import CliRunner

from opentrace_agent.cli.hook import (
    MARKER,
    _find_repo_root,
    hook_app,
    hook_status,
    install_hook,
    uninstall_hook,
)


@pytest.fixture()
def repo(tmp_path):
    """Minimal git repo skeleton — just .git/ is enough for hook operations."""
    (tmp_path / ".git").mkdir()
    return tmp_path


class TestInstall:
    def test_creates_executable_hook(self, repo):
        path = install_hook(repo)
        assert path.exists()
        assert MARKER in path.read_text()
        assert path.stat().st_mode & stat.S_IXUSR

    def test_overwrites_own_hook(self, repo):
        install_hook(repo)
        install_hook(repo)

    def test_refuses_to_clobber_unknown_hook(self, repo):
        hooks = repo / ".git" / "hooks"
        hooks.mkdir()
        (hooks / "post-commit").write_text("#!/usr/bin/env bash\necho 'custom'\n")
        with pytest.raises(click.ClickException, match="written by opentraceai"):
            install_hook(repo)

    def test_creates_hooks_dir_if_missing(self, repo):
        path = install_hook(repo)
        assert path.parent.exists()


class TestUninstall:
    def test_removes_installed_hook(self, repo):
        install_hook(repo)
        assert uninstall_hook(repo) is True
        assert not (repo / ".git" / "hooks" / "post-commit").exists()

    def test_no_op_when_missing(self, repo):
        assert uninstall_hook(repo) is False

    def test_refuses_to_remove_unknown_hook(self, repo):
        hooks = repo / ".git" / "hooks"
        hooks.mkdir()
        (hooks / "post-commit").write_text("#!/usr/bin/env bash\necho hi\n")
        with pytest.raises(click.ClickException):
            uninstall_hook(repo)


class TestStatus:
    def test_reports_installed(self, repo):
        install_hook(repo)
        s = hook_status(repo)
        assert s["installed"] is True
        assert s["executable"] is True

    def test_reports_uninstalled(self, repo):
        assert hook_status(repo)["installed"] is False

    def test_distinguishes_foreign_hook(self, repo):
        hooks = repo / ".git" / "hooks"
        hooks.mkdir()
        (hooks / "post-commit").write_text("#!/usr/bin/env bash\necho hi\n")
        s = hook_status(repo)
        assert s["installed"] is False
        assert Path(str(s["path"])).exists()


class TestCli:
    def test_install_uninstall_roundtrip(self, repo):
        runner = CliRunner()
        r1 = runner.invoke(hook_app, ["install", "--repo", str(repo)])
        assert r1.exit_code == 0
        assert "Installed hook" in r1.output

        r2 = runner.invoke(hook_app, ["status", "--repo", str(repo)])
        assert r2.exit_code == 0
        assert "Installed:" in r2.output

        r3 = runner.invoke(hook_app, ["uninstall", "--repo", str(repo)])
        assert r3.exit_code == 0
        assert "removed" in r3.output

        r4 = runner.invoke(hook_app, ["status", "--repo", str(repo)])
        assert r4.exit_code == 0
        assert "Not installed" in r4.output

    def test_rejects_non_repo(self, tmp_path):
        runner = CliRunner()
        r = runner.invoke(hook_app, ["install", "--repo", str(tmp_path)])
        assert r.exit_code != 0
        assert "Not a git repository" in r.output

    def test_default_repo_is_cwd(self, repo, monkeypatch):
        monkeypatch.chdir(repo)
        runner = CliRunner()
        r = runner.invoke(hook_app, ["install"])
        assert r.exit_code == 0


class TestFindRepoRoot:
    def test_finds_root_from_subdirectory(self, repo):
        nested = repo / "a" / "b" / "c"
        nested.mkdir(parents=True)
        assert _find_repo_root(nested) == repo

    def test_finds_root_when_called_at_root(self, repo):
        assert _find_repo_root(repo) == repo

    def test_returns_none_when_no_repo(self, tmp_path):
        # tmp_path has no .git anywhere up to /tmp
        assert _find_repo_root(tmp_path) is None

    def test_returns_repo_when_start_is_a_file(self, repo, tmp_path):
        f = repo / "README.md"
        f.write_text("x")
        # Callers always pass directories, but resolve() on a file path still
        # yields a path whose parents traverse correctly.
        assert _find_repo_root(f.parent) == repo

    def test_handles_worktree_gitdir_pointer(self, tmp_path):
        # A worktree has .git as a *file* (gitdir: pointer), not a directory.
        worktree = tmp_path / "worktree"
        worktree.mkdir()
        (worktree / ".git").write_text("gitdir: /irrelevant/for/this/test\n")
        assert _find_repo_root(worktree) == worktree

    def test_resolves_symlinks(self, tmp_path):
        repo = tmp_path / "real"
        repo.mkdir()
        (repo / ".git").mkdir()
        link = tmp_path / "link"
        link.symlink_to(repo)
        # Start path is a symlink; the returned root should be the resolved
        # canonical repo path.
        assert _find_repo_root(link) == repo


class TestWorktreeLayout:
    def test_resolves_worktree_gitdir_file(self, tmp_path):
        # Simulate a git worktree where .git is a file pointing back to
        # the main repo's worktrees directory.
        main_repo = tmp_path / "main"
        main_repo.mkdir()
        worktrees = main_repo / ".git" / "worktrees" / "feature"
        worktrees.mkdir(parents=True)
        (worktrees / "hooks").mkdir()

        worktree = tmp_path / "worktree"
        worktree.mkdir()
        (worktree / ".git").write_text(f"gitdir: {worktrees}\n")

        path = install_hook(worktree)
        assert path == worktrees / "hooks" / "post-commit"
        assert path.exists()
