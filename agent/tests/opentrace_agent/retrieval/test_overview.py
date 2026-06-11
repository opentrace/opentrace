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

"""Tests for OT-1749 emergent-structure surface on the overview response."""

from __future__ import annotations

import pytest

ladybug = pytest.importorskip("real_ladybug")

from opentrace_agent.retrieval import overview  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    s = GraphStore(str(tmp_path / "overviewdb"))
    yield s
    s.close()


def _seed_centrality(store: GraphStore) -> None:
    """Two vaults with hand-tuned LINKS_TO + CITES topology.

    kb:
      hub (concept)         — central, linked by everyone else
      core (concept)        — links to hub, summary-spec
      satellite (concept)   — links to hub only
      lonely (concept)      — no edges
      summary-spec (file_summary)   — cited by hub + core (2 citations)
      summary-misc (file_summary)   — cited by core only (1 citation)
      summary-cluster (file_summary) — cited by no one
    other:
      page-x (concept) — minimal, used to verify vault-scope filtering
    """
    pages_kb = [
        ("hub", "Hub", "concept"),
        ("core", "Core", "concept"),
        ("satellite", "Satellite", "concept"),
        ("lonely", "Lonely", "concept"),
        ("summary-spec", "spec.pdf", "file_summary"),
        ("summary-misc", "misc.pdf", "file_summary"),
        ("summary-cluster", "cluster.pdf", "file_summary"),
    ]
    for slug, name, kind in pages_kb:
        store.add_node(
            f"kb::{slug}",
            "WikiPage",
            name,
            {"kind": kind, "vault": "kb", "one_line_summary": f"Summary for {name}"},
        )

    store.add_node(
        "other::page-x",
        "WikiPage",
        "Other Page",
        {"kind": "concept", "vault": "other", "one_line_summary": "Not in scope"},
    )

    edges = [
        # LINKS_TO — hub is the most-connected concept. Edges touching hub:
        # l1 (in), l2 (in), l3 (out), l5 (in) = degree 4. Core touches l1/l3/l4
        # = degree 3, so hub leads unambiguously.
        ("l1", "LINKS_TO", "core", "hub"),
        ("l2", "LINKS_TO", "satellite", "hub"),
        ("l3", "LINKS_TO", "hub", "core"),
        ("l4", "LINKS_TO", "core", "summary-spec"),
        ("l5", "LINKS_TO", "summary-spec", "hub"),
        # CITES — summary-spec is the most-cited source (2), summary-misc has 1
        ("c1", "CITES", "hub", "summary-spec"),
        ("c2", "CITES", "core", "summary-spec"),
        ("c3", "CITES", "core", "summary-misc"),
    ]
    for eid, etype, src, tgt in edges:
        src_id = f"kb::{src}" if src != "other" else src
        tgt_id = f"kb::{tgt}" if tgt != "other" else tgt
        store.add_relationship(eid, etype, src_id, tgt_id)


class TestTopLinkedConcepts:
    def test_hub_ranks_first(self, store):
        _seed_centrality(store)
        result = overview(store, top_n=10, vault_scope="kb")
        ranked = result["top_linked_concepts"]
        assert ranked, "expected at least one entry"
        assert ranked[0]["name"] == "Hub"
        # Hub touches 4 LINKS_TO edges (l1/l2/l5 incoming, l3 outgoing).
        assert ranked[0]["degree"] == 4

    def test_lonely_excluded(self, store):
        _seed_centrality(store)
        result = overview(store, top_n=10, vault_scope="kb")
        names = [r["name"] for r in result["top_linked_concepts"]]
        assert "Lonely" not in names

    def test_vault_scope_filters_other_vault(self, store):
        _seed_centrality(store)
        result = overview(store, top_n=10, vault_scope="kb")
        for r in result["top_linked_concepts"]:
            assert r["vault"] == "kb"

    def test_only_concepts(self, store):
        _seed_centrality(store)
        result = overview(store, top_n=10, vault_scope="kb")
        # file-summary pages must not appear in the concept ranking.
        assert "spec.pdf" not in [r["name"] for r in result["top_linked_concepts"]]


class TestTopCitedSources:
    def test_most_cited_ranks_first(self, store):
        _seed_centrality(store)
        result = overview(store, top_n=10, vault_scope="kb")
        ranked = result["top_cited_sources"]
        assert ranked[0]["name"] == "spec.pdf"
        assert ranked[0]["citation_count"] == 2
        assert ranked[1]["name"] == "misc.pdf"
        assert ranked[1]["citation_count"] == 1

    def test_uncited_excluded(self, store):
        _seed_centrality(store)
        result = overview(store, top_n=10, vault_scope="kb")
        names = [r["name"] for r in result["top_cited_sources"]]
        assert "cluster.pdf" not in names

    def test_only_file_summaries(self, store):
        _seed_centrality(store)
        result = overview(store, top_n=10, vault_scope="kb")
        # Concept pages must not appear here even when they're CITES targets
        # (they aren't in this fixture, but the invariant is worth pinning).
        for r in result["top_cited_sources"]:
            assert r["name"].endswith(".pdf")


class TestClusterSizes:
    def test_empty_when_no_cluster_ids(self, store):
        _seed_centrality(store)
        # No cluster_id stamps in the fixture.
        result = overview(store, top_n=10, vault_scope="kb")
        assert result["cluster_sizes"] == {}

    def test_counts_pages_by_cluster_id(self, store):
        # Stamp cluster_id manually to verify aggregation.
        for slug, cluster in [("hub", 0), ("core", 0), ("satellite", 0), ("lonely", 1)]:
            store.add_node(
                f"kb::{slug}",
                "WikiPage",
                slug,
                {"kind": "concept", "vault": "kb", "cluster_id": cluster},
            )
        result = overview(store, top_n=5, vault_scope="kb")
        assert result["cluster_sizes"] == {"0": 3, "1": 1}

    def test_vault_scope_filters(self, store):
        store.add_node("kb::a", "WikiPage", "a", {"kind": "concept", "vault": "kb", "cluster_id": 0})
        store.add_node("other::a", "WikiPage", "a", {"kind": "concept", "vault": "other", "cluster_id": 0})
        result = overview(store, top_n=5, vault_scope="kb")
        assert result["cluster_sizes"] == {"0": 1}


class TestUnscopedResponseShape:
    def test_new_fields_present(self, store):
        _seed_centrality(store)
        result = overview(store, top_n=5)
        for key in ("top_linked_concepts", "top_cited_sources", "cluster_sizes"):
            assert key in result
