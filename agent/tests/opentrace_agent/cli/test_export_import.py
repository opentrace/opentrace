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

"""Tests for export/import of .parquet.zip archives."""

from __future__ import annotations

import io
import zipfile

import pytest

pytest.importorskip("real_ladybug")

from opentrace_agent.cli.export_import import export_database, import_database  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    """Create a GraphStore with test data."""
    db_path = str(tmp_path / "test.db")
    s = GraphStore(db_path)
    s.add_node("n1", "Class", "UserService", {"language": "python", "path": "src/user.py"})
    s.add_node("n2", "Function", "get_user", {"language": "python"})
    s.add_node("n3", "File", "user.py", {"path": "src/user.py"})
    s.add_relationship("r1", "DEFINES", "n1", "n2")
    s.add_relationship("r2", "CONTAINS", "n3", "n1")
    yield s
    s.close()


def test_export_produces_valid_zip(store):
    data = export_database(store)
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = sorted(zf.namelist())
    assert "relationships.parquet" in names
    assert any(n.startswith("nodes_") for n in names)
    zf.close()


def test_export_has_correct_node_files(store):
    data = export_database(store)
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = zf.namelist()
    assert "nodes_Class.parquet" in names
    assert "nodes_Function.parquet" in names
    assert "nodes_File.parquet" in names
    zf.close()


def test_export_empty_raises(tmp_path):
    db_path = str(tmp_path / "empty.db")
    s = GraphStore(db_path)
    with pytest.raises(ValueError, match="empty"):
        export_database(s)
    s.close()


def test_roundtrip(store, tmp_path):
    """Export from one store, import into another, and verify contents match."""
    data = export_database(store)

    # Import into a fresh store
    db_path2 = str(tmp_path / "imported.db")
    store2 = GraphStore(db_path2)
    result = import_database(store2, data)

    assert result["nodes_created"] == 3
    assert result["relationships_created"] == 2
    assert result["errors"] == 0

    # Verify individual nodes
    n1 = store2.get_node("n1")
    assert n1 is not None
    assert n1["type"] == "Class"
    assert n1["name"] == "UserService"
    assert n1["properties"]["language"] == "python"

    n2 = store2.get_node("n2")
    assert n2 is not None
    assert n2["type"] == "Function"
    assert n2["name"] == "get_user"

    # Verify stats match
    stats1 = store.get_stats()
    stats2 = store2.get_stats()
    assert stats2["total_nodes"] == stats1["total_nodes"]
    assert stats2["total_edges"] == stats1["total_edges"]

    store2.close()


def test_import_bad_zip(tmp_path):
    db_path = str(tmp_path / "test.db")
    s = GraphStore(db_path)
    with pytest.raises(ValueError, match="unzip"):
        import_database(s, b"not a zip file")
    s.close()


def test_import_empty_zip(tmp_path):
    db_path = str(tmp_path / "test.db")
    s = GraphStore(db_path)
    buf = io.BytesIO()
    zipfile.ZipFile(buf, "w").close()
    with pytest.raises(ValueError, match="no files"):
        import_database(s, buf.getvalue())
    s.close()


def test_import_progress_callback(store, tmp_path):
    data = export_database(store)
    messages: list[str] = []

    db_path2 = str(tmp_path / "imported.db")
    store2 = GraphStore(db_path2)
    import_database(store2, data, on_progress=messages.append)
    store2.close()

    assert len(messages) > 0
    assert any("Unpacking" in m for m in messages)
    assert any("Done" in m for m in messages)
