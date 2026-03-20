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

"""Tests for the opentrace-hook.py script (excluding extract_pattern, tested separately)."""

from __future__ import annotations

import importlib.util
import json
import subprocess
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Import the hook module via importlib (it's not a package)
# ---------------------------------------------------------------------------

_HOOK_PATH = Path(__file__).resolve().parents[4] / "claude-code-plugin" / "scripts" / "opentrace-hook.py"
_spec = importlib.util.spec_from_file_location("opentrace_hook", _HOOK_PATH)
_hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hook)

run_opentraceai = _hook.run_opentraceai
send_hook_response = _hook.send_hook_response
handle_pre_tool_use = _hook.handle_pre_tool_use
main = _hook.main


# -- run_opentraceai ---------------------------------------------------------


def test_run_opentraceai_returns_stdout(tmp_path):
    """Should return stdout when the CLI exits 0."""
    mock_result = MagicMock(returncode=0, stdout="  some context\n")
    with patch.object(_hook.subprocess, "run", return_value=mock_result) as mock_run:
        result = run_opentraceai(["augment", "--", "foo"], str(tmp_path))

    assert result == "some context"
    mock_run.assert_called_once()
    # Verify shell=True is NOT used
    _, kwargs = mock_run.call_args
    assert "shell" not in kwargs or kwargs["shell"] is False


def test_run_opentraceai_returns_none_on_nonzero_exit(tmp_path):
    """Should return None when the CLI exits non-zero."""
    mock_result = MagicMock(returncode=1, stdout="error output")
    with patch.object(_hook.subprocess, "run", return_value=mock_result):
        assert run_opentraceai(["augment", "--", "foo"], str(tmp_path)) is None


def test_run_opentraceai_returns_none_on_empty_stdout(tmp_path):
    """Should return None when stdout is empty."""
    mock_result = MagicMock(returncode=0, stdout="   \n")
    with patch.object(_hook.subprocess, "run", return_value=mock_result):
        assert run_opentraceai(["augment", "--", "foo"], str(tmp_path)) is None


def test_run_opentraceai_returns_none_on_timeout(tmp_path):
    """Should return None on timeout, not raise."""
    with patch.object(_hook.subprocess, "run", side_effect=subprocess.TimeoutExpired("cmd", 7)):
        assert run_opentraceai(["augment", "--", "foo"], str(tmp_path)) is None


def test_run_opentraceai_returns_none_on_exception(tmp_path):
    """Should return None on any exception, not raise."""
    with patch.object(_hook.subprocess, "run", side_effect=FileNotFoundError("no such file")):
        assert run_opentraceai(["augment", "--", "foo"], str(tmp_path)) is None


def test_run_opentraceai_prefers_which(tmp_path):
    """Should use shutil.which result when available."""
    mock_result = MagicMock(returncode=0, stdout="context\n")
    with (
        patch.object(_hook.shutil, "which", return_value="/usr/bin/opentraceai"),
        patch.object(_hook.subprocess, "run", return_value=mock_result) as mock_run,
    ):
        run_opentraceai(["augment", "--", "foo"], str(tmp_path))

    cmd = mock_run.call_args[0][0]
    assert cmd[0] == "/usr/bin/opentraceai"


def test_run_opentraceai_falls_back_to_uvx(tmp_path):
    """Should fall back to uvx when opentraceai is not on PATH."""
    mock_result = MagicMock(returncode=0, stdout="context\n")
    with (
        patch.object(_hook.shutil, "which", return_value=None),
        patch.object(_hook.subprocess, "run", return_value=mock_result) as mock_run,
    ):
        run_opentraceai(["augment", "--", "foo"], str(tmp_path))

    cmd = mock_run.call_args[0][0]
    assert cmd[0] == "uvx"
    assert cmd[1] == "opentraceai"


# -- send_hook_response ------------------------------------------------------


def test_send_hook_response(capsys):
    """Should write valid JSON with the correct structure."""
    send_hook_response("PreToolUse", "graph context here")
    out = capsys.readouterr().out
    data = json.loads(out)
    assert data == {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": "graph context here",
        }
    }


# -- handle_pre_tool_use -----------------------------------------------------


def test_handle_pre_tool_use_augments_grep(capsys, tmp_path):
    """Should call augment and emit response for a Grep with a valid pattern."""
    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": "Grep",
        "tool_input": {"pattern": "KuzuStore"},
        "cwd": str(tmp_path),
    }
    with patch.object(_hook, "run_opentraceai", return_value="[OpenTrace] Graph context"):
        handle_pre_tool_use(payload)

    out = capsys.readouterr().out
    data = json.loads(out)
    assert data["hookSpecificOutput"]["hookEventName"] == "PreToolUse"
    assert "Graph context" in data["hookSpecificOutput"]["additionalContext"]


def test_handle_pre_tool_use_no_output_when_cli_returns_none(capsys, tmp_path):
    """Should produce no output when the CLI returns nothing."""
    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": "Grep",
        "tool_input": {"pattern": "KuzuStore"},
        "cwd": str(tmp_path),
    }
    with patch.object(_hook, "run_opentraceai", return_value=None):
        handle_pre_tool_use(payload)

    assert capsys.readouterr().out == ""


def test_handle_pre_tool_use_skips_short_pattern(capsys, tmp_path):
    """Should skip patterns shorter than 3 characters."""
    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": "Grep",
        "tool_input": {"pattern": "ab"},
        "cwd": str(tmp_path),
    }
    with patch.object(_hook, "run_opentraceai") as mock_run:
        handle_pre_tool_use(payload)

    mock_run.assert_not_called()
    assert capsys.readouterr().out == ""


def test_handle_pre_tool_use_skips_relative_cwd(capsys):
    """Should skip when cwd is not absolute."""
    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": "Grep",
        "tool_input": {"pattern": "KuzuStore"},
        "cwd": "relative/path",
    }
    with patch.object(_hook, "run_opentraceai") as mock_run:
        handle_pre_tool_use(payload)

    mock_run.assert_not_called()


def test_handle_pre_tool_use_skips_missing_cwd(capsys):
    """Should skip when cwd is empty."""
    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": "Grep",
        "tool_input": {"pattern": "KuzuStore"},
        "cwd": "",
    }
    with patch.object(_hook, "run_opentraceai") as mock_run:
        handle_pre_tool_use(payload)

    mock_run.assert_not_called()


def test_handle_pre_tool_use_never_raises(capsys, tmp_path):
    """Should swallow exceptions and produce no output."""
    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": "Grep",
        "tool_input": {"pattern": "KuzuStore"},
        "cwd": str(tmp_path),
    }
    with patch.object(_hook, "run_opentraceai", side_effect=RuntimeError("boom")):
        handle_pre_tool_use(payload)  # should not raise

    assert capsys.readouterr().out == ""


def test_handle_pre_tool_use_passes_pattern_to_cli(tmp_path):
    """Should pass the extracted pattern to opentraceai augment."""
    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": "Grep",
        "tool_input": {"pattern": "MyClassName"},
        "cwd": str(tmp_path),
    }
    with patch.object(_hook, "run_opentraceai", return_value=None) as mock_run:
        handle_pre_tool_use(payload)

    mock_run.assert_called_once_with(["augment", "--", "MyClassName"], cwd=str(tmp_path))


# -- main (end-to-end) -------------------------------------------------------


def test_main_dispatches_pre_tool_use(capsys, monkeypatch, tmp_path):
    """Should dispatch PreToolUse events to handle_pre_tool_use."""
    payload = json.dumps(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "Grep",
            "tool_input": {"pattern": "KuzuStore"},
            "cwd": str(tmp_path),
        }
    )
    monkeypatch.setattr("sys.stdin", StringIO(payload))

    with patch.object(_hook, "run_opentraceai", return_value="context"):
        main()

    out = capsys.readouterr().out
    assert "context" in out


def test_main_ignores_unknown_events(capsys, monkeypatch):
    """Should produce no output for unknown event types."""
    payload = json.dumps({"hook_event_name": "SomeOtherEvent"})
    monkeypatch.setattr("sys.stdin", StringIO(payload))
    main()
    assert capsys.readouterr().out == ""


def test_main_handles_empty_stdin(capsys, monkeypatch):
    """Should produce no output for empty stdin."""
    monkeypatch.setattr("sys.stdin", StringIO(""))
    main()
    assert capsys.readouterr().out == ""


def test_main_handles_invalid_json(capsys, monkeypatch):
    """Should produce no output for invalid JSON."""
    monkeypatch.setattr("sys.stdin", StringIO("not json"))
    main()
    assert capsys.readouterr().out == ""
