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

"""Tests for stale-staging self-heal in ``opentrace index``."""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from opentrace_agent.cli.main import _clean_stale_staging, _safe_unlink


def _make_file(path: Path, content: bytes = b"x") -> None:
    path.write_bytes(content)


def test_noop_when_no_artifacts(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    staging = str(tmp_path / "index.db.staging")
    _clean_stale_staging(staging)
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""


def test_removes_staging_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    staging = tmp_path / "index.db.staging"
    _make_file(staging)

    _clean_stale_staging(str(staging))

    assert not staging.exists()
    captured = capsys.readouterr()
    assert "Cleaned stale staging" in captured.out
    assert str(staging) in captured.out


def test_removes_staging_wal(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    wal = tmp_path / "index.db.staging.wal"
    _make_file(wal)

    _clean_stale_staging(str(tmp_path / "index.db.staging"))

    assert not wal.exists()
    captured = capsys.readouterr()
    assert "Cleaned stale staging" in captured.out
    assert str(wal) in captured.out


def test_removes_both_staging_and_wal(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    staging = tmp_path / "index.db.staging"
    wal = tmp_path / "index.db.staging.wal"
    _make_file(staging, b"fake staging")
    _make_file(wal, b"fake wal")

    _clean_stale_staging(str(staging))

    assert not staging.exists()
    assert not wal.exists()
    captured = capsys.readouterr()
    assert str(staging) in captured.out
    assert str(wal) in captured.out


def test_does_not_touch_live_db(tmp_path: Path) -> None:
    """The helper must never touch the live DB file or its WAL."""
    live = tmp_path / "index.db"
    live_wal = tmp_path / "index.db.wal"
    staging = tmp_path / "index.db.staging"
    _make_file(live, b"live")
    _make_file(live_wal, b"live wal")
    _make_file(staging, b"stale")

    _clean_stale_staging(str(staging))

    assert not staging.exists()
    assert live.exists() and live.read_bytes() == b"live"
    assert live_wal.exists() and live_wal.read_bytes() == b"live wal"


@pytest.mark.skipif(
    os.geteuid() == 0 if hasattr(os, "geteuid") else False,
    reason="root can always unlink, permission test is irrelevant",
)
def test_warns_on_permission_error(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """If the file can't be removed, emit a warning to stderr and continue."""
    staging_dir = tmp_path / "locked"
    staging_dir.mkdir()
    staging = staging_dir / "index.db.staging"
    _make_file(staging)

    # Strip write permission from the parent directory so unlink fails.
    staging_dir.chmod(stat.S_IREAD | stat.S_IEXEC)
    try:
        _clean_stale_staging(str(staging))
    finally:
        # Restore permissions so pytest can clean up tmp_path.
        staging_dir.chmod(stat.S_IRWXU)

    captured = capsys.readouterr()
    # Warning must land on stderr, include the problem path, and tag the
    # cleanup site ("stale staging" vs. the two other contexts in index)
    # so readers can tell which cleanup logged it.
    assert "Warning" in captured.err
    assert "failed to remove" in captured.err
    assert str(staging) in captured.err
    assert "stale staging" in captured.err
    # Helper should not raise, even though the file is still there.
    assert staging.exists()


# -- _safe_unlink (the shared helper used by both cleanup sites in index) ----


class TestSafeUnlink:
    def test_missing_file_is_noop(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        removed = _safe_unlink(str(tmp_path / "does-not-exist"), context="whatever")
        assert removed is False
        captured = capsys.readouterr()
        # Missing files must not generate warnings — they're the common case.
        assert captured.err == ""

    def test_existing_file_removed_quietly(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        target = tmp_path / "victim"
        target.write_bytes(b"x")
        removed = _safe_unlink(str(target), context="any")
        assert removed is True
        assert not target.exists()
        # The helper itself is silent on success — callers decide whether
        # to log; this keeps it safe to call from hot paths.
        assert capsys.readouterr().err == ""

    @pytest.mark.skipif(
        os.geteuid() == 0 if hasattr(os, "geteuid") else False,
        reason="root can always unlink, permission test is irrelevant",
    )
    def test_permission_error_does_not_raise(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """Post-rename cleanup must not crash the command when unlink
        is refused (e.g. read-only FS).
        """
        locked_dir = tmp_path / "locked"
        locked_dir.mkdir()
        target = locked_dir / "stuck.wal"
        target.write_bytes(b"x")
        locked_dir.chmod(stat.S_IREAD | stat.S_IEXEC)
        try:
            # Must return False, must not raise, must log with the context.
            removed = _safe_unlink(str(target), context="post-rename cleanup")
        finally:
            locked_dir.chmod(stat.S_IRWXU)
        assert removed is False
        captured = capsys.readouterr()
        assert "post-rename cleanup" in captured.err
        assert str(target) in captured.err
        # The file is still there; the calling command should have
        # completed regardless.
        assert target.exists()
