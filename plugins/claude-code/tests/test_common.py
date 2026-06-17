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

"""Unit tests for the helpers added to scripts/_common.py: the
staleness tracker, the last-index sentinel, and ``build_directive``.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path


def _touch_newer(path: Path, base_mtime: float, delta_seconds: float = 5.0) -> float:
    """Force ``path``'s mtime to ``base_mtime + delta_seconds``.

    Beats real-clock races on fast filesystems where two writes can share
    a timestamp.
    """
    new_mtime = base_mtime + delta_seconds
    os.utime(path, (new_mtime, new_mtime))
    return new_mtime


# ---------------------------------------------------------------------------
# build_directive
# ---------------------------------------------------------------------------

def test_build_directive_includes_base_text(tmp_cache):
    directive = tmp_cache.build_directive()
    assert "OpenTrace is active" in directive
    assert "opentrace-*" in directive
    assert "Current graph state" not in directive  # no stats arg
    assert "Index:" not in directive  # no db_path arg


def test_build_directive_with_stats_and_db(tmp_cache):
    db = Path("/tmp/index.db")
    directive = tmp_cache.build_directive(stats="nodes=10 edges=20", db_path=db)
    assert "Current graph state:" in directive
    assert "nodes=10 edges=20" in directive
    assert "Index: /tmp/index.db" in directive


# ---------------------------------------------------------------------------
# Staleness tracker — record_edit / stale_files
# ---------------------------------------------------------------------------

def test_record_edit_and_stale_files_happy_path(tmp_cache, tmp_workspace):
    db = tmp_workspace / ".opentrace" / "index.db"
    db_mtime = db.stat().st_mtime

    edited = tmp_workspace / "src" / "a.py"
    edited.parent.mkdir(parents=True)
    edited.write_text("print('hi')\n")
    _touch_newer(edited, db_mtime)

    tmp_cache.record_edit(str(edited), tmp_workspace)
    stale = tmp_cache.stale_files(tmp_workspace)
    assert stale == [str(edited)]


def test_record_edit_drops_when_db_is_newer(tmp_cache, tmp_workspace):
    edited = tmp_workspace / "a.py"
    edited.write_text("x = 1\n")
    tmp_cache.record_edit(str(edited), tmp_workspace)

    # Re-index by touching the DB to a time after the edit.
    db = tmp_workspace / ".opentrace" / "index.db"
    _touch_newer(db, edited.stat().st_mtime, delta_seconds=10.0)

    assert tmp_cache.stale_files(tmp_workspace) == []


def test_stale_files_isolated_per_workspace(tmp_cache, tmp_path):
    """Edits in workspace A must not leak into workspace B's stale list."""
    ws_a = tmp_path / "a"
    ws_b = tmp_path / "b"
    for ws in (ws_a, ws_b):
        ws.mkdir()
        (ws / ".git").mkdir()
        (ws / ".opentrace").mkdir()
        (ws / ".opentrace" / "index.db").write_text("db")

    file_a = ws_a / "x.py"
    file_a.write_text("a = 1\n")
    _touch_newer(file_a, (ws_a / ".opentrace" / "index.db").stat().st_mtime)
    tmp_cache.record_edit(str(file_a), ws_a)

    assert tmp_cache.stale_files(ws_a) == [str(file_a)]
    assert tmp_cache.stale_files(ws_b) == []


def test_stale_files_skips_deleted_paths(tmp_cache, tmp_workspace):
    """If the user later deletes the edited file, it shouldn't appear stale."""
    edited = tmp_workspace / "ghost.py"
    edited.write_text("temp\n")
    _touch_newer(edited, (tmp_workspace / ".opentrace" / "index.db").stat().st_mtime)
    tmp_cache.record_edit(str(edited), tmp_workspace)
    edited.unlink()

    assert tmp_cache.stale_files(tmp_workspace) == []


def test_record_edit_handles_missing_db(tmp_cache, tmp_path):
    """A workspace without an index DB shouldn't crash record_edit."""
    workspace = tmp_path / "noindex"
    workspace.mkdir()
    edited = workspace / "x.py"
    edited.write_text("x = 1\n")

    # record_edit should not raise even though stale_files returns [] later.
    tmp_cache.record_edit(str(edited), workspace)
    assert tmp_cache.stale_files(workspace) == []


def test_stale_files_handles_malformed_cache(tmp_cache, tmp_workspace):
    """A corrupted staleness.json must not crash readers."""
    tmp_cache.STALENESS_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_cache.STALENESS_CACHE_PATH.write_text("not valid json {{{")
    assert tmp_cache.stale_files(tmp_workspace) == []


# ---------------------------------------------------------------------------
# prune_staleness
# ---------------------------------------------------------------------------

def test_prune_staleness_drops_old_entries(tmp_cache, tmp_workspace):
    edited = tmp_workspace / "old.py"
    edited.write_text("# old\n")
    tmp_cache.record_edit(str(edited), tmp_workspace)

    # Backdate the ts field beyond the max age.
    data = json.loads(tmp_cache.STALENESS_CACHE_PATH.read_text())
    for entry in data.values():
        entry["ts"] = time.time() - (tmp_cache.STALENESS_MAX_AGE_SECONDS + 100)
    tmp_cache.STALENESS_CACHE_PATH.write_text(json.dumps(data))

    tmp_cache.prune_staleness()
    assert json.loads(tmp_cache.STALENESS_CACHE_PATH.read_text()) == {}


def test_prune_staleness_keeps_recent_entries(tmp_cache, tmp_workspace):
    edited = tmp_workspace / "recent.py"
    edited.write_text("# new\n")
    tmp_cache.record_edit(str(edited), tmp_workspace)

    tmp_cache.prune_staleness()
    data = json.loads(tmp_cache.STALENESS_CACHE_PATH.read_text())
    assert len(data) == 1


def test_prune_staleness_handles_empty_cache(tmp_cache):
    """No staleness.json yet → prune is a no-op, no crash."""
    tmp_cache.prune_staleness()
    assert not tmp_cache.STALENESS_CACHE_PATH.exists()


# ---------------------------------------------------------------------------
# Last-index sentinel
# ---------------------------------------------------------------------------

def test_record_index_complete_round_trip(tmp_cache, tmp_workspace):
    assert tmp_cache.last_index_seen(tmp_workspace) is None
    tmp_cache.record_index_complete(tmp_workspace, 1234.5)
    assert tmp_cache.last_index_seen(tmp_workspace) == 1234.5


def test_last_index_seen_isolates_workspaces(tmp_cache, tmp_path):
    ws_a = tmp_path / "a"
    ws_b = tmp_path / "b"
    ws_a.mkdir()
    ws_b.mkdir()
    tmp_cache.record_index_complete(ws_a, 100.0)
    assert tmp_cache.last_index_seen(ws_a) == 100.0
    assert tmp_cache.last_index_seen(ws_b) is None


def test_last_index_seen_handles_malformed_cache(tmp_cache, tmp_workspace):
    tmp_cache.LAST_INDEX_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_cache.LAST_INDEX_CACHE_PATH.write_text("[][][")
    assert tmp_cache.last_index_seen(tmp_workspace) is None