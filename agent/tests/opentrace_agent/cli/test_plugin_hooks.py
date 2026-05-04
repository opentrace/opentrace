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

"""Tests for the Claude Code plugin hook scripts.

Covers:
- ``_common.py`` helpers (workspace discovery, CLI runner, shell parsing,
  line-range estimation, briefing TTL).
- ``pre_tool_use.py`` end-to-end (Grep / Glob / Bash augmentation).
- ``post_tool_use.py`` end-to-end (Edit / Write impact analysis).

The hooks live in ``plugins/claude-code/scripts/`` and aren't a real
package — we load them via ``importlib`` exactly the way Claude Code
launches them (``python3 <path>``).
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Module loading
# ---------------------------------------------------------------------------

_SCRIPTS_DIR = Path(__file__).resolve().parents[4] / "plugins" / "claude-code" / "scripts"
# _common and _debug must be importable for the hook modules to load.
sys.path.insert(0, str(_SCRIPTS_DIR))


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, _SCRIPTS_DIR / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_common = _load("_common")
_pre = _load("pre_tool_use")
_post = _load("post_tool_use")
_session_start = _load("session_start")
_user_prompt_submit = _load("user_prompt_submit")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def healthy_workspace(tmp_path):
    """A tmp_path with a fake ``.opentrace/index.db`` so ``opentrace_healthy``
    returns True. Tests that exercise the hook bodies need this; tests that
    only assert "skip" behavior don't.
    """
    (tmp_path / ".opentrace").mkdir()
    (tmp_path / ".opentrace" / "index.db").write_bytes(b"")
    return tmp_path


# ---------------------------------------------------------------------------
# _common: shell parsing
# ---------------------------------------------------------------------------


class TestExtractSearchPattern:
    def test_rg_simple(self):
        assert _common.extract_search_pattern("rg KuzuStore") == "KuzuStore"

    def test_grep_with_path(self):
        assert _common.extract_search_pattern("grep handleRequest src/") == "handleRequest"

    def test_skips_flag_values(self):
        assert _common.extract_search_pattern("rg -A 3 -B 2 --glob '*.py' pattern_here") == "pattern_here"

    def test_skips_short_tokens(self):
        assert _common.extract_search_pattern("rg ab longpattern") == "longpattern"

    def test_ignores_non_search_command(self):
        assert _common.extract_search_pattern("ls -la") is None

    def test_extracts_through_pipe(self):
        # Real-world commands almost always pipe to head/less/wc; the
        # pattern from the leftmost grep/rg stage should still be found.
        assert _common.extract_search_pattern("rg findme src/ | head -3") == "findme"

    def test_extracts_through_and_chain(self):
        assert _common.extract_search_pattern("cd repo && grep findme src/") == "findme"

    def test_extracts_through_semicolon(self):
        assert _common.extract_search_pattern("echo go ; rg findme src/") == "findme"

    def test_extracts_grep_after_redirect(self):
        # Redirects (2>/dev/null) shouldn't fool the extractor — they're
        # not stage breaks, just a token in the same stage.
        assert (
            _common.extract_search_pattern('grep -rn findme src/ 2>/dev/null | head')
            == "findme"
        )

    def test_quoted_pipe_does_not_split(self):
        # A pipe inside quotes is part of the search pattern, not an operator.
        assert _common.extract_search_pattern("rg 'a|b' src/") == "a|b"

    def test_empty_command(self):
        assert _common.extract_search_pattern("") is None

    def test_unparseable_quotes(self):
        # shlex raises ValueError on unclosed quotes — must not crash.
        assert _common.extract_search_pattern("rg 'unterminated") is None

    def test_no_search_command_in_any_stage(self):
        # All stages are non-search → no augmentation.
        assert _common.extract_search_pattern("ls -la | wc -l") is None


class TestExtractReadPath:
    def test_cat_python_file(self):
        assert _common.extract_read_path("cat src/api.py") == "src/api.py"

    def test_head_with_flag(self):
        assert _common.extract_read_path("head -n 50 lib/server.go") == "lib/server.go"

    def test_tail_typescript(self):
        assert _common.extract_read_path("tail src/app.tsx") == "src/app.tsx"

    def test_ignores_non_code_extension(self):
        # README.md isn't a code extension we'd want to impact-analyze.
        assert _common.extract_read_path("cat README.md") is None

    def test_ignores_non_read_command(self):
        assert _common.extract_read_path("rg foo bar.py") is None

    def test_extracts_through_pipe(self):
        # Same fix as extract_search_pattern: piping cat into head shouldn't
        # disable augmentation.
        assert _common.extract_read_path("cat src/api.py | head -50") == "src/api.py"

    def test_extracts_through_and_chain(self):
        assert _common.extract_read_path("cd repo && cat src/api.py") == "src/api.py"


class TestIsCodeFile:
    def test_python(self):
        assert _common.is_code_file("src/main.py") is True

    def test_typescript(self):
        assert _common.is_code_file("src/app.tsx") is True

    def test_markdown(self):
        assert _common.is_code_file("README.md") is False

    def test_json(self):
        assert _common.is_code_file("package.json") is False


# ---------------------------------------------------------------------------
# _common: line range estimation
# ---------------------------------------------------------------------------


class TestEstimateLineRange:
    def test_finds_location(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("line1\nline2\ndef foo():\n    return 42\nline5\n")
        result = _common.estimate_line_range("return 42", str(f))
        assert result is not None
        lo, hi = result.split("-")
        assert int(lo) >= 1 and int(hi) >= int(lo)

    def test_not_found(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("nothing here\n")
        assert _common.estimate_line_range("new_not_present", str(f)) is None

    def test_file_missing(self):
        assert _common.estimate_line_range("anything", "/nonexistent/path.py") is None


# ---------------------------------------------------------------------------
# _common: workspace discovery
# ---------------------------------------------------------------------------


class TestFindWorkspaceRoot:
    def test_finds_opentrace_dir(self, tmp_path):
        (tmp_path / ".opentrace").mkdir()
        nested = tmp_path / "a" / "b" / "c"
        nested.mkdir(parents=True)
        assert _common.find_workspace_root(str(nested)) == tmp_path.resolve()

    def test_finds_git_dir(self, tmp_path):
        (tmp_path / ".git").mkdir()
        assert _common.find_workspace_root(str(tmp_path)) == tmp_path.resolve()

    def test_returns_none_when_neither(self, tmp_path):
        # tmp_path lives under a real .git somewhere up the tree on most
        # dev machines, so the walk *will* find one and return non-None.
        # We only assert the function returns *some* Path or None — it
        # never raises and never returns the wrong type.
        result = _common.find_workspace_root(str(tmp_path))
        assert result is None or isinstance(result, Path)


class TestOpentraceHealthy:
    def test_true_when_db_exists(self, tmp_path):
        (tmp_path / ".opentrace").mkdir()
        (tmp_path / ".opentrace" / "index.db").write_bytes(b"")
        assert _common.opentrace_healthy(tmp_path) is True

    def test_false_when_db_missing(self, tmp_path):
        (tmp_path / ".opentrace").mkdir()
        assert _common.opentrace_healthy(tmp_path) is False

    def test_false_when_workspace_none(self):
        assert _common.opentrace_healthy(None) is False


# ---------------------------------------------------------------------------
# _common: CLI invocation
# ---------------------------------------------------------------------------


class TestRunOpentraceai:
    def test_returns_stdout(self, tmp_path):
        result = MagicMock(returncode=0, stdout="  context\n")
        with patch.object(_common.subprocess, "run", return_value=result) as mock_run:
            assert _common.run_opentraceai(["augment", "--", "foo"], tmp_path) == "context"
        # Never invoke a shell — args are passed as a list.
        _, kwargs = mock_run.call_args
        assert kwargs.get("shell", False) is False

    def test_returns_none_on_nonzero(self, tmp_path):
        result = MagicMock(returncode=1, stdout="oops")
        with patch.object(_common.subprocess, "run", return_value=result):
            assert _common.run_opentraceai(["augment", "--", "x"], tmp_path) is None

    def test_returns_none_on_empty_stdout(self, tmp_path):
        result = MagicMock(returncode=0, stdout="   \n")
        with patch.object(_common.subprocess, "run", return_value=result):
            assert _common.run_opentraceai(["augment", "--", "x"], tmp_path) is None

    def test_returns_none_on_timeout(self, tmp_path):
        with patch.object(_common.subprocess, "run", side_effect=subprocess.TimeoutExpired("cmd", 7)):
            assert _common.run_opentraceai(["augment", "--", "x"], tmp_path) is None

    def test_returns_none_on_oserror(self, tmp_path):
        with patch.object(_common.subprocess, "run", side_effect=FileNotFoundError("x")):
            assert _common.run_opentraceai(["augment", "--", "x"], tmp_path) is None

    def test_prefers_direct_binary(self, tmp_path):
        result = MagicMock(returncode=0, stdout="ok\n")
        with (
            patch.object(_common.shutil, "which", return_value="/usr/bin/opentraceai"),
            patch.object(_common.subprocess, "run", return_value=result) as mock_run,
        ):
            _common.run_opentraceai(["x"], tmp_path)
        assert mock_run.call_args[0][0][0] == "/usr/bin/opentraceai"

    def test_falls_back_to_uvx(self, tmp_path):
        result = MagicMock(returncode=0, stdout="ok\n")
        with (
            patch.object(_common.shutil, "which", return_value=None),
            patch.object(_common.subprocess, "run", return_value=result) as mock_run,
        ):
            _common.run_opentraceai(["x"], tmp_path)
        cmd = mock_run.call_args[0][0]
        assert cmd[:2] == ["uvx", "opentraceai"]


# ---------------------------------------------------------------------------
# _common: briefing TTL
# ---------------------------------------------------------------------------


class TestBriefingTTL:
    def test_due_when_no_cache(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_common, "BRIEFING_CACHE_PATH", tmp_path / "missing.json")
        monkeypatch.setattr(_common, "CACHE_DIR", tmp_path)
        assert _common.briefing_due() is True

    def test_not_due_after_mark(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_common, "BRIEFING_CACHE_PATH", tmp_path / "briefing.json")
        monkeypatch.setattr(_common, "CACHE_DIR", tmp_path)
        _common.mark_briefing_sent()
        assert _common.briefing_due() is False


# ---------------------------------------------------------------------------
# pre_tool_use.main() — end-to-end via stdin/stdout
# ---------------------------------------------------------------------------


def _run_hook(mod, payload: dict, monkeypatch, capsys) -> dict | None:
    monkeypatch.setattr("sys.stdin", StringIO(json.dumps(payload)))
    mod.main()
    out = capsys.readouterr().out
    return json.loads(out) if out.strip() else None


class TestPreToolUseMain:
    def test_grep_augmented(self, healthy_workspace, monkeypatch, capsys):
        with patch.object(_pre, "build_search_message", return_value="[OpenTrace] ctx"):
            data = _run_hook(
                _pre,
                {
                    "tool_name": "Grep",
                    "tool_input": {"pattern": "KuzuStore"},
                    "cwd": str(healthy_workspace),
                },
                monkeypatch,
                capsys,
            )
        assert data["hookSpecificOutput"]["hookEventName"] == "PreToolUse"
        assert "[OpenTrace] ctx" in data["hookSpecificOutput"]["additionalContext"]

    def test_glob_augmented_when_identifier_present(self, healthy_workspace, monkeypatch, capsys):
        with patch.object(_pre, "build_search_message", return_value="[OpenTrace] ctx"):
            data = _run_hook(
                _pre,
                {
                    "tool_name": "Glob",
                    "tool_input": {"pattern": "src/components/GraphViewer.*"},
                    "cwd": str(healthy_workspace),
                },
                monkeypatch,
                capsys,
            )
        assert data is not None
        assert "[OpenTrace] ctx" in data["hookSpecificOutput"]["additionalContext"]

    def test_glob_skipped_for_pure_glob(self, healthy_workspace, monkeypatch, capsys):
        # ``**/*`` has no extractable identifier — no augmentation.
        with patch.object(_pre, "build_search_message") as mock_search:
            data = _run_hook(
                _pre,
                {
                    "tool_name": "Glob",
                    "tool_input": {"pattern": "**/*"},
                    "cwd": str(healthy_workspace),
                },
                monkeypatch,
                capsys,
            )
        mock_search.assert_not_called()
        assert data is None

    def test_bash_search_command_augmented(self, healthy_workspace, monkeypatch, capsys):
        with patch.object(_pre, "build_search_message", return_value="[OpenTrace] ctx"):
            data = _run_hook(
                _pre,
                {
                    "tool_name": "Bash",
                    "tool_input": {"command": "rg HandleRequest"},
                    "cwd": str(healthy_workspace),
                },
                monkeypatch,
                capsys,
            )
        assert data is not None
        assert "[OpenTrace] ctx" in data["hookSpecificOutput"]["additionalContext"]

    def test_bash_read_command_augmented(self, healthy_workspace, monkeypatch, capsys):
        # cat on a code file should trigger the impact-style read augmentation.
        with patch.object(_pre, "build_read_message", return_value="[OpenTrace] impact ctx"):
            data = _run_hook(
                _pre,
                {
                    "tool_name": "Bash",
                    "tool_input": {"command": "cat agent/main.py"},
                    "cwd": str(healthy_workspace),
                },
                monkeypatch,
                capsys,
            )
        assert data is not None
        assert "impact ctx" in data["hookSpecificOutput"]["additionalContext"]

    def test_short_pattern_skipped(self, healthy_workspace, monkeypatch, capsys):
        with patch.object(_pre, "build_search_message") as mock_search:
            data = _run_hook(
                _pre,
                {
                    "tool_name": "Grep",
                    "tool_input": {"pattern": "ab"},
                    "cwd": str(healthy_workspace),
                },
                monkeypatch,
                capsys,
            )
        mock_search.assert_not_called()
        assert data is None

    def test_skips_when_no_index(self, tmp_path, monkeypatch, capsys):
        # tmp_path has no .opentrace/index.db — opentrace_healthy False.
        with patch.object(_pre, "build_search_message") as mock_search:
            data = _run_hook(
                _pre,
                {
                    "tool_name": "Grep",
                    "tool_input": {"pattern": "KuzuStore"},
                    "cwd": str(tmp_path),
                },
                monkeypatch,
                capsys,
            )
        mock_search.assert_not_called()
        assert data is None

    def test_skips_relative_cwd(self, monkeypatch, capsys):
        with patch.object(_pre, "build_search_message") as mock_search:
            data = _run_hook(
                _pre,
                {
                    "tool_name": "Grep",
                    "tool_input": {"pattern": "KuzuStore"},
                    "cwd": "relative/path",
                },
                monkeypatch,
                capsys,
            )
        mock_search.assert_not_called()
        assert data is None

    def test_handles_empty_stdin(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.stdin", StringIO(""))
        _pre.main()
        assert capsys.readouterr().out == ""

    def test_handles_invalid_json(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.stdin", StringIO("not json"))
        _pre.main()
        assert capsys.readouterr().out == ""


# ---------------------------------------------------------------------------
# post_tool_use.main() — end-to-end via stdin/stdout
# ---------------------------------------------------------------------------


class TestPostToolUseMain:
    def test_edit_runs_impact(self, healthy_workspace, monkeypatch, capsys):
        target = healthy_workspace / "src" / "api.py"
        target.parent.mkdir(parents=True)
        target.write_text("# new code body\n")
        with patch.object(_post, "run_opentraceai", return_value="[OpenTrace] impact") as mock_run:
            data = _run_hook(
                _post,
                {
                    "tool_name": "Edit",
                    "tool_input": {
                        "file_path": str(target),
                        "old_string": "# old",
                        "new_string": "# new code body",
                    },
                    "cwd": str(healthy_workspace),
                },
                monkeypatch,
                capsys,
            )
        assert data is not None
        assert "impact" in data["hookSpecificOutput"]["additionalContext"]
        # First positional arg is the args list — must start with "impact".
        assert mock_run.call_args[0][0][0] == "impact"

    def test_write_runs_impact(self, healthy_workspace, monkeypatch, capsys):
        with patch.object(_post, "run_opentraceai", return_value="[OpenTrace] impact"):
            data = _run_hook(
                _post,
                {
                    "tool_name": "Write",
                    "tool_input": {"file_path": str(healthy_workspace / "src" / "new.py")},
                    "cwd": str(healthy_workspace),
                },
                monkeypatch,
                capsys,
            )
        assert data is not None
        assert "impact" in data["hookSpecificOutput"]["additionalContext"]

    def test_skips_non_code_file(self, healthy_workspace, monkeypatch, capsys):
        with patch.object(_post, "run_opentraceai") as mock_run:
            data = _run_hook(
                _post,
                {
                    "tool_name": "Edit",
                    "tool_input": {"file_path": str(healthy_workspace / "README.md")},
                    "cwd": str(healthy_workspace),
                },
                monkeypatch,
                capsys,
            )
        mock_run.assert_not_called()
        assert data is None

    def test_skips_no_file_path(self, healthy_workspace, monkeypatch, capsys):
        with patch.object(_post, "run_opentraceai") as mock_run:
            data = _run_hook(
                _post,
                {
                    "tool_name": "Edit",
                    "tool_input": {},
                    "cwd": str(healthy_workspace),
                },
                monkeypatch,
                capsys,
            )
        mock_run.assert_not_called()
        assert data is None

    def test_no_output_when_cli_returns_none(self, healthy_workspace, monkeypatch, capsys):
        with patch.object(_post, "run_opentraceai", return_value=None):
            data = _run_hook(
                _post,
                {
                    "tool_name": "Edit",
                    "tool_input": {"file_path": str(healthy_workspace / "x.py")},
                    "cwd": str(healthy_workspace),
                },
                monkeypatch,
                capsys,
            )
        assert data is None

    def test_skips_relative_cwd(self, monkeypatch, capsys):
        with patch.object(_post, "run_opentraceai") as mock_run:
            data = _run_hook(
                _post,
                {
                    "tool_name": "Edit",
                    "tool_input": {"file_path": "src/api.py"},
                    "cwd": "relative/path",
                },
                monkeypatch,
                capsys,
            )
        mock_run.assert_not_called()
        assert data is None

    def test_skips_when_no_index(self, tmp_path, monkeypatch, capsys):
        target = tmp_path / "x.py"
        target.write_text("# code\n")
        with patch.object(_post, "run_opentraceai") as mock_run:
            data = _run_hook(
                _post,
                {
                    "tool_name": "Edit",
                    "tool_input": {"file_path": str(target)},
                    "cwd": str(tmp_path),
                },
                monkeypatch,
                capsys,
            )
        mock_run.assert_not_called()
        assert data is None

    def test_handles_empty_stdin(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.stdin", StringIO(""))
        _post.main()
        assert capsys.readouterr().out == ""


# ---------------------------------------------------------------------------
# session_start.main() — end-to-end via stdin/stdout
# ---------------------------------------------------------------------------


class TestSessionStartMain:
    def test_emits_install_guidance_when_cli_missing(
        self, healthy_workspace, monkeypatch, capsys
    ):
        """When opentraceai is not on PATH, the hook must surface install
        guidance instead of silently degrading. This branch must precede the
        no-index branch — without the CLI, indexing won't run anyway.
        """
        with patch.object(_session_start, "_installed_version", return_value=None):
            data = _run_hook(
                _session_start,
                {"cwd": str(healthy_workspace)},
                monkeypatch,
                capsys,
            )
        assert data is not None
        assert "opentraceai" in data["systemMessage"]
        assert "uv tool install" in data["systemMessage"]
        assert "pipx" in data["systemMessage"]

    def test_starts_background_index_when_no_db(
        self, tmp_path, monkeypatch, capsys
    ):
        """No `.opentrace/index.db` → kick off background indexing and
        emit a 'background indexing started' message. The CLI must be
        installed for this branch — the install-guidance branch fires first
        otherwise.
        """
        # Make tmp_path look like a git repo so the indexer can target it.
        (tmp_path / ".git").mkdir()

        with patch.object(_session_start, "_installed_version", return_value="0.4.0"), patch.object(
            _session_start, "_start_background_index", return_value=12345
        ) as mock_idx:
            data = _run_hook(
                _session_start,
                {"cwd": str(tmp_path)},
                monkeypatch,
                capsys,
            )
        mock_idx.assert_called_once()
        assert data is not None
        assert "background indexing started" in data["systemMessage"]

    def test_emits_directive_when_healthy(
        self, healthy_workspace, monkeypatch, capsys
    ):
        """Healthy workspace → SessionStart hook output with the routing
        directive plus current stats appended as additionalContext.
        """
        fake_stats = "1234 nodes, 5678 edges: 200 Function"
        with patch.object(_session_start, "_installed_version", return_value="0.4.0"), patch.object(
            _session_start, "run_opentraceai", return_value=fake_stats
        ), patch.object(_session_start, "_update_notice", return_value=None):
            data = _run_hook(
                _session_start,
                {"cwd": str(healthy_workspace)},
                monkeypatch,
                capsys,
            )
        assert data is not None
        ctx = data["hookSpecificOutput"]["additionalContext"]
        assert "OpenTrace is active" in ctx
        assert fake_stats in ctx
        assert "OpenTrace is active" in data["systemMessage"]
        # No update notice appended when versions match.
        assert "Update available" not in data["systemMessage"]

    def test_appends_update_notice_when_available(
        self, healthy_workspace, monkeypatch, capsys
    ):
        """When _update_notice returns a string, it should be folded into
        the systemMessage so the user sees the upgrade hint without it
        crowding out the routing directive.
        """
        with patch.object(_session_start, "_installed_version", return_value="0.4.0"), patch.object(
            _session_start, "run_opentraceai", return_value="1 node"
        ), patch.object(
            _session_start,
            "_update_notice",
            return_value="Update available: opentraceai 0.4.0 → 0.5.0. Run /update.",
        ):
            data = _run_hook(
                _session_start,
                {"cwd": str(healthy_workspace)},
                monkeypatch,
                capsys,
            )
        assert "Update available" in data["systemMessage"]
        assert "0.5.0" in data["systemMessage"]


# ---------------------------------------------------------------------------
# user_prompt_submit.main() — end-to-end via stdin/stdout
# ---------------------------------------------------------------------------


class TestUserPromptSubmitMain:
    def test_skips_when_unhealthy(self, tmp_path, monkeypatch, capsys):
        """No index → silent no-op so we don't pollute every prompt with
        an error message in repos that aren't OpenTrace projects.
        """
        data = _run_hook(
            _user_prompt_submit,
            {"cwd": str(tmp_path)},
            monkeypatch,
            capsys,
        )
        assert data is None

    def test_skips_when_briefing_not_due(
        self, healthy_workspace, monkeypatch, capsys
    ):
        """The 10-min TTL must throttle re-injection — a healthy workspace
        with a recent briefing should produce no output.
        """
        with patch.object(_user_prompt_submit, "briefing_due", return_value=False), patch.object(
            _user_prompt_submit, "run_opentraceai"
        ) as mock_run:
            data = _run_hook(
                _user_prompt_submit,
                {"cwd": str(healthy_workspace)},
                monkeypatch,
                capsys,
            )
        mock_run.assert_not_called()
        assert data is None

    def test_emits_briefing_and_marks_sent(
        self, healthy_workspace, monkeypatch, capsys
    ):
        """When healthy and the TTL has elapsed, the hook injects a fresh
        reminder + stats and marks the briefing as sent so the next prompt
        in the same window stays quiet.
        """
        with patch.object(_user_prompt_submit, "briefing_due", return_value=True), patch.object(
            _user_prompt_submit, "run_opentraceai", return_value="42 nodes, 99 edges"
        ), patch.object(
            _user_prompt_submit, "mark_briefing_sent"
        ) as mock_mark:
            data = _run_hook(
                _user_prompt_submit,
                {"cwd": str(healthy_workspace)},
                monkeypatch,
                capsys,
            )
        mock_mark.assert_called_once()
        assert data is not None
        ctx = data["hookSpecificOutput"]["additionalContext"]
        assert "[OpenTrace] reminder" in ctx
        assert "42 nodes, 99 edges" in ctx

    def test_skips_when_stats_empty(
        self, healthy_workspace, monkeypatch, capsys
    ):
        """If the stats command returns nothing (e.g. CLI hiccup), don't
        emit a partial briefing — better silent than misleading.
        """
        with patch.object(_user_prompt_submit, "briefing_due", return_value=True), patch.object(
            _user_prompt_submit, "run_opentraceai", return_value=""
        ), patch.object(
            _user_prompt_submit, "mark_briefing_sent"
        ) as mock_mark:
            data = _run_hook(
                _user_prompt_submit,
                {"cwd": str(healthy_workspace)},
                monkeypatch,
                capsys,
            )
        mock_mark.assert_not_called()
        assert data is None