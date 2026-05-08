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

"""Tests for the wiki compile CLI's input-collection helper."""

from __future__ import annotations

from pathlib import Path

import click
import pytest

from opentrace_agent.cli.wiki_cmd import _collect_inputs, _open_graph_store


def _make_tree(root: Path, files: list[str]) -> None:
    for rel in files:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x")


def _collect(root: Path, **kwargs) -> list[str]:
    """Run _collect_inputs and return basenames sorted for stable assertion."""
    defaults: dict = {
        "includes": [],
        "excludes": [],
        "apply_default_excludes": True,
        "include_hidden": False,
    }
    defaults.update(kwargs)
    return sorted(p.name for p in _collect_inputs([root], **defaults))


def test_passing_a_file_yields_it_directly(tmp_path: Path):
    f = tmp_path / "notes.md"
    f.write_text("hello")
    out = list(_collect_inputs([f], includes=[], excludes=[], apply_default_excludes=True, include_hidden=False))
    assert out == [f]


def test_walking_a_dir_yields_all_files(tmp_path: Path):
    _make_tree(tmp_path, ["a.md", "b.md", "sub/c.md"])
    assert _collect(tmp_path) == ["a.md", "b.md", "c.md"]


def test_default_excludes_skip_vcs_and_caches(tmp_path: Path):
    _make_tree(
        tmp_path,
        [
            "a.md",
            ".git/config",
            "node_modules/foo/index.js",
            "__pycache__/x.pyc",
            ".venv/lib/foo.py",
            ".opentrace/index.db",
        ],
    )
    assert _collect(tmp_path) == ["a.md"]


def test_no_default_excludes_includes_them(tmp_path: Path):
    _make_tree(tmp_path, ["a.md", "node_modules/foo.js"])
    # We still skip dotfiles (default excludes off ≠ hidden on).
    assert _collect(tmp_path, apply_default_excludes=False) == ["a.md", "foo.js"]


def test_hidden_files_skipped_by_default(tmp_path: Path):
    _make_tree(tmp_path, ["a.md", ".secret"])
    assert _collect(tmp_path) == ["a.md"]


def test_hidden_flag_includes_dotfiles(tmp_path: Path):
    _make_tree(tmp_path, ["a.md", ".secret"])
    assert _collect(tmp_path, include_hidden=True) == [".secret", "a.md"]


def test_include_glob_filters_to_matches(tmp_path: Path):
    _make_tree(tmp_path, ["a.md", "b.txt", "sub/c.md"])
    assert _collect(tmp_path, includes=["*.md"]) == ["a.md", "c.md"]


def test_include_matches_relative_path(tmp_path: Path):
    _make_tree(tmp_path, ["docs/a.md", "src/b.md"])
    assert _collect(tmp_path, includes=["docs/*"]) == ["a.md"]


def test_exclude_glob_skips_matches(tmp_path: Path):
    _make_tree(tmp_path, ["a.md", "b.txt", "sub/c.md"])
    assert _collect(tmp_path, excludes=["*.txt"]) == ["a.md", "c.md"]


def test_include_and_exclude_combine(tmp_path: Path):
    _make_tree(tmp_path, ["a.md", "b.md", "draft.md", "c.txt"])
    out = _collect(tmp_path, includes=["*.md"], excludes=["draft*"])
    assert out == ["a.md", "b.md"]


def test_open_graph_store_translates_lock_error(monkeypatch, tmp_path: Path):
    """A LadybugDB lock error becomes a friendly ClickException pointing at serve."""
    db_path = tmp_path / "index.db"
    db_path.write_bytes(b"")

    def _raise_lock(*args, **kwargs):
        raise RuntimeError(f"IO exception: Could not set lock on file : {db_path}")

    monkeypatch.setattr(
        "opentrace_agent.store.GraphStore.__init__",
        _raise_lock,
    )
    with pytest.raises(click.ClickException) as exc:
        _open_graph_store(str(db_path))
    msg = exc.value.message
    assert "held by another process" in msg
    assert "opentraceai serve" in msg
    assert "wiki backfill" in msg


def test_open_graph_store_propagates_unrelated_runtime_errors(monkeypatch, tmp_path: Path):
    """Non-lock RuntimeErrors are not swallowed by the lock translation."""
    db_path = tmp_path / "index.db"
    db_path.write_bytes(b"")

    def _raise_other(*args, **kwargs):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(
        "opentrace_agent.store.GraphStore.__init__",
        _raise_other,
    )
    with pytest.raises(RuntimeError, match="disk on fire"):
        _open_graph_store(str(db_path))


def test_mixed_files_and_folders(tmp_path: Path):
    standalone = tmp_path / "ext.md"
    standalone.write_text("x")
    folder = tmp_path / "folder"
    folder.mkdir()
    _make_tree(folder, ["a.md", "b.md"])
    out = sorted(
        p.name
        for p in _collect_inputs(
            [standalone, folder],
            includes=[],
            excludes=[],
            apply_default_excludes=True,
            include_hidden=False,
        )
    )
    assert out == ["a.md", "b.md", "ext.md"]
