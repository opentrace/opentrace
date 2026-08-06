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

"""Tests for the ``overview`` orientation response.

This file used to cover OT-1749's emergent-structure surface —
``top_linked_concepts``, ``top_cited_sources``, and ``cluster_sizes``. All
three ranked ``KnowledgeConcept`` nodes or counted ``CITES`` edges, so all
three returned empty from the moment nothing produced concept pages; they were
removed with the rest of that layer on 2026-08-04. What is left is the surface
that works over documents.
"""

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


def _seed(store: GraphStore) -> None:
    """Two vaults of documents joined by their authors' own ``LINKS_TO`` links.

    Degrees below INCLUDE each doc's ``CONTAINS`` edge from its vault, because
    that is what the ranking counts:

    kb:
      corpus::hub    — 5: CONTAINS, in from core + leaf, out to core + leaf
      corpus::core   — 4: CONTAINS, out to hub + leaf, in from hub
      corpus::leaf   — 4: CONTAINS, out to hub, in from core + hub
      corpus::lonely — 1: CONTAINS only
    other:
      corpus::offscope — used to verify vault-scope filtering

    ``hub`` must stay the STRICTLY highest-degree document. It used to tie with
    ``core`` at 4, and ``ORDER BY degree DESC`` breaks ties arbitrarily, so
    ``top_concepts[0]`` flipped between them and the ranking test failed
    intermittently. Don't equalise these degrees again.
    """
    store.add_node("vault::kb", "KnowledgeVault", "kb", {"vault": "kb"})
    store.add_node("vault::other", "KnowledgeVault", "other", {"vault": "other"})

    for sid, fname in [
        ("hub", "hub.md"),
        ("core", "core.md"),
        ("leaf", "leaf.md"),
        ("lonely", "lonely.md"),
    ]:
        store.add_node(
            f"corpus::{sid}",
            "KnowledgeDoc",
            fname,
            {"sha256": sid, "filename": fname, "one_line_summary": f"Summary for {fname}"},
        )
        store.add_relationship(f"contains-{sid}", "CONTAINS", "vault::kb", f"corpus::{sid}")

    store.add_node("corpus::offscope", "KnowledgeDoc", "offscope.md", {"sha256": "offscope"})
    store.add_relationship("contains-offscope", "CONTAINS", "vault::other", "corpus::offscope")

    for eid, src, tgt in [
        ("l1", "corpus::core", "corpus::hub"),
        ("l2", "corpus::leaf", "corpus::hub"),
        ("l3", "corpus::hub", "corpus::core"),
        ("l4", "corpus::core", "corpus::leaf"),
        # Breaks the hub/core degree tie — see the docstring.
        ("l5", "corpus::hub", "corpus::leaf"),
    ]:
        store.add_relationship(eid, "LINKS_TO", src, tgt)


class TestUnscopedShape:
    def test_returns_the_documented_keys_and_nothing_page_shaped(self, store):
        _seed(store)
        result = overview(store, top_n=5)
        assert set(result) == {
            "counts_by_type",
            "top_concepts",
            "recently_updated",
            "vault_scope",
        }
        assert result["vault_scope"] is None

    def test_counts_by_type_covers_the_doc_layer(self, store):
        _seed(store)
        counts = overview(store, top_n=5)["counts_by_type"]
        assert counts["KnowledgeDoc"] == 5
        assert counts["KnowledgeVault"] == 2
        assert "KnowledgeConcept" not in counts

    def test_top_concepts_ranks_the_hub_document_above_its_peers(self, store):
        """Assert the top *document*, not the top node: ``vault::kb`` has degree
        4 (one CONTAINS per member) and would otherwise compete for the first
        slot. ``hub`` is seeded as the strictly highest-degree document so this
        cannot depend on how ``ORDER BY degree DESC`` breaks a tie."""
        _seed(store)
        ranked = overview(store, top_n=10)["top_concepts"]
        docs = [r["name"] for r in ranked if r["type"] == "KnowledgeDoc"]
        assert docs, "expected at least one KnowledgeDoc entry"
        assert docs[0] == "hub.md"

    def test_ranking_is_by_degree_descending(self, store):
        """``lonely.md`` has only its vault's CONTAINS edge, so it ranks below
        every document its author cross-referenced."""
        _seed(store)
        ranked = overview(store, top_n=10)["top_concepts"]
        by_name = {r["name"]: r["degree"] for r in ranked}
        assert by_name["hub.md"] > by_name["lonely.md"]
        assert [r["degree"] for r in ranked] == sorted((r["degree"] for r in ranked), reverse=True)


class TestVaultScope:
    def test_scope_includes_the_vaults_documents(self, store):
        """The scope must reach DOCUMENTS, not just the vault node.

        Membership is the CONTAINS edge; a KnowledgeDoc carries no ``vault``
        property. A property-equality filter here matched only ``vault::kb``
        and reported an empty vault, so assert the document count exactly —
        a subset assertion passes either way and cannot catch the regression.
        """
        _seed(store)
        result = overview(store, top_n=10, vault_scope="kb")
        assert result["vault_scope"] == "kb"
        assert result["counts_by_type"] == {"KnowledgeVault": 1, "KnowledgeDoc": 4}
        names = {c["name"] for c in result["top_concepts"]}
        assert {"hub.md", "core.md", "leaf.md", "lonely.md"} <= names
        assert "offscope.md" not in names

    def test_scope_excludes_the_other_vaults_documents(self, store):
        _seed(store)
        result = overview(store, top_n=10, vault_scope="other")
        assert result["counts_by_type"] == {"KnowledgeVault": 1, "KnowledgeDoc": 1}
        assert {c["name"] for c in result["top_concepts"]} == {"other", "offscope.md"}

    def test_unknown_scope_is_empty_not_unscoped(self, store):
        """A typo'd vault name must return nothing, never the whole graph —
        silently dropping the filter would be worse than an empty result."""
        _seed(store)
        result = overview(store, top_n=10, vault_scope="nope")
        assert result["counts_by_type"] == {}
        assert result["top_concepts"] == []

    def test_scoped_response_has_the_same_keys(self, store):
        _seed(store)
        assert set(overview(store, top_n=5, vault_scope="kb")) == set(overview(store, top_n=5))


class TestPageSectionsStayRemoved:
    """``top_linked_concepts`` / ``top_cited_sources`` / ``cluster_sizes`` must
    not come back. Each was empty by construction once nothing wrote a
    ``KnowledgeConcept`` node or a ``CITES`` edge, and ``overview`` is the
    agent's first tool call — an always-empty section in a <500-token budget
    spends the orientation payload saying nothing."""

    @pytest.mark.parametrize("vault_scope", [None, "kb"])
    def test_absent_from_both_response_shapes(self, store, vault_scope):
        _seed(store)
        result = overview(store, top_n=5, vault_scope=vault_scope)
        for gone in ("top_linked_concepts", "top_cited_sources", "cluster_sizes"):
            assert gone not in result

    def test_helpers_are_gone_from_the_module(self):
        from opentrace_agent.retrieval import overview as overview_mod

        for gone in ("_top_linked_concepts", "_top_cited_sources", "_cluster_sizes"):
            assert not hasattr(overview_mod, gone)
