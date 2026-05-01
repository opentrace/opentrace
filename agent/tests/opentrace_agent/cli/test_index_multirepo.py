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

"""Tests for the multi-repo workspace fixes in ``_run_indexing_pipeline``.

Regression: indexing a second repo used to wipe the first because staging
was renamed over the live DB without seeding from it.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from opentrace_agent.cli.main import (
    _GITIGNORE_CONTENT,
    _acquire_index_lock,
    _ensure_gitignore,
    _IndexLockError,
    _release_index_lock,
    _run_indexing_pipeline,
    _seed_staging_from_live,
    _swap_staging_into_place,
)
from opentrace_agent.store import GraphStore

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "fixtures"
assert FIXTURE_DIR.is_dir(), f"Fixture dir not found: {FIXTURE_DIR}"


# ---------------------------------------------------------------------------
# _seed_staging_from_live
# ---------------------------------------------------------------------------


class TestSeedStagingFromLive:
    def test_no_live_db_is_noop(self, tmp_path: Path) -> None:
        db = tmp_path / "index.db"
        staging = tmp_path / "index.db.staging"
        _seed_staging_from_live(str(db), str(staging))
        assert not staging.exists()
        assert not Path(str(staging) + ".wal").exists()

    def test_copies_db_only(self, tmp_path: Path) -> None:
        db = tmp_path / "index.db"
        staging = tmp_path / "index.db.staging"
        db.write_bytes(b"live db contents")
        _seed_staging_from_live(str(db), str(staging))
        assert staging.read_bytes() == b"live db contents"
        assert not Path(str(staging) + ".wal").exists()

    def test_copies_db_and_wal(self, tmp_path: Path) -> None:
        db = tmp_path / "index.db"
        wal = tmp_path / "index.db.wal"
        staging = tmp_path / "index.db.staging"
        db.write_bytes(b"live db")
        wal.write_bytes(b"live wal")
        _seed_staging_from_live(str(db), str(staging))
        assert staging.read_bytes() == b"live db"
        assert Path(str(staging) + ".wal").read_bytes() == b"live wal"

    def test_does_not_touch_live_files(self, tmp_path: Path) -> None:
        db = tmp_path / "index.db"
        wal = tmp_path / "index.db.wal"
        staging = tmp_path / "index.db.staging"
        db.write_bytes(b"live db")
        wal.write_bytes(b"live wal")
        _seed_staging_from_live(str(db), str(staging))
        assert db.read_bytes() == b"live db"
        assert wal.read_bytes() == b"live wal"


# ---------------------------------------------------------------------------
# _swap_staging_into_place
# ---------------------------------------------------------------------------


class TestSwapStagingIntoPlace:
    def test_renames_db_only(self, tmp_path: Path) -> None:
        staging = tmp_path / "index.db.staging"
        live = tmp_path / "index.db"
        staging.write_bytes(b"new db")
        _swap_staging_into_place(str(staging), str(live))
        assert live.read_bytes() == b"new db"
        assert not staging.exists()

    def test_replaces_live_wal_with_staging_wal(self, tmp_path: Path) -> None:
        staging = tmp_path / "index.db.staging"
        live = tmp_path / "index.db"
        staging_wal = tmp_path / "index.db.staging.wal"
        live_wal = tmp_path / "index.db.wal"
        staging.write_bytes(b"new db")
        staging_wal.write_bytes(b"new wal")
        live.write_bytes(b"old db")
        live_wal.write_bytes(b"old wal")
        _swap_staging_into_place(str(staging), str(live))
        assert live.read_bytes() == b"new db"
        assert live_wal.read_bytes() == b"new wal"
        assert not staging.exists()
        assert not staging_wal.exists()

    def test_drops_stale_live_wal_when_no_staging_wal(self, tmp_path: Path) -> None:
        staging = tmp_path / "index.db.staging"
        live = tmp_path / "index.db"
        live_wal = tmp_path / "index.db.wal"
        staging.write_bytes(b"new db")
        live.write_bytes(b"old db")
        live_wal.write_bytes(b"old wal")
        _swap_staging_into_place(str(staging), str(live))
        assert live.read_bytes() == b"new db"
        assert not live_wal.exists()

    def test_wal_rename_failure_drops_both_wals(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        from unittest.mock import patch

        staging = tmp_path / "index.db.staging"
        live = tmp_path / "index.db"
        staging_wal = tmp_path / "index.db.staging.wal"
        live_wal = tmp_path / "index.db.wal"
        staging.write_bytes(b"new db")
        staging_wal.write_bytes(b"new wal")
        live.write_bytes(b"old db")
        live_wal.write_bytes(b"old wal")

        real_replace = os.replace
        calls = {"n": 0}

        def flaky_replace(src, dst):
            calls["n"] += 1
            if calls["n"] == 1:
                return real_replace(src, dst)
            raise OSError(18, "Cross-device link not permitted")

        with patch("opentrace_agent.cli.main.os.replace", side_effect=flaky_replace):
            _swap_staging_into_place(str(staging), str(live))

        assert live.read_bytes() == b"new db"
        assert not staging.exists()
        assert not staging_wal.exists()
        assert not live_wal.exists()
        captured = capsys.readouterr()
        assert "failed to install staging WAL" in captured.err


# ---------------------------------------------------------------------------
# _acquire_index_lock / _release_index_lock
# ---------------------------------------------------------------------------


class TestIndexLock:
    def test_acquire_and_release(self, tmp_path: Path) -> None:
        db = tmp_path / "index.db"
        fh = _acquire_index_lock(str(db))
        try:
            assert (tmp_path / "index.db.indexlock").exists()
        finally:
            _release_index_lock(fh)

    def test_second_acquire_fails_fast(self, tmp_path: Path) -> None:
        from opentrace_agent.cli.workspace import EXIT_INDEX_IN_PROGRESS

        db = tmp_path / "index.db"
        first = _acquire_index_lock(str(db))
        try:
            with pytest.raises(_IndexLockError) as exc_info:
                _acquire_index_lock(str(db))
            assert exc_info.value.exit_code == EXIT_INDEX_IN_PROGRESS
            assert "indexlock" in str(exc_info.value.message)
        finally:
            _release_index_lock(first)

    def test_release_allows_reacquire(self, tmp_path: Path) -> None:
        db = tmp_path / "index.db"
        fh1 = _acquire_index_lock(str(db))
        _release_index_lock(fh1)
        fh2 = _acquire_index_lock(str(db))
        _release_index_lock(fh2)

    def test_lock_released_on_pipeline_exception(self, tmp_path: Path) -> None:
        from unittest.mock import patch

        db_path = tmp_path / "index.db"

        with patch(
            "opentrace_agent.store.GraphStore",
            side_effect=RuntimeError("boom"),
        ):
            with pytest.raises(RuntimeError):
                _run_indexing_pipeline(
                    source_path=FIXTURE_DIR / "level1",
                    repo_id="repo-x",
                    db_path=str(db_path),
                    batch_size=200,
                    verbose=False,
                )

        # Would raise _IndexLockError if the lock leaked.
        fh = _acquire_index_lock(str(db_path))
        _release_index_lock(fh)


# ---------------------------------------------------------------------------
# Multi-repo integration: two indexes, both repos survive
# ---------------------------------------------------------------------------


class TestMultiRepoIndexing:
    def _node_count(self, db_path: Path) -> int:
        with GraphStore(str(db_path), read_only=True) as gs:
            return int(gs.get_stats()["total_nodes"])

    def test_second_index_preserves_first(self, tmp_path: Path) -> None:
        db_path = tmp_path / "index.db"

        repo_a = FIXTURE_DIR / "level1"
        repo_b = FIXTURE_DIR / "level2"

        _run_indexing_pipeline(
            source_path=repo_a,
            repo_id="repo-a",
            db_path=str(db_path),
            batch_size=200,
            verbose=False,
        )
        with GraphStore(str(db_path), read_only=True) as gs:
            ids_after_first = gs.list_repository_ids()
        nodes_after_first = self._node_count(db_path)
        assert "repo-a" in ids_after_first
        # Guards against the bug-present test passing on an empty scan.
        assert nodes_after_first > 1, (
            f"Fixture {repo_a} scanned to only {nodes_after_first} node(s); "
            f"the repo-survival assertion would be vacuous."
        )

        _run_indexing_pipeline(
            source_path=repo_b,
            repo_id="repo-b",
            db_path=str(db_path),
            batch_size=200,
            verbose=False,
        )
        with GraphStore(str(db_path), read_only=True) as gs:
            ids_after_second = gs.list_repository_ids()
        nodes_after_second = self._node_count(db_path)

        assert "repo-a" in ids_after_second, (
            "repo-a was dropped when repo-b was indexed — the staging DB was not seeded from the live DB."
        )
        assert "repo-b" in ids_after_second
        assert nodes_after_second > nodes_after_first, (
            f"Node count did not grow ({nodes_after_first} → {nodes_after_second}); "
            f"the second index appears to have replaced rather than appended."
        )

    def test_reindex_same_repo_does_not_duplicate(self, tmp_path: Path) -> None:
        db_path = tmp_path / "index.db"
        repo = FIXTURE_DIR / "level1"

        for _ in range(2):
            _run_indexing_pipeline(
                source_path=repo,
                repo_id="repo-a",
                db_path=str(db_path),
                batch_size=200,
                verbose=False,
            )
        with GraphStore(str(db_path), read_only=True) as gs:
            ids = gs.list_repository_ids()
        assert ids.count("repo-a") == 1


# ---------------------------------------------------------------------------
# _ensure_gitignore — fresh-write + backfill behavior
# ---------------------------------------------------------------------------


class TestEnsureGitignore:
    def test_writes_template_when_missing(self, tmp_path: Path) -> None:
        _ensure_gitignore(tmp_path)
        gi = tmp_path / ".gitignore"
        assert gi.exists()
        assert "*.indexlock" in gi.read_text()

    def test_idempotent_when_already_up_to_date(self, tmp_path: Path) -> None:
        _ensure_gitignore(tmp_path)
        first = (tmp_path / ".gitignore").read_text()
        _ensure_gitignore(tmp_path)
        second = (tmp_path / ".gitignore").read_text()
        assert first == second

    def test_backfills_missing_indexlock_pattern(self, tmp_path: Path) -> None:
        gi = tmp_path / ".gitignore"
        gi.write_text("# OpenTrace index data\n*.db\n*.db.wal\n")

        _ensure_gitignore(tmp_path)

        content = gi.read_text()
        assert "*.indexlock" in content
        assert "*.db" in content
        assert "*.db.wal" in content
        assert content.count("# OpenTrace index data") == 1

    def test_does_not_append_template_comment_to_existing_file(self, tmp_path: Path) -> None:
        gi = tmp_path / ".gitignore"
        gi.write_text("*.db\n*.db.wal\n")

        _ensure_gitignore(tmp_path)

        content = gi.read_text()
        assert "*.indexlock" in content
        assert not content.startswith("# OpenTrace")

    def test_handles_existing_file_without_trailing_newline(self, tmp_path: Path) -> None:
        gi = tmp_path / ".gitignore"
        gi.write_text("*.db\n*.db.wal")

        _ensure_gitignore(tmp_path)

        lines = gi.read_text().splitlines()
        assert "*.db.wal" in lines
        assert "*.indexlock" in lines

    def test_indexlock_pattern_actually_matches_lock_filename(self) -> None:
        import fnmatch

        lock_filename = "index.db.indexlock"
        assert "*.indexlock" in _GITIGNORE_CONTENT
        assert fnmatch.fnmatch(lock_filename, "*.indexlock")
