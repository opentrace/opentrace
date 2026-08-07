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

"""Tests for the OT-1732 retrieval primitives.

The fixture seeds a small mixed code/wiki graph so each test exercises the
function against realistic-shape data without needing the full pipeline.
"""

from __future__ import annotations

import pytest

ladybug = pytest.importorskip("real_ladybug")

from opentrace_agent.retrieval import (  # noqa: E402
    count_by,
    find_orphans,
    find_path,
    find_via_relationship_to_type,
    search,
)
from opentrace_agent.store import GraphStore  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    db_path = str(tmp_path / "retrievaldb")
    s = GraphStore(db_path)
    yield s
    s.close()


def _seed(store: GraphStore) -> None:
    """A small graph spanning code + wiki domains.

    Code side:
        repo -CONTAINS-> file -CONTAINS-> fn-handle -CALLS-> fn-query
        repo -CONTAINS-> file -CONTAINS-> fn-orphan   (no callers)

    Wiki side (documents linked by their authors' own relative links):
        vault -CONTAINS-> doc-report
        vault -CONTAINS-> doc-guide
        vault -CONTAINS-> doc-orphan   (no LINKS_TO from anyone)
        doc-guide -LINKS_TO-> doc-orphan
    """
    # Code
    store.add_node("repo-1", "Repository", "myrepo", {})
    store.add_node("file-1", "File", "main.py", {})
    store.add_node("fn-handle", "Function", "handle", {})
    store.add_node("fn-query", "Function", "query", {})
    store.add_node("fn-orphan", "Function", "orphan_helper", {})
    store.add_relationship("c1", "CONTAINS", "repo-1", "file-1")
    store.add_relationship("c2", "CONTAINS", "file-1", "fn-handle")
    store.add_relationship("c3", "CONTAINS", "file-1", "fn-query")
    store.add_relationship("c4", "CONTAINS", "file-1", "fn-orphan")
    store.add_relationship("c5", "CALLS", "fn-handle", "fn-query")

    # Wiki
    store.add_node("vault-1", "KnowledgeVault", "knowledge", {"vault": "knowledge"})
    store.add_node("doc-report", "KnowledgeDoc", "report.pdf", {"sha256": "report-sha", "filename": "report.pdf"})
    store.add_node("doc-guide", "KnowledgeDoc", "guide.md", {"sha256": "guide-sha", "filename": "guide.md"})
    store.add_node("doc-orphan", "KnowledgeDoc", "notes.md", {"sha256": "notes-sha", "filename": "notes.md"})
    store.add_relationship("w1", "CONTAINS", "vault-1", "doc-report")
    store.add_relationship("w2", "CONTAINS", "vault-1", "doc-guide")
    store.add_relationship("w3", "CONTAINS", "vault-1", "doc-orphan")
    store.add_relationship("w4", "LINKS_TO", "doc-guide", "doc-orphan")


# ---------------------------------------------------------------------------
# find_path
# ---------------------------------------------------------------------------


class TestFindPath:
    def test_direct_neighbor(self, store):
        _seed(store)
        result = find_path(store, "fn-handle", "fn-query", max_hops=2)
        assert result["length"] == 1
        assert [step["node"]["id"] for step in result["path"]] == ["fn-handle", "fn-query"]
        assert result["path"][0]["relationship"] is None
        assert result["path"][1]["relationship"]["type"] == "CALLS"

    def test_multi_hop(self, store):
        _seed(store)
        # repo-1 -CONTAINS-> file-1 -CONTAINS-> fn-query is 2 hops.
        result = find_path(store, "repo-1", "fn-query", max_hops=3)
        assert result["length"] == 2
        ids = [s["node"]["id"] for s in result["path"]]
        assert ids == ["repo-1", "file-1", "fn-query"]

    def test_no_path_within_hops(self, store):
        _seed(store)
        result = find_path(store, "fn-query", "fn-handle", max_hops=3)
        # outgoing-only walk; no edge from fn-query → fn-handle
        assert result["path"] is None
        assert result["length"] is None

    def test_same_start_and_end(self, store):
        _seed(store)
        result = find_path(store, "repo-1", "repo-1")
        assert result["length"] == 0
        assert len(result["path"]) == 1
        assert result["path"][0]["node"]["id"] == "repo-1"

    def test_edge_type_filter_blocks_path(self, store):
        _seed(store)
        # Only allow CALLS — repo→file is CONTAINS, so path is unreachable.
        result = find_path(store, "repo-1", "fn-query", max_hops=5, edge_types=["CALLS"])
        assert result["path"] is None

    def test_edge_type_filter_allows_path(self, store):
        _seed(store)
        result = find_path(store, "fn-handle", "fn-query", edge_types=["CALLS"])
        assert result["length"] == 1

    def test_missing_start(self, store):
        _seed(store)
        result = find_path(store, "missing", "repo-1")
        assert result["path"] is None
        assert "start node not found" in result["error"]

    def test_missing_end(self, store):
        _seed(store)
        result = find_path(store, "repo-1", "missing")
        assert result["path"] is None
        assert "end node not found" in result["error"]


# ---------------------------------------------------------------------------
# find_via_relationship_to_type
# ---------------------------------------------------------------------------


class TestFindViaRelationshipToType:
    def test_basic(self, store):
        _seed(store)
        result = find_via_relationship_to_type(store, "Function", "CALLS", "Function")
        assert result["count"] == 1
        pair = result["pairs"][0]
        assert pair["start"]["id"] == "fn-handle"
        assert pair["target"]["id"] == "fn-query"

    def test_no_matches(self, store):
        _seed(store)
        result = find_via_relationship_to_type(store, "Function", "LINKS_TO", "Function")
        assert result["count"] == 0
        assert result["pairs"] == []

    def test_wiki_links(self, store):
        """Doc→doc ``LINKS_TO`` — the authors' own relative markdown links.

        This used to query ``KnowledgeConcept``, a node type removed with the
        concept-page layer, so it passed vacuously against an empty result.
        """
        _seed(store)
        result = find_via_relationship_to_type(store, "KnowledgeDoc", "LINKS_TO", "KnowledgeDoc")
        assert result["count"] == 1
        assert result["pairs"][0]["start"]["id"] == "doc-guide"
        assert result["pairs"][0]["target"]["id"] == "doc-orphan"

    def test_limit_caps_results(self, store):
        for i in range(5):
            store.add_node(f"a{i}", "Function", f"a{i}")
            store.add_node(f"b{i}", "Function", f"b{i}")
            store.add_relationship(f"r{i}", "CALLS", f"a{i}", f"b{i}")
        result = find_via_relationship_to_type(store, "Function", "CALLS", "Function", limit=3)
        assert result["count"] == 3


# ---------------------------------------------------------------------------
# find_orphans
# ---------------------------------------------------------------------------


class TestFindOrphans:
    def test_incoming_calls(self, store):
        _seed(store)
        # fn-handle, fn-query, fn-orphan all exist; only fn-query has an
        # incoming CALLS edge. fn-handle and fn-orphan are orphans.
        result = find_orphans(store, "Function", "CALLS", direction="incoming")
        ids = sorted(o["id"] for o in result["orphans"])
        assert ids == ["fn-handle", "fn-orphan"]
        assert result["count"] == 2

    def test_outgoing_calls(self, store):
        _seed(store)
        # Only fn-handle has an outgoing CALLS edge.
        result = find_orphans(store, "Function", "CALLS", direction="outgoing")
        ids = sorted(o["id"] for o in result["orphans"])
        assert ids == ["fn-orphan", "fn-query"]

    def test_both_directions(self, store):
        _seed(store)
        # Only fn-orphan has neither incoming nor outgoing CALLS.
        result = find_orphans(store, "Function", "CALLS", direction="both")
        ids = [o["id"] for o in result["orphans"]]
        assert ids == ["fn-orphan"]

    def test_docs_with_no_inbound_links(self, store):
        """Documents nobody cross-references. ``doc-orphan`` is linked FROM
        ``doc-guide``, so the un-referenced ones are report + guide."""
        _seed(store)
        result = find_orphans(store, "KnowledgeDoc", "LINKS_TO", direction="incoming")
        ids = sorted(o["id"] for o in result["orphans"])
        assert ids == ["doc-guide", "doc-report"]

    def test_no_candidates(self, store):
        _seed(store)
        result = find_orphans(store, "Database", "CALLS")
        assert result["orphans"] == []
        assert result["count"] == 0

    def test_invalid_direction_raises(self, store):
        with pytest.raises(ValueError, match="invalid direction"):
            find_orphans(store, "Function", "CALLS", direction="sideways")


# ---------------------------------------------------------------------------
# count_by
# ---------------------------------------------------------------------------


class TestCountBy:
    def test_global_count(self, store):
        _seed(store)
        result = count_by(store, "Function")
        assert result["count"] == 3
        assert result["scope"] == "global"

    def test_global_count_unknown_type(self, store):
        _seed(store)
        result = count_by(store, "DoesNotExist")
        assert result["count"] == 0

    def test_scoped_to_parent(self, store):
        _seed(store)
        result = count_by(store, "Function", parent_id="repo-1", parent_edge="CONTAINS", max_hops=2)
        # repo-1 -CONTAINS-> file-1 -CONTAINS-> {fn-handle, fn-query, fn-orphan}
        assert result["count"] == 3
        assert result["scope"] == "descendants_of:repo-1"

    def test_scoped_with_insufficient_hops(self, store):
        _seed(store)
        result = count_by(store, "Function", parent_id="repo-1", parent_edge="CONTAINS", max_hops=1)
        # 1 hop only reaches file-1, which is type File not Function.
        assert result["count"] == 0

    def test_scoped_to_vault(self, store):
        _seed(store)
        result = count_by(store, "KnowledgeDoc", parent_id="vault-1", parent_edge="CONTAINS", max_hops=1)
        assert result["count"] == 3

    def test_missing_parent(self, store):
        _seed(store)
        result = count_by(store, "Function", parent_id="missing")
        assert result["count"] == 0
        assert "parent node not found" in result["error"]


class TestDocFileTwinCollapse:
    """A document indexed with docs exists twice — as the File the code walk saw
    and as the KnowledgeDoc the doc pass created — and both are FTS-indexed, so
    one document could take two result slots.

    Measured on a 25-doc index before this collapse: 8 of 12 queries returned
    the same document twice in the top 5, and the File outranked its own
    KnowledgeDoc in 15 of 22 pairs (BM25 length normalisation — the File's
    short search_text beats the KnowledgeDoc's identical tokens *plus* a gloss).
    """

    @staticmethod
    def _twinned(store, *, mirrored: bool = True):
        """One document as both File and KnowledgeDoc, optionally MIRRORS-joined."""
        store.add_node(
            "corpus::sha-cx",
            "KnowledgeDoc",
            "browser-requirements.md",
            {
                "sha256": "sha-cx",
                "filename": "browser-requirements.md",
                "path": "docs/browser-requirements.md",
                "summary": "cross-origin isolation requirements for the browser build",
            },
        )
        store.add_node(
            "repo/docs/browser-requirements.md",
            "File",
            "browser-requirements.md",
            {"path": "docs/browser-requirements.md"},
        )
        if mirrored:
            store.add_relationship("mir-cx", "MIRRORS", "corpus::sha-cx", "repo/docs/browser-requirements.md")

    def test_pair_collapses_to_the_knowledge_doc(self, store):
        from opentrace_agent.retrieval import search

        self._twinned(store)
        hits = search(store, "cross-origin isolation browser requirements", limit=10)["hits"]
        ids = [h["id"] for h in hits]
        assert "corpus::sha-cx" in ids
        assert "repo/docs/browser-requirements.md" not in ids  # slot freed
        doc = next(h for h in hits if h["id"] == "corpus::sha-cx")
        # The File twin stays reachable in one hop.
        assert doc["fileTwin"] == "repo/docs/browser-requirements.md"

    def test_untwinned_file_and_doc_both_survive(self, store):
        """Without a MIRRORS edge they're unrelated nodes — never merge them."""
        from opentrace_agent.retrieval import search

        self._twinned(store, mirrored=False)
        hits = search(store, "cross-origin isolation browser requirements", limit=10)["hits"]
        ids = [h["id"] for h in hits]
        assert "corpus::sha-cx" in ids
        assert "repo/docs/browser-requirements.md" in ids

    def test_collapse_frees_a_slot_before_truncation(self, store):
        """Collapsing after the cut would free nothing — that's the whole point."""
        from opentrace_agent.retrieval import search

        self._twinned(store)
        # A third, weaker match that should be pulled in by the freed slot.
        store.add_node(
            "corpus::sha-tr",
            "KnowledgeDoc",
            "troubleshooting.md",
            {"sha256": "sha-tr", "filename": "troubleshooting.md", "summary": "browser isolation errors"},
        )
        hits = search(store, "cross-origin isolation browser requirements", limit=2)["hits"]
        assert len(hits) == 2
        ids = [h["id"] for h in hits]
        # The freed slot went to the OTHER document, not to the twin File.
        assert "repo/docs/browser-requirements.md" not in ids
        assert set(ids) == {"corpus::sha-cx", "corpus::sha-tr"}

    def test_doc_gets_file_twin_even_when_twin_not_in_results(self, store):
        """The annotation is useful regardless of whether the File also matched."""
        from opentrace_agent.retrieval import search

        self._twinned(store)
        hits = search(store, "cross-origin isolation", limit=10, node_types=["KnowledgeDoc"])["hits"]
        doc = next(h for h in hits if h["id"] == "corpus::sha-cx")
        assert doc["fileTwin"] == "repo/docs/browser-requirements.md"


class TestSearchTriageFields:
    """KnowledgeDoc hits carry their navigation label inline — title, status,
    one-liner, path — so an agent picks which docs to open from the results
    alone instead of paying a load_source round-trip per hit."""

    @staticmethod
    def _doc(store, *, one_liner: str = "How authentication works."):
        store.add_node(
            "corpus::sha-tf",
            "KnowledgeDoc",
            "auth-guide.md",
            {
                "sha256": "sha-tf",
                "title": "Auth Guide",
                "status": "authoritative",
                "one_line_summary": one_liner,
                "summary": one_liner,
                "path": "docs/auth-guide.md",
            },
        )

    def test_doc_hit_carries_triage_fields(self, store):
        from opentrace_agent.retrieval import search

        self._doc(store)
        hits = search(store, "authentication guide", limit=10)["hits"]
        doc = next(h for h in hits if h["id"] == "corpus::sha-tf")
        assert doc["title"] == "Auth Guide"
        assert doc["status"] == "authoritative"
        assert doc["one_line_summary"] == "How authentication works."
        assert doc["path"] == "docs/auth-guide.md"

    def test_gloss_truncated_to_compact_width(self, store):
        from opentrace_agent.retrieval import search
        from opentrace_agent.retrieval.search import _TRIAGE_GLOSS_CHARS

        long = "authentication " + "x" * 300
        self._doc(store, one_liner=long)
        hits = search(store, "authentication guide", limit=10)["hits"]
        doc = next(h for h in hits if h["id"] == "corpus::sha-tf")
        assert len(doc["one_line_summary"]) == _TRIAGE_GLOSS_CHARS
        assert doc["one_line_summary"].endswith("…")

    def test_code_hits_stay_lean(self, store):
        """Only KnowledgeDoc hits grow the label fields."""
        from opentrace_agent.retrieval import search

        _seed(store)
        hits = search(store, "handle", limit=10)["hits"]
        fn = next(h for h in hits if h["id"] == "fn-handle")
        assert "title" not in fn and "status" not in fn


class TestLegacyEntityNodesStayReadable:
    """The LLM-extracted entity layer was removed 2026-08-04 and nothing writes
    these node types any more, but a graph built before then still contains
    them — search must keep returning them rather than filtering them out.
    (`search` briefly had an ``exclude_llm_entities`` flag for the crowding
    problem; the layer that caused it is gone, so the flag is too.)"""

    @staticmethod
    def _seed(store):
        store.add_node(
            "ent::engram",
            "Idea",
            "engram",
            {"derived_from": "corpus::sha-en", "description": "the engram project"},
        )
        store.add_node(
            "corpus::sha-en",
            "KnowledgeDoc",
            "engram-overview.md",
            {"sha256": "sha-en", "title": "Engram Overview", "summary": "engram overview of the project"},
        )
        # A runtime Service node — same type namespace, no derived_from/vault.
        store.add_node("svc::engram-api", "Service", "engram-api", {})

    def test_legacy_entities_and_runtime_nodes_both_surface(self, store):
        from opentrace_agent.retrieval import search

        self._seed(store)
        result = search(store, "engram", limit=10)
        ids = {h["id"] for h in result["hits"]}
        assert {"ent::engram", "svc::engram-api", "corpus::sha-en"} <= ids
        assert "entities_excluded" not in result

    def test_type_filter_still_reaches_them(self, store):
        from opentrace_agent.retrieval import search

        self._seed(store)
        result = search(store, "engram", limit=10, node_types=["Idea"])
        assert {h["id"] for h in result["hits"]} == {"ent::engram"}


class TestVaultScopedSearch:
    """``vaultScope`` is advertised on the MCP ``search_graph`` tool, but had no
    test at all — and it was broken: it filtered hits on a ``vault`` property
    that a KnowledgeDoc never carries, so scoping a search to a vault returned
    nothing and an agent concluded the vault was empty. Membership is the
    ``CONTAINS`` edge (``GraphStore.vault_member_ids``).
    """

    @staticmethod
    def _seed(store):
        store.add_node("vault::kb", "KnowledgeVault", "kb", {"vault": "kb"})
        store.add_node("vault::other", "KnowledgeVault", "other", {"vault": "other"})
        store.add_node(
            "corpus::a",
            "KnowledgeDoc",
            "retry-policy.md",
            {"sha256": "a", "title": "Retry policy", "summary": "retry policy for the gateway"},
        )
        store.add_node(
            "corpus::b",
            "KnowledgeDoc",
            "retry-notes.md",
            {"sha256": "b", "title": "Retry notes", "summary": "retry policy notes elsewhere"},
        )
        store.add_relationship("c-a", "CONTAINS", "vault::kb", "corpus::a")
        store.add_relationship("c-b", "CONTAINS", "vault::other", "corpus::b")

    def test_scoped_search_returns_the_vaults_document(self, store):
        self._seed(store)
        ids = {h["id"] for h in search(store, "retry", limit=10, vault_scope="kb")["hits"]}
        assert "corpus::a" in ids, "scoped search must reach the vault's documents"
        assert "corpus::b" not in ids

    def test_unscoped_search_sees_both(self, store):
        self._seed(store)
        ids = {h["id"] for h in search(store, "retry", limit=10)["hits"]}
        assert {"corpus::a", "corpus::b"} <= ids

    def test_unknown_scope_returns_nothing(self, store):
        self._seed(store)
        assert search(store, "retry", limit=10, vault_scope="ghost")["hits"] == []


class TestFindPathTruncation:
    """``find_path`` must distinguish "no path exists" from "I stopped looking".

    Both used to return ``{"path": None, "length": None}``, so the CLI's
    "a path exists but is longer than N hops" branch was unreachable and the
    user was told *No path between those nodes* when one existed just beyond
    the hop limit. A failed search is not evidence of absence.
    """

    @staticmethod
    def _seed(store):
        for n in ("a", "b", "c"):
            store.add_node(n, "Function", n)
        store.add_node("island", "Function", "island")
        store.add_relationship("ab", "CALLS", "a", "b")
        store.add_relationship("bc", "CALLS", "b", "c")

    def test_truncated_when_path_is_beyond_the_hop_limit(self, store):
        self._seed(store)
        result = find_path(store, "a", "c", max_hops=1)
        assert result["path"] is None
        assert result["truncated"] is True

    def test_not_truncated_when_no_path_can_exist(self, store):
        self._seed(store)
        result = find_path(store, "a", "island", max_hops=6)
        assert result["path"] is None
        assert result["truncated"] is False

    def test_found_path_within_the_limit(self, store):
        self._seed(store)
        result = find_path(store, "a", "c", max_hops=3)
        assert [s["node"]["id"] for s in result["path"]] == ["a", "b", "c"]
        assert result["length"] == 2
