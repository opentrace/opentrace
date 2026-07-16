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


def _dump_graph(store) -> tuple[list[tuple], list[tuple]]:
    """Full sorted dump of every node and rel row for exact comparison."""
    nodes: list[tuple] = []
    res = store._conn.execute("MATCH (n:Node) RETURN n.id, n.type, n.name, n.properties")
    while res.has_next():
        nodes.append(tuple(str(v) for v in res.get_next()))
    rels: list[tuple] = []
    res = store._conn.execute("MATCH (a:Node)-[r:RELATES]->(b:Node) RETURN r.id, r.type, r.properties, a.id, b.id")
    while res.has_next():
        rels.append(tuple(str(v) for v in res.get_next()))
    return sorted(nodes), sorted(rels)


@pytest.fixture()
def fixture_repo(tmp_path):
    """Small mixed Go/Python repo exercising import resolution and rel dedup."""
    repo = tmp_path / "fixrepo"
    (repo / "pkg" / "util").mkdir(parents=True)
    (repo / "cmd").mkdir()
    # Two files in the imported package dir → multi-candidate Go import.
    (repo / "pkg" / "util" / "helper.go").write_text("package util\n\nfunc Helper() int { return 1 }\n")
    (repo / "pkg" / "util" / "extra.go").write_text("package util\n\nfunc Extra() int { return 2 }\n")
    (repo / "cmd" / "main.go").write_text(
        'package main\n\nimport "example.com/proj/pkg/util"\n\nfunc main() { util.Helper() }\n'
    )
    # Shadowed parameter → duplicate Variable node ids within one scope.
    (repo / "lib.py").write_text("def helper(x):\n    x = 1\n    return x\n")
    (repo / "app.py").write_text("import lib\n\n\ndef run():\n    return lib.helper(2)\n")
    return repo


class TestIndexResultStability:
    """End-to-end: the id mirror and the Go dir index must not change what a
    (re)index produces — full node+rel dumps compared byte-for-byte."""

    def _index_once(self, graph_store, repo_path: str) -> None:
        from opentrace_agent.pipeline.pipeline import run_pipeline
        from opentrace_agent.pipeline.types import PipelineInput

        # Tiny batch size → many flushes → exercises cross-batch dedup,
        # endpoint checks, and the rel-id DELETE path.
        adapter = GraphStoreAdapter(graph_store, batch_size=3)
        for _ in run_pipeline(PipelineInput(path=repo_path, repo_id="fixrepo"), store=adapter):
            pass

    def test_reindex_and_delete_reindex_produce_identical_graphs(self, graph_store, fixture_repo):
        self._index_once(graph_store, str(fixture_repo))
        first = _dump_graph(graph_store)
        assert first[0], "expected nodes from the fixture repo"
        assert first[1], "expected rels from the fixture repo"

        # The multi-candidate Go import resolves to the lexicographically
        # smallest file in the package dir — stable across runs (the old
        # full scan picked in set-iteration order, i.e. per-process random).
        imports_rels = [r for r in first[1] if r[1] == "IMPORTS" and r[3] == "fixrepo/cmd/main.go"]
        assert [r[4] for r in imports_rels] == ["fixrepo/pkg/util/extra.go"]

        # Re-index over the existing data (no wipe): cross-batch node dedup
        # drops everything, the rel-id DELETE reinserts every edge once.
        self._index_once(graph_store, str(fixture_repo))
        assert _dump_graph(graph_store) == first

        # Wipe and re-index: exercises the mirror invalidation in delete_repo.
        graph_store.delete_repo("fixrepo")
        self._index_once(graph_store, str(fixture_repo))
        assert _dump_graph(graph_store) == first
