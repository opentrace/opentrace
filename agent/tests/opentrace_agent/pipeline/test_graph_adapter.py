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

"""Tests for GraphStoreAdapter — verifies batching, flush ordering, and close."""

from __future__ import annotations

import pytest

from opentrace_agent.pipeline.types import GraphNode, GraphRelationship

# Skip entire module if real_ladybug (LadybugDB) is not installed
ladybug = pytest.importorskip("real_ladybug")

GraphStoreAdapter = pytest.importorskip("opentrace_agent.pipeline.adapters").GraphStoreAdapter
GraphStore = pytest.importorskip("opentrace_agent.store").GraphStore


@pytest.fixture()
def graph_store(tmp_path):
    """Create a GraphStore in a temp directory."""
    db_path = str(tmp_path / "testdb")
    store = GraphStore(db_path)
    yield store
    store.close()


@pytest.fixture()
def adapter(graph_store):
    """Create a GraphStoreAdapter wrapping the graph_store fixture."""
    return GraphStoreAdapter(graph_store, batch_size=5)


def _make_node(i: int) -> GraphNode:
    return GraphNode(
        id=f"node-{i}",
        type="Function",
        name=f"func_{i}",
        properties={"path": f"src/mod{i}.py"},
    )


def _make_rel(i: int, src: int, tgt: int) -> GraphRelationship:
    return GraphRelationship(
        id=f"rel-{i}",
        type="CALLS",
        source_id=f"node-{src}",
        target_id=f"node-{tgt}",
    )


class TestGraphStoreAdapter:
    def test_save_node_and_flush(self, adapter, graph_store):
        """Nodes saved via adapter should be retrievable after flush."""
        adapter.save_node(_make_node(1))
        adapter.save_node(_make_node(2))
        adapter.flush()

        n1 = graph_store.get_node("node-1")
        assert n1 is not None
        assert n1["name"] == "func_1"
        assert n1["type"] == "Function"

        n2 = graph_store.get_node("node-2")
        assert n2 is not None

    def test_save_relationship_after_nodes(self, adapter, graph_store):
        """Relationships should reference existing nodes after flush."""
        adapter.save_node(_make_node(1))
        adapter.save_node(_make_node(2))
        adapter.save_relationship(_make_rel(1, src=1, tgt=2))
        adapter.flush()

        stats = graph_store.get_stats()
        assert stats["total_nodes"] == 2
        assert stats["total_edges"] == 1

    def test_auto_flush_at_batch_size(self, adapter, graph_store):
        """Nodes should auto-flush when batch_size (5) is reached."""
        for i in range(5):
            adapter.save_node(_make_node(i))

        # Should have been auto-flushed
        nodes = graph_store.list_nodes("Function")
        assert len(nodes) == 5

    def test_close_flushes_and_closes(self, tmp_path):
        """close() should flush remaining items and close the DB."""
        db_path = str(tmp_path / "closedb")
        store = GraphStore(db_path)
        adapter = GraphStoreAdapter(store, batch_size=100)

        adapter.save_node(_make_node(1))
        adapter.save_node(_make_node(2))
        adapter.save_relationship(_make_rel(1, src=1, tgt=2))
        adapter.close()

        # Re-open and verify data persisted
        store2 = GraphStore(db_path)
        try:
            assert store2.get_node("node-1") is not None
            assert store2.get_node("node-2") is not None
            stats = store2.get_stats()
            assert stats["total_edges"] == 1
        finally:
            store2.close()

    def test_empty_flush_is_noop(self, adapter, graph_store):
        """Flushing with no pending items should not error."""
        adapter.flush()
        stats = graph_store.get_stats()
        assert stats["total_nodes"] == 0

    def test_node_properties_roundtrip(self, adapter, graph_store):
        """Properties should survive the adapter → LadybugDB → read roundtrip."""
        node = GraphNode(
            id="prop-test",
            type="File",
            name="main.py",
            properties={"path": "src/main.py", "language": "python", "lines": 42},
        )
        adapter.save_node(node)
        adapter.flush()

        result = graph_store.get_node("prop-test")
        assert result is not None
        assert result["properties"]["language"] == "python"
        assert result["properties"]["lines"] == 42
