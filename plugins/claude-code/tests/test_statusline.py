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

"""Exercise statusline.sh against the edge cases its real users hit:
no index, fresh index, stale workspace, and a missing opentraceai CLI.

The script is contracted to fail silent — any unhandled error should
produce no output and a 0 exit, never break the user's status line.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
STATUSLINE = PLUGIN_ROOT / "statusline.sh"


def _scrub_path() -> str:
    """A PATH without the user's installed opentraceai/uvx so the script
    has to fall through to the no-stats branch.
    """
    keep = []
    for part in os.environ.get("PATH", "").split(":"):
        if not part:
            continue
        if Path(part, "opentraceai").exists() or Path(part, "uvx").exists():
            continue
        keep.append(part)
    return ":".join(keep) or "/usr/bin:/bin"


def _run(workspace: Path, *, tmpdir: Path, scrub_cli: bool = False) -> subprocess.CompletedProcess:
    env = {
        "TMPDIR": str(tmpdir),
        "PATH": _scrub_path() if scrub_cli else os.environ.get("PATH", ""),
        "HOME": str(tmpdir),
    }
    payload = json.dumps({"workspace": {"current_dir": str(workspace)}})
    return subprocess.run(
        ["bash", str(STATUSLINE)],
        input=payload,
        capture_output=True,
        text=True,
        env=env,
        timeout=10,
    )


def _seed_staleness(tmpdir: Path, workspace: Path, paths: list[Path], future_mtime: float):
    """Build a staleness.json the way the hooks would, so statusline sees stale files."""
    uid = os.getuid() if hasattr(os, "getuid") else "shared"
    cache_dir = tmpdir / f"opentrace-claude-hooks-{uid}"
    cache_dir.mkdir(parents=True, exist_ok=True)
    workspace_str = str(workspace.resolve())
    data = {}
    for p in paths:
        os.utime(p, (future_mtime, future_mtime))
        raw = f"{workspace.resolve()}|Staleness|edit|{p}"
        key = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        data[key] = {
            "path": str(p),
            "mtime": future_mtime,
            "ts": future_mtime,
            "workspace": workspace_str,
        }
    (cache_dir / "staleness.json").write_text(json.dumps(data))


@pytest.fixture
def fresh_workspace(tmp_path):
    """Workspace with a .git marker and a fresh .opentrace/index.db."""
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / ".git").mkdir()
    (ws / ".opentrace").mkdir()
    (ws / ".opentrace" / "index.db").write_text("db")
    return ws


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

def test_statusline_no_index(tmp_path):
    """Workspace with no .opentrace dir → 'otrc: no index'."""
    ws = tmp_path / "bare"
    ws.mkdir()
    (ws / ".git").mkdir()
    result = _run(ws, tmpdir=tmp_path)
    assert result.returncode == 0, result.stderr
    assert result.stdout == "otrc: no index"


def test_statusline_fresh_index_shows_age(tmp_path, fresh_workspace):
    result = _run(fresh_workspace, tmpdir=tmp_path, scrub_cli=True)
    assert result.returncode == 0, result.stderr
    # Just-written DB → "0s ago" or "Xs ago".
    assert result.stdout.startswith("otrc: idx ")
    assert "ago" in result.stdout
    assert "stale" not in result.stdout


def test_statusline_stale_state(tmp_path, fresh_workspace):
    db = fresh_workspace / ".opentrace" / "index.db"
    db_mtime = db.stat().st_mtime
    f1 = fresh_workspace / "a.py"
    f2 = fresh_workspace / "b.py"
    f1.write_text("a = 1\n")
    f2.write_text("b = 2\n")
    _seed_staleness(tmp_path, fresh_workspace, [f1, f2], db_mtime + 60.0)

    result = _run(fresh_workspace, tmpdir=tmp_path, scrub_cli=True)
    assert result.returncode == 0, result.stderr
    assert "stale (2)" in result.stdout


def test_statusline_ignores_other_workspace_stale_entries(tmp_path, fresh_workspace):
    """Stale entries from a different workspace must not contaminate count."""
    other_ws = tmp_path / "other"
    other_ws.mkdir()
    (other_ws / "x.py").write_text("x=1\n")
    db_mtime = (fresh_workspace / ".opentrace" / "index.db").stat().st_mtime
    _seed_staleness(tmp_path, other_ws, [other_ws / "x.py"], db_mtime + 60.0)

    result = _run(fresh_workspace, tmpdir=tmp_path, scrub_cli=True)
    assert result.returncode == 0
    assert "stale" not in result.stdout


def test_statusline_handles_missing_cli(tmp_path, fresh_workspace):
    """No opentraceai / uvx on PATH → script still prints age, no nodes fragment."""
    result = _run(fresh_workspace, tmpdir=tmp_path, scrub_cli=True)
    assert result.returncode == 0
    assert result.stdout.startswith("otrc: idx ")
    # With CLI scrubbed, "X nodes" cannot be produced.
    assert "nodes" not in result.stdout


def test_statusline_handles_malformed_staleness_cache(tmp_path, fresh_workspace):
    """A garbled staleness.json must not break the status line."""
    uid = os.getuid() if hasattr(os, "getuid") else "shared"
    cache_dir = tmp_path / f"opentrace-claude-hooks-{uid}"
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / "staleness.json").write_text("not valid json {{")

    result = _run(fresh_workspace, tmpdir=tmp_path, scrub_cli=True)
    assert result.returncode == 0
    # Garbage cache → treated as zero stale, so we get the normal age line.
    assert result.stdout.startswith("otrc: idx ")
    assert "stale" not in result.stdout


def test_statusline_silent_on_empty_stdin(tmp_path):
    """When Claude Code provides no JSON, fall back to $PWD."""
    env = {"TMPDIR": str(tmp_path), "PATH": _scrub_path(), "HOME": str(tmp_path)}
    result = subprocess.run(
        ["bash", str(STATUSLINE)],
        input="",
        capture_output=True,
        text=True,
        env=env,
        cwd=str(tmp_path),
        timeout=10,
    )
    assert result.returncode == 0
    # tmp_path has no .opentrace → no-index branch.
    assert result.stdout == "otrc: no index"