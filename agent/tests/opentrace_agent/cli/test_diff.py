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

"""Tests for the ``opentraceai diff`` subcommand."""

from __future__ import annotations

import subprocess
from unittest.mock import patch

from opentrace_agent.cli.diff import _git_changed_files, run_diff


def _completed(stdout: str = "", returncode: int = 0) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=["git"], returncode=returncode, stdout=stdout, stderr="")


# -- _git_changed_files ------------------------------------------------------


def test_git_changed_files_filters_non_code():
    """README.md and txt files should be dropped; only code extensions kept."""
    fake_out = "src/api.py\nREADME.md\nlib/server.go\nlog.txt\n"
    with patch("subprocess.run", return_value=_completed(fake_out)):
        result = _git_changed_files("/repo", staged_only=False)
    assert result == ["src/api.py", "lib/server.go"]


def test_git_changed_files_strips_blank_lines():
    fake_out = "\nsrc/api.py\n\n\nlib/server.go\n"
    with patch("subprocess.run", return_value=_completed(fake_out)):
        assert _git_changed_files("/repo", staged_only=False) == [
            "src/api.py",
            "lib/server.go",
        ]


def test_git_changed_files_uses_HEAD_for_unstaged():
    """Without --staged, must compare against HEAD so unstaged work shows up."""
    with patch("subprocess.run", return_value=_completed("")) as mock_run:
        _git_changed_files("/repo", staged_only=False)
    args = mock_run.call_args.args[0]
    assert args == ["git", "diff", "--name-only", "HEAD"]


def test_git_changed_files_uses_cached_when_staged():
    with patch("subprocess.run", return_value=_completed("")) as mock_run:
        _git_changed_files("/repo", staged_only=True)
    args = mock_run.call_args.args[0]
    assert args == ["git", "diff", "--name-only", "--cached"]


def test_git_changed_files_returns_empty_on_nonzero_exit():
    """Running outside a git repo gives a non-zero exit — return empty, no crash."""
    with patch("subprocess.run", return_value=_completed("garbage", returncode=128)):
        assert _git_changed_files("/not-a-repo", staged_only=False) == []


def test_git_changed_files_returns_empty_when_git_missing():
    with patch("subprocess.run", side_effect=FileNotFoundError("git not on PATH")):
        assert _git_changed_files("/repo", staged_only=False) == []


def test_git_changed_files_returns_empty_on_timeout():
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("git", 10)):
        assert _git_changed_files("/repo", staged_only=False) == []


# -- run_diff ----------------------------------------------------------------


def test_run_diff_none_db(capsys):
    """Should no-op silently when db_path is None."""
    run_diff("/repo", None)
    assert capsys.readouterr().out == ""


def test_run_diff_no_changes(tmp_path, capsys):
    """No git changes → no output, no run_impact calls."""
    with patch("subprocess.run", return_value=_completed("")), patch(
        "opentrace_agent.cli.diff.run_impact"
    ) as mock_impact:
        run_diff(str(tmp_path), str(tmp_path / "db.db"))

    assert mock_impact.call_count == 0
    assert capsys.readouterr().out == ""


def test_run_diff_invokes_impact_per_file(tmp_path, capsys):
    """Each code file in the diff list should trigger a run_impact call."""
    fake_out = "src/api.py\nlib/server.go\n"
    db = str(tmp_path / "db.db")
    with patch("subprocess.run", return_value=_completed(fake_out)), patch(
        "opentrace_agent.cli.diff.run_impact"
    ) as mock_impact:
        run_diff(str(tmp_path), db)

    assert mock_impact.call_count == 2
    called_paths = [call.args[0] for call in mock_impact.call_args_list]
    assert called_paths == ["src/api.py", "lib/server.go"]
    # Each call should pass the resolved db path through.
    for call in mock_impact.call_args_list:
        assert call.args[1] == db

    out = capsys.readouterr().out
    assert "Impact of 2 changed file(s)" in out
    assert "=== src/api.py ===" in out
    assert "=== lib/server.go ===" in out


def test_run_diff_passes_staged_flag(tmp_path):
    """--staged should propagate down to the git invocation."""
    with patch("subprocess.run", return_value=_completed("")) as mock_run, patch(
        "opentrace_agent.cli.diff.run_impact"
    ):
        run_diff(str(tmp_path), str(tmp_path / "db.db"), staged_only=True)

    args = mock_run.call_args.args[0]
    assert "--cached" in args
    assert "HEAD" not in args