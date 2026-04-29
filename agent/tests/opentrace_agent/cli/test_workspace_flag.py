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

"""Tests for the top-level ``--workspace`` flag and exit-code contract."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from click.testing import CliRunner

from opentrace_agent.cli import workspace as workspace_module
from opentrace_agent.cli.main import app
from opentrace_agent.cli.workspace import (
    EXIT_DB_MISSING,
    EXIT_USAGE,
    EXIT_WORKSPACE_UNRESOLVABLE,
    resolve_workspace_db,
)


@pytest.fixture()
def workspaces_root(tmp_path, monkeypatch) -> Path:
    """Redirect ~/.opentrace/workspaces/ to a tmp path so tests don't pollute $HOME."""
    root = tmp_path / "workspaces"
    monkeypatch.setattr(workspace_module, "WORKSPACES_ROOT", root)
    return root


def test_resolve_workspace_db_idempotent(workspaces_root, tmp_path) -> None:
    """Trailing slash and direct path produce the same workspace key."""
    src = tmp_path / "myproject"
    src.mkdir()
    a = resolve_workspace_db(str(src))
    b = resolve_workspace_db(str(src) + "/")
    assert a == b
    assert a.parent.parent == workspaces_root
    assert a.name == "index.db"
    assert a.parent.name.startswith("myproject-")


def test_resolve_workspace_db_pins_formula(workspaces_root, tmp_path) -> None:
    """Pin <basename>-<sha256[:7]>: digest length and exact digest for a known input.

    Consumers (the OpenCode plugin, IDE extensions) are documented to
    recompute this formula from `--workspace`'s input. A change to the
    hash length or the basename joiner would silently fork those consumers
    off the canonical layout; this test fails loudly first.
    """
    src = tmp_path / "myproject"
    src.mkdir()
    db = resolve_workspace_db(str(src))

    basename, sep, digest = db.parent.name.rpartition("-")
    assert sep == "-"
    assert basename == "myproject"
    assert len(digest) == 7
    assert digest == hashlib.sha256(str(src.resolve()).encode("utf-8")).hexdigest()[:7]


def test_resolve_workspace_db_follows_symlink(workspaces_root, tmp_path) -> None:
    """Symlinks resolve to the same key as the underlying directory."""
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    direct = resolve_workspace_db(str(real))
    via_link = resolve_workspace_db(str(link))
    assert direct == via_link


def test_resolve_workspace_db_strict_realpath(workspaces_root, tmp_path) -> None:
    """A missing directory raises rather than degrading to the unresolved path."""
    missing = tmp_path / "does_not_exist"
    with pytest.raises(FileNotFoundError):
        resolve_workspace_db(str(missing))


def test_resolve_workspace_db_rejects_non_directory(workspaces_root, tmp_path) -> None:
    """A regular file passed as --workspace raises NotADirectoryError.

    Without this guard, ``--workspace ./README.md`` would resolve fine
    and produce a workspace keyed off the filename. NotADirectoryError
    subclasses OSError, so the top-level callback's existing handler
    still maps it to exit 4.
    """
    not_a_dir = tmp_path / "regular.file"
    not_a_dir.write_text("hello")
    with pytest.raises(NotADirectoryError):
        resolve_workspace_db(str(not_a_dir))


def test_resolve_workspace_db_sanitises_unicode(workspaces_root, tmp_path) -> None:
    """Unicode letters in the basename collapse to underscores under the ASCII sanitiser."""
    src = tmp_path / "프로젝트"
    src.mkdir()
    db = resolve_workspace_db(str(src))
    basename = db.parent.name.rpartition("-")[0]
    # All non-ASCII chars replaced; len matches original since each codepoint maps to one underscore.
    assert basename == "_" * len("프로젝트")


def test_resolve_workspace_db_creates_parent(workspaces_root, tmp_path) -> None:
    """The per-workspace directory under WORKSPACES_ROOT is created eagerly."""
    src = tmp_path / "newproj"
    src.mkdir()
    db = resolve_workspace_db(str(src))
    assert db.parent.is_dir()
    assert not db.exists()  # the DB file itself isn't created here


def test_workspace_missing_db_exits_3(workspaces_root, tmp_path) -> None:
    """A read subcommand under --workspace mode exits 3 when index.db is absent."""
    src = tmp_path / "fresh"
    src.mkdir()
    result = CliRunner().invoke(app, ["--workspace", str(src), "stats"])
    assert result.exit_code == EXIT_DB_MISSING, result.output + result.stderr
    assert "No OpenTrace index found at" in result.stderr


def test_workspace_unresolvable_exits_4(workspaces_root, tmp_path) -> None:
    """A missing workspace dir exits 4 before any subcommand runs."""
    missing = tmp_path / "does_not_exist"
    result = CliRunner().invoke(app, ["--workspace", str(missing), "stats"])
    assert result.exit_code == EXIT_WORKSPACE_UNRESOLVABLE, result.output + result.stderr
    assert "Workspace directory does not exist or is not accessible" in result.stderr
    assert str(missing) in result.stderr


def test_workspace_and_db_mutually_exclusive(workspaces_root, tmp_path) -> None:
    """Passing --workspace and --db together is a usage error (exit 2)."""
    src = tmp_path / "proj"
    src.mkdir()
    db = tmp_path / "explicit.db"
    result = CliRunner().invoke(app, ["--workspace", str(src), "stats", "--db", str(db)])
    assert result.exit_code == EXIT_USAGE, result.output + result.stderr
    assert "mutually exclusive" in result.stderr.lower()


def test_workspace_unresolvable_applies_to_every_subcommand(workspaces_root, tmp_path) -> None:
    """Exit 4 fires at the top-level callback, before subcommand parsing."""
    missing = tmp_path / "missing"
    # ``index`` is a write subcommand and would normally accept a missing DB,
    # but the workspace dir itself must exist.
    result = CliRunner().invoke(app, ["--workspace", str(missing), "index", str(tmp_path)])
    assert result.exit_code == EXIT_WORKSPACE_UNRESOLVABLE


def test_no_workspace_flag_preserves_existing_resolution(workspaces_root, tmp_path, monkeypatch) -> None:
    """Without --workspace, walk-up auto-discovery is unchanged (sanity).

    A fresh cwd with no ``.opentrace/`` directory and no ``--workspace``
    falls through to the auto-discovery path, which raises ``UsageError``
    (exit 2) — not the workspace-only exit 3.
    """
    monkeypatch.chdir(tmp_path)
    result = CliRunner().invoke(app, ["stats"])
    assert result.exit_code == EXIT_USAGE
    assert "No .opentrace/index.db found" in result.stderr


def test_workspace_index_routes_to_workspace_db(workspaces_root, tmp_path, monkeypatch) -> None:
    """End-to-end happy path: ``index`` under ``--workspace`` writes to the workspace DB.

    Stubs the indexing pipeline so the test doesn't need a real codebase
    or LadybugDB write — the contract under test is the routing
    decision in ``_resolve_db``, not the indexer itself.
    """
    captured: dict[str, str] = {}

    def fake_pipeline(**kwargs):
        captured["db_path"] = kwargs["db_path"]
        return 0.5

    monkeypatch.setattr("opentrace_agent.cli.main._run_indexing_pipeline", fake_pipeline)

    src = tmp_path / "proj"
    src.mkdir()
    (src / "a.py").write_text("def foo(): return 1\n")

    result = CliRunner().invoke(app, ["--workspace", str(src), "index", str(src)])
    assert result.exit_code == 0, result.output

    expected_db = resolve_workspace_db(str(src))
    assert captured["db_path"] == str(expected_db)
    assert Path(captured["db_path"]).parent.parent == workspaces_root
