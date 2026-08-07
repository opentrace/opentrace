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

"""serve self-heals a DB left with an unreplayed write journal.

A writer (local-vault compile / index) killed mid-write leaves LadybugDB
``.wal`` / ``.shadow`` files that a read-only open can't replay. `serve` must
recover (replay in a subprocess) instead of refusing to start.

real_ladybug segfaults if a DB path is opened more than once in a single
process, so every DB open below — including fixture setup — runs in its own
subprocess; the test process opens the DB exactly once, via the code under test.
"""

from __future__ import annotations

import subprocess
import sys

import pytest

real_ladybug = pytest.importorskip("real_ladybug")

from opentrace_agent.cli import main as main_mod  # noqa: E402


def _child(code: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", code, *args], capture_output=True, text=True)


def _make_clean_db(db_path: str) -> None:
    r = _child(
        "import sys\n"
        "from opentrace_agent.store import GraphStore\n"
        "s = GraphStore(sys.argv[1]); s.add_node('a','Class','A',{}); s.close()\n",
        db_path,
    )
    assert r.returncode == 0, r.stderr


def _dirty_db(db_path: str) -> None:
    # Interrupt a data write AFTER the schema is committed (mimics a killed
    # compile): open read-write, add a node, hard-exit without checkpointing.
    r = _child(
        "import os, sys\n"
        "from opentrace_agent.store import GraphStore\n"
        "s = GraphStore(sys.argv[1]); s.add_node('b','Class','B',{}); os._exit(0)\n",
        db_path,
    )
    # os._exit(0) -> returncode 0, but the WAL is left unreplayed.
    assert r.returncode == 0, r.stderr


def test_clean_db_opens_directly(tmp_path):
    db = str(tmp_path / "index.db")
    _make_clean_db(db)
    assert not (tmp_path / "index.db.wal").exists()

    store = main_mod._open_readonly_with_recovery(db)  # single open in this process
    try:
        assert store.get_stats()["total_nodes"] == 1
    finally:
        store.close()


def test_recovers_dirty_db(tmp_path):
    db = str(tmp_path / "index.db")
    _make_clean_db(db)
    _dirty_db(db)
    assert (tmp_path / "index.db.wal").exists(), "fixture didn't leave an unreplayed journal"

    store = main_mod._open_readonly_with_recovery(db)  # replays in a subprocess, then opens once
    try:
        # Both the pre-crash node and the interrupted write are present.
        assert store.get_stats()["total_nodes"] == 2
    finally:
        store.close()
    # Journal replayed + checkpointed away.
    assert not (tmp_path / "index.db.wal").exists()


def test_replay_failure_surfaces_clickexception(tmp_path, monkeypatch):
    import click

    db = str(tmp_path / "index.db")
    _make_clean_db(db)
    _dirty_db(db)

    # Simulate a replay that crashes (truly corrupt DB) — serve must raise a
    # clear, actionable error rather than segfaulting or a bare traceback.
    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(args, returncode=-11, stdout="", stderr="Segmentation fault")

    # _replay_db_journal does `import subprocess; subprocess.run(...)`, so
    # patching the module function intercepts it.
    monkeypatch.setattr("subprocess.run", fake_run)

    with pytest.raises(click.ClickException, match="re-index"):
        main_mod._open_readonly_with_recovery(db)
