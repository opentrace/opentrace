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

"""Tests for the OT-1732 Phase 4 vault → graph writer."""

from __future__ import annotations

import pytest

from opentrace_agent.wiki.ingest.graph_writer import parse_wiki_links

# ---------------------------------------------------------------------------
# Pure parser tests (no DB required)
# ---------------------------------------------------------------------------


class TestParseWikiLinks:
    def test_simple_links(self):
        body = "See [[Foo]] and also [[Bar]]."
        assert parse_wiki_links(body) == ["Foo", "Bar"]

    def test_dedup(self):
        body = "[[Foo]] mentions [[Foo]] again."
        assert parse_wiki_links(body) == ["Foo"]

    def test_alias_form(self):
        # Obsidian-style [[Target|displayed text]]
        body = "Read [[Real Title|click here]] for details."
        assert parse_wiki_links(body) == ["Real Title"]

    def test_source_summary_form(self):
        body = "Cited in [[Source Summary: Q4 Report]] and [[Concept A]]."
        assert parse_wiki_links(body) == [
            "Source Summary: Q4 Report",
            "Concept A",
        ]

    def test_strips_whitespace(self):
        assert parse_wiki_links("[[ Foo ]]") == ["Foo"]

    def test_no_links(self):
        assert parse_wiki_links("plain text without brackets") == []

    def test_unmatched_brackets(self):
        # Single brackets shouldn't be picked up.
        assert parse_wiki_links("[Foo] is not a wiki link") == []

    def test_empty_target_skipped(self):
        # `[[]]` — empty target after stripping — must not match.
        assert parse_wiki_links("[[]]") == []


# ---------------------------------------------------------------------------
# Integrated graph-write tests (require real_ladybug)
# ---------------------------------------------------------------------------

ladybug = pytest.importorskip("real_ladybug")

from opentrace_agent.store import GraphStore  # noqa: E402
from opentrace_agent.wiki.ingest.graph_writer import (  # noqa: E402
    NODE_TYPE_SOURCE,
    NODE_TYPE_WIKI_PAGE,
    NODE_TYPE_WIKI_VAULT,
    REL_TYPE_CITES,
    REL_TYPE_CONTAINS,
    REL_TYPE_LINKS_TO,
    delete_vault_from_graph,
    page_node_id,
    source_node_id,
    vault_node_id,
    write_vault_to_graph,
)
from opentrace_agent.wiki.vault import IngestedSource, PageMeta, VaultMetadata  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    db_path = str(tmp_path / "vaultgraphdb")
    s = GraphStore(db_path)
    yield s
    s.close()


def _make_meta() -> tuple[VaultMetadata, dict[str, str]]:
    """Two sources, two source-summary pages, one concept page that links + cites."""
    meta = VaultMetadata.empty(name="kb")
    meta.last_compiled_at = "2026-05-01T00:00:00+00:00"

    meta.sources = {
        "sha1": IngestedSource(sha256="sha1", original_name="report.pdf", ingested_at="2026-05-01T00:00:00"),
        "sha2": IngestedSource(sha256="sha2", original_name="memo.docx", ingested_at="2026-05-01T00:00:00"),
    }
    meta.pages = {
        "source-summary-report-pdf": PageMeta(
            slug="source-summary-report-pdf",
            title="report.pdf",
            one_line_summary="Q4 financial report summary.",
            source_shas=["sha1"],
            last_updated="2026-05-01T00:00:00",
            revision=1,
            kind="source_summary",
        ),
        "source-summary-memo-docx": PageMeta(
            slug="source-summary-memo-docx",
            title="memo.docx",
            one_line_summary="Internal memo from finance.",
            source_shas=["sha2"],
            last_updated="2026-05-01T00:00:00",
            revision=1,
            kind="source_summary",
        ),
        "revenue": PageMeta(
            slug="revenue",
            title="Revenue",
            one_line_summary="Aggregated revenue topic.",
            source_shas=["sha1", "sha2"],
            last_updated="2026-05-01T00:00:00",
            revision=1,
            kind="concept",
        ),
    }
    page_bodies = {
        "source-summary-report-pdf": "Summary of report.pdf — see [[Revenue]].",
        "source-summary-memo-docx": "Summary of memo.docx — see [[Revenue]].",
        "revenue": ("Combined view of revenue across [[report.pdf]] and [[memo.docx]]."),
    }
    return meta, page_bodies


class TestWriteVaultToGraph:
    def test_writes_vault_node(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        node = store.get_node(vault_node_id("kb"))
        assert node is not None
        assert node["type"] == NODE_TYPE_WIKI_VAULT
        assert node["properties"]["vault"] == "kb"

    def test_writes_source_nodes(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        sources = store.list_nodes(NODE_TYPE_SOURCE)
        shas = {s["properties"]["sha256"] for s in sources}
        assert shas == {"sha1", "sha2"}

    def test_writes_page_nodes(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        pages = store.list_nodes(NODE_TYPE_WIKI_PAGE)
        slugs = {p["properties"]["slug"] for p in pages}
        assert slugs == {"source-summary-report-pdf", "source-summary-memo-docx", "revenue"}
        for p in pages:
            assert p["properties"]["vault"] == "kb"

    def test_vault_contains_pages_and_sources(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        children = store.traverse(
            vault_node_id("kb"),
            direction="outgoing",
            max_depth=1,
            relationship_type=REL_TYPE_CONTAINS,
        )
        types = {c["node"]["type"] for c in children}
        assert NODE_TYPE_WIKI_PAGE in types
        assert NODE_TYPE_SOURCE in types
        # 2 sources + 3 pages = 5 children
        assert len(children) == 5

    def test_source_summary_cites_source(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        ss_id = page_node_id("kb", "source-summary-report-pdf")
        cited = store.traverse(
            ss_id,
            direction="outgoing",
            max_depth=1,
            relationship_type=REL_TYPE_CITES,
        )
        target_ids = {c["node"]["id"] for c in cited}
        assert source_node_id("sha1") in target_ids

    def test_concept_cites_source_summaries(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        revenue_id = page_node_id("kb", "revenue")
        cited = store.traverse(
            revenue_id,
            direction="outgoing",
            max_depth=1,
            relationship_type=REL_TYPE_CITES,
        )
        target_slugs = {c["node"]["properties"]["slug"] for c in cited}
        assert "source-summary-report-pdf" in target_slugs
        assert "source-summary-memo-docx" in target_slugs

    def test_links_to_resolves_titles(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        # source-summary-report-pdf body links to [[Revenue]]
        ss_id = page_node_id("kb", "source-summary-report-pdf")
        outgoing = store.traverse(
            ss_id,
            direction="outgoing",
            max_depth=1,
            relationship_type=REL_TYPE_LINKS_TO,
        )
        targets = {o["node"]["properties"]["slug"] for o in outgoing}
        assert "revenue" in targets

    def test_idempotent_rewrite(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        write_vault_to_graph(store, meta, bodies)  # second pass shouldn't dupe
        # Three pages, no duplicates.
        pages = store.list_nodes(NODE_TYPE_WIKI_PAGE)
        slugs = [p["properties"]["slug"] for p in pages]
        assert sorted(slugs) == sorted(set(slugs))


class TestDeleteVaultFromGraph:
    def test_removes_only_named_vault_nodes(self, store):
        # Seed two vaults with disjoint sources.
        meta_kb, bodies_kb = _make_meta()
        write_vault_to_graph(store, meta_kb, bodies_kb)

        meta_other = VaultMetadata.empty(name="other")
        meta_other.last_compiled_at = "2026-05-02T00:00:00+00:00"
        meta_other.sources = {
            "shaX": IngestedSource(sha256="shaX", original_name="x.pdf", ingested_at="2026-05-02T00:00:00"),
        }
        meta_other.pages = {
            "source-summary-x-pdf": PageMeta(
                slug="source-summary-x-pdf",
                title="x.pdf",
                one_line_summary="X.",
                source_shas=["shaX"],
                last_updated="2026-05-02T00:00:00",
                revision=1,
                kind="source_summary",
            ),
        }
        write_vault_to_graph(store, meta_other, {"source-summary-x-pdf": "x"})

        # Delete the kb vault from the graph.
        result = delete_vault_from_graph(store, "kb")
        # 1 vault + 3 pages + 2 sources for kb = 6 nodes.
        assert result["nodes_deleted"] == 6

        # kb vault is gone.
        assert store.get_node(vault_node_id("kb")) is None
        assert store.get_node(page_node_id("kb", "revenue")) is None
        assert store.get_node(source_node_id("sha1")) is None

        # other vault is intact.
        assert store.get_node(vault_node_id("other")) is not None
        assert store.get_node(source_node_id("shaX")) is not None

    def test_shared_source_survives_when_other_vault_still_uses_it(self, store):
        """Two vaults ingest the same source file (same sha256). Deleting one
        vault must NOT delete the shared Source node — the other vault still
        depends on it via its CONTAINS + CITES edges."""
        meta_a, bodies_a = _make_meta()  # uses sha1 + sha2
        write_vault_to_graph(store, meta_a, bodies_a)

        # Vault B: re-ingests sha1 (the shared source).
        meta_b = VaultMetadata.empty(name="b")
        meta_b.last_compiled_at = "2026-05-02T00:00:00+00:00"
        meta_b.sources = {
            "sha1": IngestedSource(sha256="sha1", original_name="report.pdf", ingested_at="2026-05-02T00:00:00"),
        }
        meta_b.pages = {
            "source-summary-report-pdf": PageMeta(
                slug="source-summary-report-pdf",
                title="report.pdf",
                one_line_summary="Same source, different vault.",
                source_shas=["sha1"],
                last_updated="2026-05-02T00:00:00",
                revision=1,
                kind="source_summary",
            ),
        }
        write_vault_to_graph(store, meta_b, {"source-summary-report-pdf": "in vault b"})

        # Source nodes don't carry a `vault` property — vault membership is
        # graph-edge based.
        sha1_node = store.get_node(source_node_id("sha1"))
        assert sha1_node is not None
        assert "vault" not in (sha1_node.get("properties") or {})

        # Delete vault A. Only sha2 (which only A used) should be removed;
        # sha1 must survive because vault B still references it.
        delete_vault_from_graph(store, "kb")
        assert store.get_node(source_node_id("sha1")) is not None, (
            "shared source must survive when another vault still references it"
        )
        assert store.get_node(source_node_id("sha2")) is None

        # Now delete vault B too — sha1 should now go.
        delete_vault_from_graph(store, "b")
        assert store.get_node(source_node_id("sha1")) is None

    def test_idempotent_when_vault_absent(self, store):
        result = delete_vault_from_graph(store, "nonexistent")
        assert result["nodes_deleted"] == 0

    def test_does_not_touch_code_nodes(self, store):
        # Code Repository node co-existing with vault content.
        store.add_node("repo-1", "Repository", "myrepo", {})
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        delete_vault_from_graph(store, "kb")
        # We only ever delete WikiVault / WikiPage / Source by id or by
        # vault property — code nodes are out of scope.
        assert store.get_node("repo-1") is not None
