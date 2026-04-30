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

"""Tests for the edit-hook.py script (PostToolUse on Edit/Write)."""

from __future__ import annotations

import importlib.util
import json
import sys
from io import StringIO
from pathlib import Path
from unittest.mock import patch

# ---------------------------------------------------------------------------
# Import the hook module via importlib (it's not a package)
# ---------------------------------------------------------------------------

_SCRIPTS_DIR = Path(__file__).resolve().parents[4] / "plugins" / "claude-code" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))  # _debug must be importable
_HOOK_PATH = _SCRIPTS_DIR / "edit-hook.py"
_spec = importlib.util.spec_from_file_location("edit_hook", _HOOK_PATH)
_hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hook)

handle_post_tool_use = _hook.handle_post_tool_use
main = _hook.main
_is_code_file = _hook._is_code_file
_estimate_line_range = _hook._estimate_line_range


# -- _is_code_file -----------------------------------------------------------


def test_is_code_file_python():
    assert _is_code_file("src/main.py") is True


def test_is_code_file_typescript():
    assert _is_code_file("src/app.tsx") is True


def test_is_code_file_markdown():
    assert _is_code_file("README.md") is False


def test_is_code_file_json():
    assert _is_code_file("package.json") is False


# -- _estimate_line_range ----------------------------------------------------


def test_estimate_line_range_finds_location(tmp_path):
    f = tmp_path / "test.py"
    f.write_text("line1\nline2\ndef foo():\n    return 42\nline5\n")
    result = _estimate_line_range("return 41", "return 42", str(f))
    assert result is not None
    # Should contain the line where "return 42" appears
    lo, hi = result.split("-")
    assert int(lo) >= 1
    assert int(hi) >= int(lo)


def test_estimate_line_range_not_found(tmp_path):
    f = tmp_path / "test.py"
    f.write_text("nothing here\n")
    result = _estimate_line_range("old", "new_not_present", str(f))
    assert result is None


def test_estimate_line_range_file_missing():
    result = _estimate_line_range("old", "new", "/nonexistent/path.py")
    assert result is None


# -- handle_post_tool_use ----------------------------------------------------


def test_handle_post_tool_use_edit(capsys, tmp_path):
    """Should call impact CLI for an Edit on a code file."""
    payload = {
        "hook_event_name": "PostToolUse",
        "tool_name": "Edit",
        "tool_input": {
            "file_path": str(tmp_path / "src" / "api.py"),
            "old_string": "old code",
            "new_string": "new code",
        },
        "cwd": str(tmp_path),
    }
    with patch.object(_hook, "run_opentraceai", return_value="[OpenTrace] Impact analysis") as mock_run:
        handle_post_tool_use(payload)

    out = capsys.readouterr().out
    data = json.loads(out)
    assert "Impact analysis" in data["hookSpecificOutput"]["additionalContext"]
    # Should have called impact subcommand
    args = mock_run.call_args[0][0]
    assert args[0] == "impact"


def test_handle_post_tool_use_write(capsys, tmp_path):
    """Should call impact CLI for a Write on a code file."""
    payload = {
        "hook_event_name": "PostToolUse",
        "tool_name": "Write",
        "tool_input": {
            "file_path": str(tmp_path / "src" / "new_module.py"),
        },
        "cwd": str(tmp_path),
    }
    with patch.object(_hook, "run_opentraceai", return_value="[OpenTrace] Impact analysis"):
        handle_post_tool_use(payload)

    out = capsys.readouterr().out
    data = json.loads(out)
    assert "Impact analysis" in data["hookSpecificOutput"]["additionalContext"]


def test_handle_post_tool_use_skips_non_code(capsys, tmp_path):
    """Should skip non-code files like markdown."""
    payload = {
        "hook_event_name": "PostToolUse",
        "tool_name": "Edit",
        "tool_input": {"file_path": str(tmp_path / "README.md")},
        "cwd": str(tmp_path),
    }
    with patch.object(_hook, "run_opentraceai") as mock_run:
        handle_post_tool_use(payload)

    mock_run.assert_not_called()
    assert capsys.readouterr().out == ""


def test_handle_post_tool_use_skips_no_file_path(capsys, tmp_path):
    """Should skip when file_path is missing."""
    payload = {
        "hook_event_name": "PostToolUse",
        "tool_name": "Edit",
        "tool_input": {},
        "cwd": str(tmp_path),
    }
    with patch.object(_hook, "run_opentraceai") as mock_run:
        handle_post_tool_use(payload)

    mock_run.assert_not_called()


def test_handle_post_tool_use_no_output_when_cli_returns_none(capsys, tmp_path):
    """Should produce no output when CLI returns nothing."""
    payload = {
        "hook_event_name": "PostToolUse",
        "tool_name": "Edit",
        "tool_input": {"file_path": str(tmp_path / "foo.py")},
        "cwd": str(tmp_path),
    }
    with patch.object(_hook, "run_opentraceai", return_value=None):
        handle_post_tool_use(payload)

    assert capsys.readouterr().out == ""


def test_handle_post_tool_use_skips_relative_cwd(capsys):
    """Should skip when cwd is not absolute."""
    payload = {
        "hook_event_name": "PostToolUse",
        "tool_name": "Edit",
        "tool_input": {"file_path": "src/api.py"},
        "cwd": "relative/path",
    }
    with patch.object(_hook, "run_opentraceai") as mock_run:
        handle_post_tool_use(payload)

    mock_run.assert_not_called()


# -- main (end-to-end) -------------------------------------------------------


def test_main_dispatches_post_tool_use(capsys, monkeypatch, tmp_path):
    """Should dispatch PostToolUse events to handle_post_tool_use."""
    payload = json.dumps(
        {
            "hook_event_name": "PostToolUse",
            "tool_name": "Edit",
            "tool_input": {"file_path": str(tmp_path / "src" / "api.py")},
            "cwd": str(tmp_path),
        }
    )
    monkeypatch.setattr("sys.stdin", StringIO(payload))

    with patch.object(_hook, "run_opentraceai", return_value="impact context"):
        main()

    out = capsys.readouterr().out
    assert "impact context" in out


def test_main_ignores_unknown_events(capsys, monkeypatch):
    """Should produce no output for unknown event types."""
    payload = json.dumps({"hook_event_name": "SomeOtherEvent"})
    monkeypatch.setattr("sys.stdin", StringIO(payload))
    main()
    assert capsys.readouterr().out == ""


def test_main_handles_empty_stdin(capsys, monkeypatch):
    monkeypatch.setattr("sys.stdin", StringIO(""))
    main()
    assert capsys.readouterr().out == ""


def test_main_handles_invalid_json(capsys, monkeypatch):
    monkeypatch.setattr("sys.stdin", StringIO("not json"))
    main()
    assert capsys.readouterr().out == ""
