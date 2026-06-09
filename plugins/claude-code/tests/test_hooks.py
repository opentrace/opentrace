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

"""Hook-level tests: drive each hook script the way Claude Code does
(JSON event on stdin, capture stdout) and verify the observable
behavior. Also covers the end-to-end staleness flow
(PostToolUse → UserPromptSubmit warns → re-index → silent → Stop silent).
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = PLUGIN_ROOT / "scripts"


def _touch_newer(path: Path, base_mtime: float, delta: float = 5.0) -> float:
    new_mtime = base_mtime + delta
    os.utime(path, (new_mtime, new_mtime))
    return new_mtime


def _run_hook_in_process(script_module: str, event: dict, monkeypatch):
    """Invoke a hook's ``main()`` in-process with a synthetic stdin.

    Reload the module so it picks up the current $TMPDIR (set by the
    ``tmp_cache`` fixture) and any monkeypatches the test has installed.
    Returns ``(stdout, stderr)`` strings.
    """
    raw = json.dumps(event)
    monkeypatch.setattr(sys, "stdin", io.StringIO(raw))
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out_buf)
    monkeypatch.setattr(sys, "stderr", err_buf)

    import importlib
    if script_module in sys.modules:
        mod = importlib.reload(sys.modules[script_module])
    else:
        mod = importlib.import_module(script_module)
    mod.main()
    return out_buf.getvalue(), err_buf.getvalue()


def _run_hook_subprocess(script_name: str, event: dict, env: dict | None = None):
    """Run a hook script in a subprocess (matches the real hook contract).

    Slower than in-process but guarantees the script is wired up exactly
    the way Claude Code invokes it (own interpreter, own argv, real stdin
    pipe). Returns a ``CompletedProcess``.
    """
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    return subprocess.run(
        ["python3", str(SCRIPTS_DIR / script_name)],
        input=json.dumps(event),
        capture_output=True,
        text=True,
        env=full_env,
        timeout=10,
    )


# ---------------------------------------------------------------------------
# stop.py
# ---------------------------------------------------------------------------

def test_stop_silent_when_no_stale_files(tmp_cache, tmp_workspace, monkeypatch):
    out, _err = _run_hook_in_process("stop", {"cwd": str(tmp_workspace)}, monkeypatch)
    assert out == ""


def test_stop_emits_summary_when_files_are_stale(tmp_cache, tmp_workspace, monkeypatch):
    edited = tmp_workspace / "a.py"
    edited.write_text("x = 1\n")
    db_mtime = (tmp_workspace / ".opentrace" / "index.db").stat().st_mtime
    _touch_newer(edited, db_mtime)
    tmp_cache.record_edit(str(edited), tmp_workspace)

    out, _err = _run_hook_in_process("stop", {"cwd": str(tmp_workspace)}, monkeypatch)
    payload = json.loads(out)
    assert "systemMessage" in payload
    msg = payload["systemMessage"]
    assert "1 file" in msg
    assert "a.py" in msg
    assert "/index" in msg


def test_stop_prunes_old_entries_even_without_index(tmp_cache, tmp_path, monkeypatch):
    """Stop should still prune the cache even when the workspace has no DB.

    Otherwise a long-running machine accumulates entries from workspaces
    the user has stopped opening.
    """
    import time
    ws = tmp_path / "no-index-ws"
    ws.mkdir()
    edited = ws / "ghost.py"
    edited.write_text("x = 1\n")
    tmp_cache.record_edit(str(edited), ws)
    # Backdate.
    data = json.loads(tmp_cache.STALENESS_CACHE_PATH.read_text())
    for entry in data.values():
        entry["ts"] = time.time() - (tmp_cache.STALENESS_MAX_AGE_SECONDS + 1)
    tmp_cache.STALENESS_CACHE_PATH.write_text(json.dumps(data))

    _run_hook_in_process("stop", {"cwd": str(ws)}, monkeypatch)
    assert json.loads(tmp_cache.STALENESS_CACHE_PATH.read_text()) == {}


# ---------------------------------------------------------------------------
# pre_compact.py
# ---------------------------------------------------------------------------

def test_pre_compact_emits_directive(tmp_cache, tmp_workspace, monkeypatch, fake_run_opentraceai):
    fake_run_opentraceai.set("123 nodes, 456 edges")
    out, _err = _run_hook_in_process(
        "pre_compact", {"cwd": str(tmp_workspace)}, monkeypatch
    )
    payload = json.loads(out)
    assert payload["hookSpecificOutput"]["hookEventName"] == "PreCompact"
    ctx = payload["hookSpecificOutput"]["additionalContext"]
    assert "OpenTrace is active" in ctx
    assert "123 nodes, 456 edges" in ctx
    assert ".opentrace/index.db" in ctx


def test_pre_compact_silent_without_index(tmp_cache, tmp_path, monkeypatch):
    ws = tmp_path / "no-index"
    ws.mkdir()
    out, _err = _run_hook_in_process("pre_compact", {"cwd": str(ws)}, monkeypatch)
    assert out == ""


# ---------------------------------------------------------------------------
# notification.py
# ---------------------------------------------------------------------------

def test_notification_announces_then_stays_silent(
    tmp_cache, tmp_workspace, monkeypatch, fake_run_opentraceai
):
    fake_run_opentraceai.set("1500 nodes, 3000 edges")
    # First fire: no sentinel yet, should announce.
    out1, _err1 = _run_hook_in_process(
        "notification", {"cwd": str(tmp_workspace)}, monkeypatch
    )
    assert "index updated" in json.loads(out1)["systemMessage"]
    assert "1500 nodes" in json.loads(out1)["systemMessage"]

    # Second fire with no DB change: silent.
    out2, _err2 = _run_hook_in_process(
        "notification", {"cwd": str(tmp_workspace)}, monkeypatch
    )
    assert out2 == ""


def test_notification_re_fires_on_newer_index(
    tmp_cache, tmp_workspace, monkeypatch, fake_run_opentraceai
):
    fake_run_opentraceai.set("1 nodes")
    _run_hook_in_process("notification", {"cwd": str(tmp_workspace)}, monkeypatch)

    # Bump the DB mtime → next fire should announce again.
    db = tmp_workspace / ".opentrace" / "index.db"
    _touch_newer(db, db.stat().st_mtime, delta=120.0)
    fake_run_opentraceai.set("2 nodes")
    out, _err = _run_hook_in_process(
        "notification", {"cwd": str(tmp_workspace)}, monkeypatch
    )
    assert "2 nodes" in json.loads(out)["systemMessage"]


def test_notification_silent_without_index(tmp_cache, tmp_path, monkeypatch):
    ws = tmp_path / "no-index"
    ws.mkdir()
    out, _err = _run_hook_in_process("notification", {"cwd": str(ws)}, monkeypatch)
    assert out == ""


# ---------------------------------------------------------------------------
# subagent_stop.py
# ---------------------------------------------------------------------------

def _write_transcript(path: Path, events: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for ev in events:
            fh.write(json.dumps(ev) + "\n")


def _subagent_event(tmp_path: Path, cwd, agent_type: str, agent_id: str = "abc123") -> dict:
    """Build a SubagentStop payload matching the documented shape:
    `transcript_path` is the PARENT transcript; the subagent's own
    transcript lives at `<dir>/<session>/subagents/agent-<id>.jsonl`.
    """
    parent = tmp_path / "session.jsonl"
    parent.touch()
    return {
        "cwd": str(cwd),
        "agent_type": agent_type,
        "agent_id": agent_id,
        "transcript_path": str(parent),
    }


def _subagent_transcript_path(tmp_path: Path, agent_id: str = "abc123") -> Path:
    return tmp_path / "session" / "subagents" / f"agent-{agent_id}.jsonl"


def test_subagent_stop_silent_for_non_opentrace_agent(
    tmp_cache, tmp_workspace, tmp_path, monkeypatch
):
    _write_transcript(_subagent_transcript_path(tmp_path), [])
    event = _subagent_event(tmp_path, tmp_workspace, "general-purpose")
    out, _err = _run_hook_in_process("subagent_stop", event, monkeypatch)
    assert out == ""


def test_subagent_stop_silent_when_graph_tool_used(
    tmp_cache, tmp_workspace, tmp_path, monkeypatch
):
    _write_transcript(
        _subagent_transcript_path(tmp_path),
        [
            {
                "message": {
                    "content": [
                        {"type": "text", "text": "looking at the graph"},
                        {
                            "type": "tool_use",
                            "name": "mcp__opentrace_oss__find_usages",
                            "input": {"symbol": "foo"},
                        },
                    ]
                }
            }
        ],
    )
    event = _subagent_event(tmp_path, tmp_workspace, "find-usages")
    out, _err = _run_hook_in_process("subagent_stop", event, monkeypatch)
    assert out == ""


def test_subagent_stop_warns_when_opentrace_agent_skips_graph(
    tmp_cache, tmp_workspace, tmp_path, monkeypatch
):
    _write_transcript(
        _subagent_transcript_path(tmp_path),
        [
            {
                "message": {
                    "content": [
                        {"type": "tool_use", "name": "Read", "input": {"path": "x"}},
                        {"type": "tool_use", "name": "Grep", "input": {"pattern": "y"}},
                    ]
                }
            }
        ],
    )
    event = _subagent_event(tmp_path, tmp_workspace, "dependency-analyzer")
    out, _err = _run_hook_in_process("subagent_stop", event, monkeypatch)
    payload = json.loads(out)
    assert "without calling any" in payload["systemMessage"]
    assert "@dependency-analyzer" in payload["systemMessage"]


def test_subagent_stop_strips_plugin_namespace(
    tmp_cache, tmp_workspace, tmp_path, monkeypatch
):
    """Plugin agents arrive namespaced, e.g. `opentrace-oss:explain-service`."""
    _write_transcript(_subagent_transcript_path(tmp_path), [])
    event = _subagent_event(tmp_path, tmp_workspace, "opentrace-oss:explain-service")
    out, _err = _run_hook_in_process("subagent_stop", event, monkeypatch)
    payload = json.loads(out)
    assert "@explain-service" in payload["systemMessage"]


def test_subagent_stop_does_not_scan_parent_transcript(
    tmp_cache, tmp_workspace, tmp_path, monkeypatch
):
    """Graph tool_use in the PARENT transcript must not mask a subagent
    that skipped the graph (transcript_path points at the parent)."""
    event = _subagent_event(tmp_path, tmp_workspace, "find-usages")
    _write_transcript(
        Path(event["transcript_path"]),
        [
            {
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "name": "mcp__opentrace_oss__keyword_search",
                            "input": {"query": "foo"},
                        }
                    ]
                }
            }
        ],
    )
    _write_transcript(
        _subagent_transcript_path(tmp_path),
        [
            {
                "message": {
                    "content": [
                        {"type": "tool_use", "name": "Grep", "input": {"pattern": "y"}}
                    ]
                }
            }
        ],
    )
    out, _err = _run_hook_in_process("subagent_stop", event, monkeypatch)
    payload = json.loads(out)
    assert "without calling any" in payload["systemMessage"]


def test_subagent_stop_handles_missing_transcript(tmp_cache, tmp_workspace, monkeypatch):
    out, _err = _run_hook_in_process(
        "subagent_stop",
        {"cwd": str(tmp_workspace), "agent_type": "find-usages", "agent_id": "zzz"},
        monkeypatch,
    )
    assert out == ""


# ---------------------------------------------------------------------------
# user_prompt_submit.py
# ---------------------------------------------------------------------------

def test_user_prompt_submit_silent_when_clean(tmp_cache, tmp_workspace, monkeypatch):
    out, _err = _run_hook_in_process(
        "user_prompt_submit", {"cwd": str(tmp_workspace)}, monkeypatch
    )
    assert out == ""


def test_user_prompt_submit_warns_on_stale_files(tmp_cache, tmp_workspace, monkeypatch):
    edited = tmp_workspace / "src" / "stale.py"
    edited.parent.mkdir(parents=True)
    edited.write_text("x = 1\n")
    db_mtime = (tmp_workspace / ".opentrace" / "index.db").stat().st_mtime
    _touch_newer(edited, db_mtime)
    tmp_cache.record_edit(str(edited), tmp_workspace)

    out, _err = _run_hook_in_process(
        "user_prompt_submit", {"cwd": str(tmp_workspace)}, monkeypatch
    )
    payload = json.loads(out)
    ctx = payload["hookSpecificOutput"]["additionalContext"]
    assert "Graph staleness" in ctx
    assert "src/stale.py" in ctx
    assert "opentrace-index" in ctx


def test_user_prompt_submit_throttles_repeated_warnings(
    tmp_cache, tmp_workspace, monkeypatch
):
    """Two warning-eligible prompts in quick succession should only emit once."""
    edited = tmp_workspace / "a.py"
    edited.write_text("x = 1\n")
    db_mtime = (tmp_workspace / ".opentrace" / "index.db").stat().st_mtime
    _touch_newer(edited, db_mtime)
    tmp_cache.record_edit(str(edited), tmp_workspace)

    out1, _ = _run_hook_in_process(
        "user_prompt_submit", {"cwd": str(tmp_workspace)}, monkeypatch
    )
    assert out1  # first fire emits
    out2, _ = _run_hook_in_process(
        "user_prompt_submit", {"cwd": str(tmp_workspace)}, monkeypatch
    )
    assert out2 == ""  # second fire throttled


# ---------------------------------------------------------------------------
# post_tool_use.py — records edits unconditionally
# ---------------------------------------------------------------------------

def test_post_tool_use_records_edit_path(tmp_cache, tmp_workspace, monkeypatch):
    edited = tmp_workspace / "src" / "x.py"
    edited.parent.mkdir(parents=True)
    edited.write_text("x = 1\n")
    db_mtime = (tmp_workspace / ".opentrace" / "index.db").stat().st_mtime
    _touch_newer(edited, db_mtime)

    _run_hook_in_process(
        "post_tool_use",
        {
            "cwd": str(tmp_workspace),
            "tool_name": "Edit",
            "tool_input": {
                "file_path": str(edited),
                "old_string": "x = 0",
                "new_string": "x = 1",
            },
        },
        monkeypatch,
    )
    assert str(edited) in tmp_cache.stale_files(tmp_workspace)


def test_post_tool_use_skips_non_code_files(tmp_cache, tmp_workspace, monkeypatch):
    """Markdown/text edits aren't tracked — only indexable code files are."""
    edited = tmp_workspace / "README.md"
    edited.write_text("hi\n")
    _run_hook_in_process(
        "post_tool_use",
        {
            "cwd": str(tmp_workspace),
            "tool_name": "Write",
            "tool_input": {"file_path": str(edited)},
        },
        monkeypatch,
    )
    assert tmp_cache.stale_files(tmp_workspace) == []


# ---------------------------------------------------------------------------
# End-to-end: PostToolUse → UserPromptSubmit warns → re-index → silent
# ---------------------------------------------------------------------------

def test_staleness_e2e_flow(tmp_cache, tmp_workspace, monkeypatch):
    db = tmp_workspace / ".opentrace" / "index.db"
    edited = tmp_workspace / "feature.py"
    edited.write_text("def feature(): pass\n")
    _touch_newer(edited, db.stat().st_mtime)

    # 1. Edit fires PostToolUse → staleness recorded.
    _run_hook_in_process(
        "post_tool_use",
        {
            "cwd": str(tmp_workspace),
            "tool_name": "Edit",
            "tool_input": {
                "file_path": str(edited),
                "old_string": "pass",
                "new_string": "return 42",
            },
        },
        monkeypatch,
    )
    assert tmp_cache.stale_files(tmp_workspace) == [str(edited)]

    # 2. Next prompt → UserPromptSubmit emits a warning.
    out, _ = _run_hook_in_process(
        "user_prompt_submit", {"cwd": str(tmp_workspace)}, monkeypatch
    )
    assert "Graph staleness" in out

    # 3. Re-index by bumping the DB mtime. Also clear the briefing cache
    #    so the throttle doesn't mask the silence we're checking for.
    _touch_newer(db, edited.stat().st_mtime, delta=60.0)
    if tmp_cache.BRIEFING_CACHE_PATH.exists():
        tmp_cache.BRIEFING_CACHE_PATH.unlink()

    # 4. Next prompt → silent (graph is fresher than the edit).
    out_after, _ = _run_hook_in_process(
        "user_prompt_submit", {"cwd": str(tmp_workspace)}, monkeypatch
    )
    assert out_after == ""

    # 5. End of session → Stop hook silent too.
    out_stop, _ = _run_hook_in_process(
        "stop", {"cwd": str(tmp_workspace)}, monkeypatch
    )
    assert out_stop == ""


# ---------------------------------------------------------------------------
# Subprocess smoke: each hook must exit cleanly on a minimal event even
# without an index. This is the real fail-closed contract.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "script",
    [
        "user_prompt_submit.py",
        "post_tool_use.py",
        "stop.py",
        "pre_compact.py",
        "subagent_stop.py",
        "notification.py",
    ],
)
def test_hook_subprocess_fails_closed_on_empty_event(script, tmp_path):
    result = _run_hook_subprocess(
        script, {}, env={"TMPDIR": str(tmp_path), "OPENTRACE_DEBUG": ""}
    )
    assert result.returncode == 0, (
        f"{script} exited {result.returncode}\n"
        f"stdout={result.stdout!r}\nstderr={result.stderr!r}"
    )


# ---------------------------------------------------------------------------
# session_start.py — git token detection for the private-repo auth nudge
# ---------------------------------------------------------------------------

def _import_session_start():
    import importlib
    if "session_start" in sys.modules:
        return importlib.reload(sys.modules["session_start"])
    return importlib.import_module("session_start")


@pytest.mark.parametrize(
    "var", ["OPENTRACE_GIT_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN"]
)
def test_git_token_available_via_env(var, tmp_path, monkeypatch):
    ss = _import_session_start()
    for v in ("OPENTRACE_GIT_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setenv(var, "tok")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    assert ss._git_token_available() is True


def test_git_token_available_via_stored_file(tmp_path, monkeypatch):
    ss = _import_session_start()
    for v in ("OPENTRACE_GIT_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    ot = tmp_path / ".opentrace"
    ot.mkdir()
    (ot / "git_tokens.json").write_bytes(b"encrypted-blob")
    assert ss._git_token_available() is True


def test_git_token_unavailable_when_nothing_set(tmp_path, monkeypatch):
    ss = _import_session_start()
    for v in ("OPENTRACE_GIT_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    assert ss._git_token_available() is False


def test_git_token_unavailable_when_file_empty(tmp_path, monkeypatch):
    ss = _import_session_start()
    for v in ("OPENTRACE_GIT_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    ot = tmp_path / ".opentrace"
    ot.mkdir()
    (ot / "git_tokens.json").write_bytes(b"")
    assert ss._git_token_available() is False