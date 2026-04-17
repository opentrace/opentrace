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

"""Tests for _ReloadableStore — inode-based database hot-reload proxy."""

from __future__ import annotations

import os

import pytest

pytest.importorskip("real_ladybug")

from opentrace_agent.cli.main import _ReloadableStore  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402


def _create_db(path: str, node_id: str = "n1") -> GraphStore:
    """Create a small GraphStore at *path* with one node."""
    store = GraphStore(path)
    store.add_node(node_id, "File", node_id)
    return store


# ---------------------------------------------------------------------------


class TestReloadableStore:
    def test_truthy_when_store_exists(self, tmp_path):
        db = str(tmp_path / "test.db")
        store = _create_db(db)

        reloadable = _ReloadableStore(db, store)
        assert reloadable  # truthy
        # Proxy delegates attribute access to the inner store.
        assert reloadable.get_node("n1") is not None
        reloadable.close()

    def test_reopens_on_inode_change(self, tmp_path):
        db = str(tmp_path / "test.db")
        staging = str(tmp_path / "test.db.staging")

        original = _create_db(db, node_id="original")
        reloadable = _ReloadableStore(db, original)

        assert reloadable.get_node("original") is not None

        # Write a new DB with different content and atomically replace.
        replacement = _create_db(staging, node_id="replaced")
        replacement.close()
        os.replace(staging, db)

        # Proxy should detect the inode change and serve new data.
        assert reloadable.get_node("replaced") is not None
        assert reloadable.get_node("original") is None

        reloadable.close()

    def test_falsy_when_file_removed(self, tmp_path):
        db = str(tmp_path / "test.db")
        store = _create_db(db)

        reloadable = _ReloadableStore(db, store)
        assert reloadable

        # Remove the DB file.
        os.unlink(db)

        # Proxy should become falsy.
        assert not reloadable
        reloadable.close()

    def test_falsy_when_no_db_path(self):
        """When db_path is None, proxy is always falsy."""
        reloadable = _ReloadableStore(None, None)
        assert not reloadable
        reloadable.close()

    def test_recovers_after_file_reappears(self, tmp_path):
        db = str(tmp_path / "test.db")
        store = _create_db(db)

        reloadable = _ReloadableStore(db, store)

        # Remove the DB file.
        os.unlink(db)
        assert not reloadable

        # Re-create a DB at the same path.
        new_store = _create_db(db, node_id="recovered")
        new_store.close()

        assert reloadable
        assert reloadable.get_node("recovered") is not None
        reloadable.close()

    def test_close_is_idempotent(self, tmp_path):
        db = str(tmp_path / "test.db")
        store = _create_db(db)
        reloadable = _ReloadableStore(db, store)

        reloadable.close()
        reloadable.close()  # Should not raise.
