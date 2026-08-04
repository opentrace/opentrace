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

from opentrace_agent.wiki.ingest.graph_writer import parse_doc_links, parse_wiki_links

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

    def test_multiple_kinded_targets(self):
        body = "Cited in [[concept/Q4 Report]] and [[Concept A]]."
        assert parse_wiki_links(body) == [
            "concept/Q4 Report",
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


class TestParseDocLinks:
    """The authors' own relative links — the doc-side analogue of imports."""

    def test_inline_markdown_links(self):
        body = "See [the guide](./guide.md) and [the spec](../specs/api.md)."
        assert parse_doc_links(body) == ["./guide.md", "../specs/api.md"]

    def test_strips_fragment_and_query(self):
        body = "[setup](guide.md#setup) and [again](guide.md?raw=1)"
        assert parse_doc_links(body) == ["guide.md"]

    def test_skips_external_and_anchor_only(self):
        body = "[web](https://example.com/x.md) [mail](mailto:a@b.c) [top](#intro) [proto](//cdn/x.md)"
        assert parse_doc_links(body) == []

    def test_reference_style_definition(self):
        body = 'Read [the guide][g].\n\n[g]: docs/guide.md "The Guide"\n'
        assert parse_doc_links(body) == ["docs/guide.md"]

    def test_html_anchor(self):
        assert parse_doc_links('<a href="notes/design.html">design</a>') == ["notes/design.html"]

    def test_angle_bracket_and_percent_escape(self):
        assert parse_doc_links("[x](<my doc.md>)") == ["my doc.md"]
        assert parse_doc_links("[x](my%20doc.md)") == ["my doc.md"]

    def test_title_attribute_not_captured(self):
        assert parse_doc_links('[x](guide.md "A Title")') == ["guide.md"]

    def test_no_links(self):
        assert parse_doc_links("plain prose, no links at all") == []


# ---------------------------------------------------------------------------
# Integrated graph-write tests (require real_ladybug)
# ---------------------------------------------------------------------------

ladybug = pytest.importorskip("real_ladybug")

from opentrace_agent.store import GraphStore  # noqa: E402
from opentrace_agent.wiki.ingest.graph_writer import (  # noqa: E402
    NODE_TYPE_KNOWLEDGE_CONCEPT,
    NODE_TYPE_KNOWLEDGE_DOC,
    NODE_TYPE_KNOWLEDGE_VAULT,
    REL_TYPE_CITES,
    REL_TYPE_CONTAINS,
    REL_TYPE_DOCUMENTS,
    REL_TYPE_LINKS_TO,
    REL_TYPE_MIRRORS,
    corpus_doc_node_id,
    delete_vault_from_graph,
    link_corpus_doc_mirrors,
    link_doc_to_doc_links,
    link_vault_to_repo,
    page_node_id,
    stamp_doc_paths,
    vault_node_id,
    write_vault_to_graph,
)
from opentrace_agent.wiki.ingest.types import NormalizedSource  # noqa: E402
from opentrace_agent.wiki.vault import IngestedSource, PageMeta, VaultMetadata  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    db_path = str(tmp_path / "vaultgraphdb")
    s = GraphStore(db_path)
    yield s
    s.close()


def _make_meta() -> tuple[VaultMetadata, dict[str, str]]:
    """Two sources, two concept pages that cite them and link each other."""
    meta = VaultMetadata.empty(name="kb")
    meta.last_compiled_at = "2026-05-01T00:00:00+00:00"

    meta.sources = {
        "sha1": IngestedSource(sha256="sha1", original_name="report.pdf", ingested_at="2026-05-01T00:00:00"),
        "sha2": IngestedSource(sha256="sha2", original_name="memo.docx", ingested_at="2026-05-01T00:00:00"),
    }
    meta.pages = {
        "concept/revenue": PageMeta(
            slug="concept/revenue",
            title="Revenue",
            one_line_summary="Aggregated revenue topic.",
            source_shas=["sha1", "sha2"],
            last_updated="2026-05-01T00:00:00",
            revision=1,
            kind="concept",
        ),
        "concept/costs": PageMeta(
            slug="concept/costs",
            title="Costs",
            one_line_summary="Cost structure topic.",
            source_shas=["sha1"],
            last_updated="2026-05-01T00:00:00",
            revision=1,
            kind="concept",
        ),
    }
    page_bodies = {
        "concept/revenue": "Combined view of revenue. Related: [[Costs]].",
        "concept/costs": "Cost breakdown. Related: [[Revenue]].",
    }
    return meta, page_bodies


def _normalized() -> list[NormalizedSource]:
    return [
        NormalizedSource(
            sha256="sha1",
            original_name="report.pdf",
            markdown="# Report\nQuarterly revenue report.",
            corpus_path="corpus/sha1.md",
            title="Report",
            one_line_summary="Q4 financial report.",
        ),
        NormalizedSource(
            sha256="sha2",
            original_name="memo.docx",
            markdown="# Memo\nInternal memo from finance.",
            corpus_path="corpus/sha2.md",
            title="Memo",
            one_line_summary="Internal memo from finance.",
        ),
    ]


class TestWriteVaultToGraph:
    def test_writes_vault_node(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        node = store.get_node(vault_node_id("kb"))
        assert node is not None
        assert node["type"] == NODE_TYPE_KNOWLEDGE_VAULT
        assert node["properties"]["vault"] == "kb"

    def test_writes_source_nodes(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        sources = store.list_nodes(NODE_TYPE_KNOWLEDGE_DOC)
        shas = {s["properties"]["sha256"] for s in sources}
        assert shas == {"sha1", "sha2"}

    def test_source_labels_stamped_from_normalized(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies, normalized=_normalized())
        node = store.get_node(corpus_doc_node_id("sha1"))
        props = node["properties"]
        assert props["title"] == "Report"
        assert props["one_line_summary"] == "Q4 financial report."
        # `summary` mirrors the one-liner so build_search_text FTS-indexes it.
        assert props["summary"] == "Q4 financial report."

    def test_source_labels_survive_remirror_without_normalized(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies, normalized=_normalized())
        # Re-mirror (e.g. vault attach / backfill) without NormalizedSources.
        write_vault_to_graph(store, meta, bodies)
        props = store.get_node(corpus_doc_node_id("sha1"))["properties"]
        assert props["title"] == "Report"
        assert props["one_line_summary"] == "Q4 financial report."
        assert props["corpus_path"] == "corpus/sha1.md"

    def test_writes_page_nodes(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        pages = store.list_nodes(NODE_TYPE_KNOWLEDGE_CONCEPT)
        slugs = {p["properties"]["slug"] for p in pages}
        assert slugs == {"concept/revenue", "concept/costs"}
        for p in pages:
            assert p["properties"]["vault"] == "kb"

    def test_page_one_liner_is_fts_indexed(self, store):
        # A KnowledgeConcept must be findable by its gloss, not just its title:
        # build_search_text reads ``one_line_summary`` directly, so topic
        # queries reach the page instead of only matching code symbols by name.
        from opentrace_agent.store.graph_store import build_search_text

        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        node = store.get_node(page_node_id("kb", "concept/revenue"))
        props = node["properties"]
        assert props["one_line_summary"] == "Aggregated revenue topic."
        search_text = build_search_text(node["name"], node["type"], props)
        assert "Aggregated revenue topic." in search_text

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
        assert NODE_TYPE_KNOWLEDGE_CONCEPT in types
        assert NODE_TYPE_KNOWLEDGE_DOC in types
        # 2 sources + 2 pages = 4 children
        assert len(children) == 4

    def test_concept_cites_sources_directly(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        revenue_id = page_node_id("kb", "concept/revenue")
        cited = store.traverse(
            revenue_id,
            direction="outgoing",
            max_depth=1,
            relationship_type=REL_TYPE_CITES,
        )
        target_ids = {c["node"]["id"] for c in cited}
        assert target_ids == {corpus_doc_node_id("sha1"), corpus_doc_node_id("sha2")}
        # Every CITES target is a Source — no intermediate summary pages.
        assert all(c["node"]["type"] == NODE_TYPE_KNOWLEDGE_DOC for c in cited)

    def test_links_to_resolves_titles(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        # concept/revenue body links to [[Costs]]
        revenue_id = page_node_id("kb", "concept/revenue")
        outgoing = store.traverse(
            revenue_id,
            direction="outgoing",
            max_depth=1,
            relationship_type=REL_TYPE_LINKS_TO,
        )
        targets = {o["node"]["properties"]["slug"] for o in outgoing}
        assert "concept/costs" in targets

    def test_idempotent_rewrite(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        write_vault_to_graph(store, meta, bodies)  # second pass shouldn't dupe
        pages = store.list_nodes(NODE_TYPE_KNOWLEDGE_CONCEPT)
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
            "concept/x": PageMeta(
                slug="concept/x",
                title="X",
                one_line_summary="X.",
                source_shas=["shaX"],
                last_updated="2026-05-02T00:00:00",
                revision=1,
                kind="concept",
            ),
        }
        write_vault_to_graph(store, meta_other, {"concept/x": "x"})

        # Delete the kb vault from the graph.
        result = delete_vault_from_graph(store, "kb")
        # 1 vault + 2 pages + 2 sources for kb = 5 nodes.
        assert result["nodes_deleted"] == 5

        # kb vault is gone.
        assert store.get_node(vault_node_id("kb")) is None
        assert store.get_node(page_node_id("kb", "concept/revenue")) is None
        assert store.get_node(corpus_doc_node_id("sha1")) is None

        # other vault is intact.
        assert store.get_node(vault_node_id("other")) is not None
        assert store.get_node(corpus_doc_node_id("shaX")) is not None

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
            "concept/reporting": PageMeta(
                slug="concept/reporting",
                title="Reporting",
                one_line_summary="Same source, different vault.",
                source_shas=["sha1"],
                last_updated="2026-05-02T00:00:00",
                revision=1,
                kind="concept",
            ),
        }
        write_vault_to_graph(store, meta_b, {"concept/reporting": "in vault b"})

        # Source nodes don't carry a `vault` property — vault membership is
        # graph-edge based.
        sha1_node = store.get_node(corpus_doc_node_id("sha1"))
        assert sha1_node is not None
        assert "vault" not in (sha1_node.get("properties") or {})

        # Delete vault A. Only sha2 (which only A used) should be removed;
        # sha1 must survive because vault B still references it.
        delete_vault_from_graph(store, "kb")
        assert store.get_node(corpus_doc_node_id("sha1")) is not None, (
            "shared source must survive when another vault still references it"
        )
        assert store.get_node(corpus_doc_node_id("sha2")) is None

        # Now delete vault B too — sha1 should now go.
        delete_vault_from_graph(store, "b")
        assert store.get_node(corpus_doc_node_id("sha1")) is None

    def test_idempotent_when_vault_absent(self, store):
        result = delete_vault_from_graph(store, "nonexistent")
        assert result["nodes_deleted"] == 0

    def test_does_not_touch_code_nodes(self, store):
        # Code Repository node co-existing with vault content.
        store.add_node("repo-1", "Repository", "myrepo", {})
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        delete_vault_from_graph(store, "kb")
        # We only ever delete Vault / Page / Source by id or by
        # vault property — code nodes are out of scope.
        assert store.get_node("repo-1") is not None


class TestStampDocPaths:
    """Path/status stamping WITHOUT File twins — the `vault ingest` half of
    what link_corpus_doc_mirrors does for repo walks."""

    def _seed(self, store, body: bytes = b"# Doc\nbody\n"):
        import hashlib

        sha = hashlib.sha256(body).hexdigest()
        store.add_node(corpus_doc_node_id(sha), NODE_TYPE_KNOWLEDGE_DOC, "doc.md", {"sha256": sha})
        return body, sha

    def test_stamps_path_and_status_but_no_file_or_mirrors(self, store):
        body, sha = self._seed(store)
        assert stamp_doc_paths(store, [("docs/guide.md", body)]) == 1
        props = store.get_node(corpus_doc_node_id(sha))["properties"]
        assert props["path"] == "docs/guide.md"
        assert props["status"] == "authoritative"
        assert props["sha256"] == sha  # existing props preserved
        mirrors = store.traverse(
            corpus_doc_node_id(sha), direction="outgoing", max_depth=1, relationship_type=REL_TYPE_MIRRORS
        )
        assert mirrors == []
        assert store.list_nodes("File") == []

    def test_status_override_beats_path_heuristic(self, store):
        body, sha = self._seed(store)
        stamp_doc_paths(store, [("docs/guide.md", body)], status_override="design_history")
        props = store.get_node(corpus_doc_node_id(sha))["properties"]
        assert props["status"] == "design_history"

    def test_duplicate_content_primary_is_most_current(self, store):
        body, sha = self._seed(store)
        stamp_doc_paths(
            store,
            [("openspec/changes/archive/2026-04-27-audit/spec.md", body), ("openspec/changes/audit/spec.md", body)],
        )
        props = store.get_node(corpus_doc_node_id(sha))["properties"]
        assert props["path"] == "openspec/changes/audit/spec.md"
        assert props["status"] == "design_history"
        assert props["paths"] == sorted(
            ["openspec/changes/archive/2026-04-27-audit/spec.md", "openspec/changes/audit/spec.md"]
        )

    def test_content_gated_blob_skipped(self, store):
        # Bytes were content-gated — no KnowledgeDoc node exists.
        assert stamp_doc_paths(store, [("readme.md", b"# hi")]) == 0

    def test_returns_changed_count_so_second_call_is_zero(self, store):
        body, _ = self._seed(store)
        assert stamp_doc_paths(store, [("docs/guide.md", body)]) == 1
        assert stamp_doc_paths(store, [("docs/guide.md", body)]) == 0


class TestLinkCorpusDocMirrors:
    def _seed_twins(self, store):
        """A CorpusDoc and its File twin, plus a PDF with no File node."""
        import hashlib

        md_bytes = b"# Usage\ndocs body"
        pdf_bytes = b"%PDF-fake"
        md_sha = hashlib.sha256(md_bytes).hexdigest()
        pdf_sha = hashlib.sha256(pdf_bytes).hexdigest()
        store.add_node(corpus_doc_node_id(md_sha), NODE_TYPE_KNOWLEDGE_DOC, "usage.md", {"sha256": md_sha})
        store.add_node(corpus_doc_node_id(pdf_sha), NODE_TYPE_KNOWLEDGE_DOC, "spec.pdf", {"sha256": pdf_sha})
        store.add_node("myrepo/docs/usage.md", "File", "usage.md", {"path": "docs/usage.md"})
        return md_bytes, pdf_bytes, md_sha

    def test_links_twin_and_stamps_path(self, store):
        md_bytes, pdf_bytes, md_sha = self._seed_twins(store)
        linked = link_corpus_doc_mirrors(store, "myrepo", [("docs/usage.md", md_bytes), ("docs/spec.pdf", pdf_bytes)])
        assert linked == 2  # PDF's missing File twin is created on the fly

        outgoing = store.traverse(
            corpus_doc_node_id(md_sha), direction="outgoing", max_depth=1, relationship_type=REL_TYPE_MIRRORS
        )
        assert [r["node"]["id"] for r in outgoing] == ["myrepo/docs/usage.md"]
        props = store.get_node(corpus_doc_node_id(md_sha))["properties"]
        assert props["path"] == "docs/usage.md"
        assert props["sha256"] == md_sha  # existing props preserved

    def test_creates_file_twin_when_code_walk_skipped_it(self, store):
        """Docs outside INCLUDED_EXTENSIONS (.rst/.pdf/...) get a File node created."""
        import hashlib

        rst_bytes = b"Quickstart\n==========\nbody"
        rst_sha = hashlib.sha256(rst_bytes).hexdigest()
        store.add_node(corpus_doc_node_id(rst_sha), NODE_TYPE_KNOWLEDGE_DOC, "quickstart.rst", {"sha256": rst_sha})
        # Parent Directory exists from the code walk (it always does — the
        # walker creates Directory nodes for every non-excluded dir).
        store.add_node("myrepo/docs", "Directory", "docs", {"path": "docs"})

        linked = link_corpus_doc_mirrors(store, "myrepo", [("docs/quickstart.rst", rst_bytes)])
        assert linked == 1

        file_node = store.get_node("myrepo/docs/quickstart.rst")
        assert file_node is not None
        assert file_node["type"] == "File"
        assert file_node["properties"]["path"] == "docs/quickstart.rst"
        assert file_node["properties"]["extension"] == ".rst"
        # Hangs off its parent dir like walker-created File nodes.
        children = store.traverse("myrepo/docs", direction="outgoing", max_depth=1, relationship_type="DEFINES")
        assert "myrepo/docs/quickstart.rst" in [r["node"]["id"] for r in children]
        # And the MIRRORS edge points at it.
        mirrors = store.traverse(
            corpus_doc_node_id(rst_sha), direction="outgoing", max_depth=1, relationship_type=REL_TYPE_MIRRORS
        )
        assert [r["node"]["id"] for r in mirrors] == ["myrepo/docs/quickstart.rst"]
        assert store.get_node(corpus_doc_node_id(rst_sha))["properties"]["path"] == "docs/quickstart.rst"

    def test_creates_missing_ancestor_directories(self, store):
        import hashlib

        data = b"deep doc"
        sha = hashlib.sha256(data).hexdigest()
        store.add_node(corpus_doc_node_id(sha), NODE_TYPE_KNOWLEDGE_DOC, "notes.txt", {"sha256": sha})

        assert link_corpus_doc_mirrors(store, "myrepo", [("docs/guide/notes.txt", data)]) == 1

        assert store.get_node("myrepo/docs")["type"] == "Directory"
        assert store.get_node("myrepo/docs/guide")["type"] == "Directory"
        chain = store.traverse("myrepo/docs", direction="outgoing", max_depth=2, relationship_type="DEFINES")
        ids = [r["node"]["id"] for r in chain]
        assert "myrepo/docs/guide" in ids
        assert "myrepo/docs/guide/notes.txt" in ids

    def test_idempotent(self, store):
        md_bytes, pdf_bytes, md_sha = self._seed_twins(store)
        blobs = [("docs/usage.md", md_bytes)]
        link_corpus_doc_mirrors(store, "myrepo", blobs)
        link_corpus_doc_mirrors(store, "myrepo", blobs)
        outgoing = store.traverse(
            corpus_doc_node_id(md_sha), direction="outgoing", max_depth=1, relationship_type=REL_TYPE_MIRRORS
        )
        assert len(outgoing) == 1

    def test_missing_corpus_doc_skipped(self, store):
        store.add_node("myrepo/readme.md", "File", "readme.md", {"path": "readme.md"})
        # Bytes were content-gated — no CorpusDoc node exists.
        assert link_corpus_doc_mirrors(store, "myrepo", [("readme.md", b"# hi")]) == 0

    def test_path_survives_remirror(self, store):
        """A vault re-mirror (write_vault_to_graph) must not wipe the stamped path."""
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies, normalized=_normalized())
        # Stamp path via the mirror linker (sha1's raw bytes unknown here, so
        # stamp directly through the same read-modify-write shape).
        node = store.get_node(corpus_doc_node_id("sha1"))
        props = dict(node["properties"])
        props["path"] = "docs/report.pdf"
        store.add_node(corpus_doc_node_id("sha1"), NODE_TYPE_KNOWLEDGE_DOC, node["name"], props)

        write_vault_to_graph(store, meta, bodies)  # re-mirror without normalized
        assert store.get_node(corpus_doc_node_id("sha1"))["properties"]["path"] == "docs/report.pdf"


class TestLinkVaultToRepo:
    def _seed(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        store.add_node("myrepo", "Repository", "myrepo", {})

    def test_links_and_stamps_spawned_from(self, store):
        self._seed(store)
        assert link_vault_to_repo(store, "myrepo", "kb") is True

        out = store.traverse("myrepo", direction="outgoing", max_depth=1, relationship_type=REL_TYPE_DOCUMENTS)
        assert [r["node"]["id"] for r in out] == [vault_node_id("kb")]
        assert store.get_node(vault_node_id("kb"))["properties"]["spawned_from"] == "myrepo"

    def test_missing_repo_or_vault_skipped(self, store):
        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)
        # No Repository node — e.g. a wiki compile against an empty index.
        assert link_vault_to_repo(store, "myrepo", "kb") is False
        store.add_node("myrepo", "Repository", "myrepo", {})
        assert link_vault_to_repo(store, "myrepo", "nonexistent") is False
        out = store.traverse("myrepo", direction="outgoing", max_depth=1, relationship_type=REL_TYPE_DOCUMENTS)
        assert out == []

    def test_idempotent(self, store):
        self._seed(store)
        link_vault_to_repo(store, "myrepo", "kb")
        link_vault_to_repo(store, "myrepo", "kb")
        out = store.traverse("myrepo", direction="outgoing", max_depth=1, relationship_type=REL_TYPE_DOCUMENTS)
        assert len(out) == 1

    def test_spawned_from_survives_remirror(self, store):
        """Re-mirrors that skip the linker (refresh-stale-pages, backfill)
        must carry the stamp forward rather than wiping it."""
        self._seed(store)
        link_vault_to_repo(store, "myrepo", "kb")

        meta, bodies = _make_meta()
        write_vault_to_graph(store, meta, bodies)  # plain re-mirror
        assert store.get_node(vault_node_id("kb"))["properties"]["spawned_from"] == "myrepo"


class TestLinkDocToDocLinks:
    """``KnowledgeDoc -LINKS_TO-> KnowledgeDoc`` from authors' own references."""

    @staticmethod
    def _seed(store, files: dict[str, bytes]) -> dict[str, str]:
        """Create a KnowledgeDoc node per file. Returns {rel_path: sha}."""
        import hashlib

        shas = {}
        for rel_path, data in files.items():
            sha = hashlib.sha256(data).hexdigest()
            shas[rel_path] = sha
            store.add_node(
                corpus_doc_node_id(sha),
                NODE_TYPE_KNOWLEDGE_DOC,
                rel_path.rsplit("/", 1)[-1],
                {"sha256": sha},
            )
        return shas

    def _targets(self, store, sha):
        out = store.traverse(
            corpus_doc_node_id(sha), direction="outgoing", max_depth=1, relationship_type=REL_TYPE_LINKS_TO
        )
        return sorted(r["node"]["id"] for r in out)

    def test_relative_link_resolved_against_linking_doc_dir(self, store):
        files = {
            "docs/index.md": b"Start at [the guide](guide.md), then [the API](../api/spec.md).",
            "docs/guide.md": b"# Guide",
            "api/spec.md": b"# Spec",
        }
        shas = self._seed(store, files)
        assert link_doc_to_doc_links(store, list(files.items())) == 2
        assert self._targets(store, shas["docs/index.md"]) == sorted(
            [corpus_doc_node_id(shas["docs/guide.md"]), corpus_doc_node_id(shas["api/spec.md"])]
        )

    def test_repo_root_relative_link(self, store):
        files = {"docs/index.md": b"See [spec](/api/spec.md).", "api/spec.md": b"# Spec"}
        shas = self._seed(store, files)
        assert link_doc_to_doc_links(store, list(files.items())) == 1
        assert self._targets(store, shas["docs/index.md"]) == [corpus_doc_node_id(shas["api/spec.md"])]

    def test_link_to_non_doc_is_skipped(self, store):
        """Resolution is the filter — a link to code or an image finds no KnowledgeDoc."""
        files = {
            "docs/index.md": b"See [the code](../src/app.py) and ![shot](img/x.png).",
            "docs/guide.md": b"# Guide",
        }
        self._seed(store, files)
        assert link_doc_to_doc_links(store, list(files.items())) == 0

    def test_external_links_ignored(self, store):
        files = {"README.md": b"[site](https://example.com) [mail](mailto:x@y.z)", "docs/guide.md": b"# Guide"}
        self._seed(store, files)
        assert link_doc_to_doc_links(store, list(files.items())) == 0

    def test_self_link_and_duplicate_spellings_deduped(self, store):
        files = {
            "docs/index.md": b"[self](index.md) [a](guide.md) [b](./guide.md) [c](guide.md#top)",
            "docs/guide.md": b"# Guide",
        }
        shas = self._seed(store, files)
        # One edge only: self-link dropped, three spellings of guide.md collapse.
        assert link_doc_to_doc_links(store, list(files.items())) == 1
        assert self._targets(store, shas["docs/index.md"]) == [corpus_doc_node_id(shas["docs/guide.md"])]

    def test_escaping_repo_root_dropped(self, store):
        files = {"docs/index.md": b"[outside](../../secrets.md)", "docs/guide.md": b"# Guide"}
        self._seed(store, files)
        assert link_doc_to_doc_links(store, list(files.items())) == 0

    def test_content_gated_doc_skipped(self, store):
        """A blob with no KnowledgeDoc node (dropped by the content gate) is not a target."""
        files = {"docs/index.md": b"[empty](empty.md)", "docs/empty.md": b""}
        self._seed(store, {"docs/index.md": files["docs/index.md"]})  # only index gets a node
        assert link_doc_to_doc_links(store, list(files.items())) == 0

    def test_idempotent(self, store):
        files = {"docs/index.md": b"[g](guide.md)", "docs/guide.md": b"# Guide"}
        shas = self._seed(store, files)
        link_doc_to_doc_links(store, list(files.items()))
        link_doc_to_doc_links(store, list(files.items()))
        assert len(self._targets(store, shas["docs/index.md"])) == 1


class TestDuplicateContentStamping:
    """Byte-identical files share ONE KnowledgeDoc (content-addressed id).

    Stamping `path` per blob let the LAST writer win, so a node could carry an
    archived path while its `status` came from the live one — the two
    disagreed, and that made a transcript unreadable: it looked like an agent
    had opened a superseded spec when the graph simply had one node for both.
    """

    def _seed(self, store, body: bytes):
        import hashlib

        sha = hashlib.sha256(body).hexdigest()
        store.add_node(corpus_doc_node_id(sha), NODE_TYPE_KNOWLEDGE_DOC, "spec.md", {"sha256": sha})
        return sha

    def test_live_copy_wins_and_status_agrees(self, store):
        body = b"# Spec\nidentical in both copies\n"
        sha = self._seed(store, body)
        link_corpus_doc_mirrors(
            store,
            "repo",
            [("openspec/changes/archive/2026-04-27-audit/spec.md", body), ("openspec/changes/audit/spec.md", body)],
        )
        p = store.get_node(corpus_doc_node_id(sha))["properties"]
        assert p["path"] == "openspec/changes/audit/spec.md", "archived duplicate must not win"
        assert p["status"] == "design_history", "status must describe the path it is stamped with"

    def test_every_path_is_recorded(self, store):
        body = b"# Spec\nidentical\n"
        sha = self._seed(store, body)
        link_corpus_doc_mirrors(store, "repo", [("a/spec.md", body), ("b/spec.md", body)])
        assert store.get_node(corpus_doc_node_id(sha))["properties"]["paths"] == ["a/spec.md", "b/spec.md"]

    def test_one_mirrors_edge_per_path(self, store):
        body = b"# Spec\nidentical\n"
        sha = self._seed(store, body)
        n = link_corpus_doc_mirrors(store, "repo", [("a/spec.md", body), ("b/spec.md", body)])
        assert n == 2
        out = store.traverse(
            corpus_doc_node_id(sha), direction="outgoing", max_depth=1, relationship_type=REL_TYPE_MIRRORS
        )
        assert {r["node"]["id"] for r in out} == {"repo/a/spec.md", "repo/b/spec.md"}

    def test_unique_content_keeps_its_single_path_and_no_paths_key(self, store):
        body = b"# Unique\n"
        sha = self._seed(store, body)
        link_corpus_doc_mirrors(store, "repo", [("docs/guide.md", body)])
        p = store.get_node(corpus_doc_node_id(sha))["properties"]
        assert p["path"] == "docs/guide.md" and "paths" not in p
