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

"""Tests for the ``opentraceai wiki`` subcommand scaffolding.

The compile command was removed in the ingestion-unification work; what
remains here is ``_open_graph_store`` (the lock-error translation helper
used by every remaining ``wiki`` subcommand).
"""

from __future__ import annotations

from pathlib import Path

import click
import pytest

from opentrace_agent.cli.vault_cmd import _open_graph_store


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
