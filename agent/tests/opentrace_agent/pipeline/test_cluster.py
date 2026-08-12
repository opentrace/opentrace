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

"""Tests for the clustering module — pure detection + store round-trip."""

from __future__ import annotations

import pytest

nx = pytest.importorskip("networkx")
ladybug = pytest.importorskip("real_ladybug")

from opentrace_agent.pipeline.cluster import (  # noqa: E402
    Cluster,
    _cohesion,
    build_graph_from_store,
    detect_clusters,
    run_clustering,
)
from opentrace_agent.retrieval.clusters import list_clusters  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402

# ---------------------------------------------------------------------------
# Pure detection
# ---------------------------------------------------------------------------


class TestDetectClusters:
    def test_empty_graph(self):
        assert detect_clusters(nx.Graph()) == []

    def test_two_disjoint_cliques_split_into_two(self):
        g = nx.Graph()
        # Clique A: 5 fully-connected nodes
        for i in range(5):
            for j in range(i + 1, 5):
                g.add_edge(f"a{i}", f"a{j}")
        # Clique B: 5 fully-connected nodes
        for i in range(5):
            for j in range(i + 1, 5):
                g.add_edge(f"b{i}", f"b{j}")
        clusters = detect_clusters(g)
        # Expect two clusters, each grouping its clique members.
        assert len(clusters) == 2
        sizes = sorted(len(c.members) for c in clusters)
        assert sizes == [5, 5]
        for c in clusters:
            # Members of each cluster must share the same prefix.
            prefixes = {m[0] for m in c.members}
            assert len(prefixes) == 1

    def test_single_clique_has_high_cohesion(self):
        g = nx.complete_graph(6)
        clusters = detect_clusters(g)
        # Single complete graph → one cluster, cohesion 1.0
        assert len(clusters) == 1
        assert clusters[0].cohesion == pytest.approx(1.0)

    def test_god_flag_marks_largest(self):
        g = nx.Graph()
        # Two cliques of different sizes.
        for i in range(8):
            for j in range(i + 1, 8):
                g.add_edge(f"big{i}", f"big{j}")
        for i in range(3):
            for j in range(i + 1, 3):
                g.add_edge(f"small{i}", f"small{j}")
        clusters = detect_clusters(g)
        gods = [c for c in clusters if c.is_god]
        assert gods, "expected at least one god cluster"
        assert all(len(g.members) >= 3 for g in gods)

    def test_disconnected_singletons_become_own_clusters(self):
        g = nx.Graph()
        for i in range(5):
            g.add_node(f"iso{i}")
        clusters = detect_clusters(g)
        # Each isolated node is its own cluster.
        assert sum(len(c.members) for c in clusters) == 5


class TestCohesion:
    def test_complete_graph_cohesion_one(self):
        g = nx.complete_graph(5)
        # Nodes are 0..4 — pass them as a list.
        assert _cohesion(g, list(range(5))) == pytest.approx(1.0)

    def test_path_graph_cohesion_low(self):
        g = nx.path_graph(10)
        # 9 edges, max possible = 45, cohesion ≈ 0.2
        assert _cohesion(g, list(range(10))) == pytest.approx(9 / 45)

    def test_singleton_cohesion_zero(self):
        g = nx.Graph()
        g.add_node("x")
        assert _cohesion(g, ["x"]) == 0.0


# ---------------------------------------------------------------------------
# Store integration
# ---------------------------------------------------------------------------


@pytest.fixture()
def store(tmp_path):
    db_path = str(tmp_path / "testdb")
    s = GraphStore(db_path)
    yield s
    s.close()


def _seed_two_clusters(store: GraphStore) -> None:
    """Two disjoint 4-cliques connected by a single bridge edge."""
    for i in range(4):
        store.add_node(f"a{i}", "Function", f"a{i}")
        store.add_node(f"b{i}", "Function", f"b{i}")
    rel_id = 0
    for i in range(4):
        for j in range(i + 1, 4):
            store.add_relationship(f"ra{rel_id}", "CALLS", f"a{i}", f"a{j}")
            rel_id += 1
            store.add_relationship(f"rb{rel_id}", "CALLS", f"b{i}", f"b{j}")
            rel_id += 1
    store.add_relationship("rbridge", "CALLS", "a0", "b0")


class TestStoreRoundTrip:
    def test_build_graph_from_store_excludes_internal(self, store):
        _seed_two_clusters(store)
        store.save_metadata({"repoId": "r", "indexedAt": "2026-01-01T00:00:00Z"})
        g = build_graph_from_store(store)
        assert g.number_of_nodes() == 8

    def test_run_clustering_writes_clusters(self, store):
        _seed_two_clusters(store)
        report = run_clustering(store)
        assert report.nodes == 8
        assert report.clusters >= 2
        clusters = list_clusters(store)
        assert len(clusters) == report.clusters
        # Verify membership: each non-internal node has a cluster.
        for prefix in ("a", "b"):
            for i in range(4):
                c = store.get_node_cluster(f"{prefix}{i}")
                assert c is not None, f"missing cluster for {prefix}{i}"

    def test_clustering_adds_no_nodes_or_edges(self, store):
        """The partition is metadata, so it must not grow the graph.

        This is the property the Community-node model could not hold: it added
        a node per cluster and an edge per member, which inflated every
        census and degree count taken afterwards.
        """
        _seed_two_clusters(store)
        before = store.get_stats()
        run_clustering(store)
        after = store.get_stats()
        assert after["total_nodes"] == before["total_nodes"]
        assert after["total_edges"] == before["total_edges"]
        assert "Community" not in after["nodes_by_type"]

    def test_clustering_is_idempotent(self, store):
        _seed_two_clusters(store)
        first = run_clustering(store)
        second = run_clustering(store)
        # Re-running must not accumulate clusters or stale assignments.
        assert first.clusters == second.clusters
        clusters = list_clusters(store)
        assert len(clusters) == second.clusters

    def test_clear_clusters_removes_assignments(self, store):
        _seed_two_clusters(store)
        run_clustering(store)
        assert list_clusters(store)
        store.clear_clusters()
        assert list_clusters(store) == []
        assert store.get_node_cluster("a0") is None

    def test_clear_clusters_preserves_the_nodes(self, store):
        """Clearing drops the property, never the member it was stamped on."""
        _seed_two_clusters(store)
        run_clustering(store)
        store.clear_clusters()
        assert store.get_stats()["total_nodes"] == 8
        assert store.get_node("a0") is not None

    def test_disjoint_components_assigned_distinct_clusters(self, store):
        # Two cliques with NO bridge edge between them.
        for i in range(4):
            store.add_node(f"a{i}", "Function", f"a{i}")
            store.add_node(f"b{i}", "Function", f"b{i}")
        rel_id = 0
        for prefix in ("a", "b"):
            for i in range(4):
                for j in range(i + 1, 4):
                    store.add_relationship(f"r{rel_id}", "CALLS", f"{prefix}{i}", f"{prefix}{j}")
                    rel_id += 1
        run_clustering(store)
        ca = store.get_node_cluster("a0")
        cb = store.get_node_cluster("b0")
        assert ca is not None and cb is not None
        assert ca != cb

    def test_empty_graph_returns_zeroes(self, store):
        report = run_clustering(store)
        assert report.nodes == 0
        assert report.clusters == 0

    def test_legacy_community_nodes_are_swept_before_partitioning(self, store):
        """A DB from the old node-based model must not cluster its own output.

        Communities were briefly stored as nodes plus MEMBER_OF_COMMUNITY
        edges. To a reader those are ordinary nodes, so without a sweep the
        partition would take clustering's previous output as input — and the
        run would report a node count inflated by it.
        """
        _seed_two_clusters(store)
        store.add_node("_comm:0", "Community", "legacy", {"community_id": 0, "members": 8})
        for prefix in ("a", "b"):
            for i in range(4):
                store.add_relationship(f"_mem:{prefix}{i}", "MEMBER_OF_COMMUNITY", f"{prefix}{i}", "_comm:0")
        assert store.get_stats()["total_nodes"] == 9

        report = run_clustering(store)

        # The run partitions the 8 real nodes, not the 9 it found on disk.
        assert report.nodes == 8
        stats = store.get_stats()
        assert stats["total_nodes"] == 8
        assert "Community" not in stats["nodes_by_type"]
        assert store.get_node("_comm:0") is None


# ---------------------------------------------------------------------------
# Smoke: Cluster dataclass invariants
# ---------------------------------------------------------------------------


def test_cluster_is_immutable():
    c = Cluster(id=0, members=("a", "b"), cohesion=0.5, is_god=True)
    with pytest.raises(Exception):
        c.id = 1  # type: ignore[misc]
