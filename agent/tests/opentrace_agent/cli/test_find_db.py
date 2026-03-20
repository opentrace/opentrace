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

"""Tests for .opentrace/index.db auto-discovery."""

from __future__ import annotations

from pathlib import Path

from opentrace_agent.cli.main import find_db


def _make_db(base: Path) -> Path:
    """Create a fake .opentrace/index.db under *base*."""
    db_dir = base / ".opentrace"
    db_dir.mkdir(parents=True, exist_ok=True)
    db_file = db_dir / "index.db"
    db_file.touch()
    return db_file


def test_finds_db_in_cwd(tmp_path: Path) -> None:
    db = _make_db(tmp_path)
    result = find_db(tmp_path)
    assert result is not None
    assert result == db.resolve()


def test_finds_db_in_parent(tmp_path: Path) -> None:
    _make_db(tmp_path)
    child = tmp_path / "sub" / "deep"
    child.mkdir(parents=True)
    result = find_db(child)
    assert result is not None
    assert result.name == "index.db"


def test_stops_at_git_root(tmp_path: Path) -> None:
    """DB above git root should not be found."""
    _make_db(tmp_path)
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".git").mkdir()  # git root
    work = repo / "src"
    work.mkdir()
    result = find_db(work)
    assert result is None


def test_returns_none_when_missing(tmp_path: Path) -> None:
    result = find_db(tmp_path)
    assert result is None


def test_rejects_symlink_escaping_boundary(tmp_path: Path) -> None:
    """A symlinked .opentrace pointing outside the repo should be rejected."""
    outside = tmp_path / "outside"
    _make_db(outside)

    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".git").mkdir()

    # Symlink .opentrace inside repo → outside directory
    (repo / ".opentrace").symlink_to(outside / ".opentrace")

    result = find_db(repo)
    assert result is None


def test_finds_db_at_git_root(tmp_path: Path) -> None:
    """DB at the git root itself should be found."""
    (tmp_path / ".git").mkdir()
    _make_db(tmp_path)
    child = tmp_path / "src"
    child.mkdir()
    result = find_db(child)
    assert result is not None
