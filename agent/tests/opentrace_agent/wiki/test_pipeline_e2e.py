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

"""End-to-end pipeline tests with a fake LLM and real on-disk vault.

Call shape per compile (with the concept-inventory-and-resolve pipeline):
  - one ``emit_extraction`` per new source (label + concept map + entities),
  - one ``propose_concepts`` (Resolve) — skipped entirely if no concepts,
  - one ``emit_page`` per concept page the plan creates/extends.
"""

from __future__ import annotations

import hashlib

import pytest

from opentrace_agent.wiki import SourceInput, run_compile
from opentrace_agent.wiki.ingest.types import WikiEventKind, WikiPhase
from opentrace_agent.wiki.vault import load_metadata


@pytest.fixture(autouse=True)
def _deterministic_wiki(monkeypatch):
    # Serialise LLM calls so the FakeLLM's strict pop-order is deterministic,
    # and default the concept floor to 1 so single-source fixtures still page.
    # Tests that exercise the floor override it explicitly.
    monkeypatch.setenv("OT_WIKI_CONCURRENCY", "1")
    monkeypatch.setenv("OT_WIKI_CONCEPT_MIN_SOURCES", "1")


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _extraction(title: str, *, concepts: list[dict] | None = None) -> tuple[str, dict]:
    """A per-doc ``emit_extraction`` response, optionally carrying the folded
    concept inventory used by Resolve."""
    payload: dict = {"one_line_summary": f"Summary of {title}."}
    if concepts is not None:
        payload["concepts"] = concepts
    return ("emit_extraction", payload)


def _resolve(*concepts: dict) -> tuple[str, dict]:
    """A Level-2 propose_concepts response. Resolve derives a concept's sources
    from its member (subject, topic) pair ids, so each scripted concept is
    auto-assigned the i-th pair id (t1, t2, …) — these tests script one concept
    per distinct pair, in pair order, so positional ids line up. (Subjects are
    single per test, so Level 1 makes no call.)"""
    out = [{**c, "member_ids": c.get("member_ids", [f"t{i}"])} for i, c in enumerate(concepts, 1)]
    return ("propose_concepts", {"concepts": out})


def _page(title: str, body: str = "Synthesised body.") -> tuple[str, dict]:
    return ("emit_page", {"markdown_body": f"# {title}\n\n{body}\n", "one_line_summary": title})


def test_first_compile_with_graph_store_mirrors_into_graph(tmp_path, fake_llm):
    pytest.importorskip("real_ladybug")
    from opentrace_agent.store import GraphStore
    from opentrace_agent.wiki.ingest.graph_writer import (
        NODE_TYPE_KNOWLEDGE_CONCEPT,
        NODE_TYPE_KNOWLEDGE_VAULT,
        corpus_doc_node_id,
        page_node_id,
        vault_node_id,
    )

    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl.")
    llm = fake_llm(
        [
            _extraction("Ducks", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}]),
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [_sha(src.data)]}),
            _page("Ducks", "Ducks are waterfowl."),
        ]
    )

    db_path = str(tmp_path / "graph.db")
    graph_store = GraphStore(db_path)
    try:
        events = list(
            run_compile(
                "testvault", [src], vault_root=tmp_path, llm=llm, graph_store=graph_store, synthesize_pages=True
            )
        )

        assert (tmp_path / "testvault" / "pages" / "concept" / "ducks.md").exists()

        vault_node = graph_store.get_node(vault_node_id("testvault"))
        assert vault_node is not None and vault_node["type"] == NODE_TYPE_KNOWLEDGE_VAULT

        ducks_node = graph_store.get_node(page_node_id("testvault", "concept/ducks"))
        assert ducks_node is not None and ducks_node["type"] == NODE_TYPE_KNOWLEDGE_CONCEPT
        assert ducks_node["properties"]["kind"] == "concept"

        # The Source node carries its navigation label.
        source_node = graph_store.get_node(corpus_doc_node_id(_sha(src.data)))
        assert source_node is not None
        assert source_node["properties"]["title"] == "Ducks"
        assert source_node["properties"]["one_line_summary"] == "Summary of Ducks."

        assert [e for e in events if "Mirrored vault to graph" in (e.message or "")]
    finally:
        graph_store.close()


def test_first_compile_creates_pages(tmp_path, fake_llm):
    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl.")
    llm = fake_llm(
        [
            _extraction("Ducks", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}]),
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [_sha(src.data)]}),
            _page("Ducks", "Ducks are waterfowl. See [[Geese]]."),
        ]
    )

    events = list(run_compile("testvault", [src], vault_root=tmp_path, llm=llm, synthesize_pages=True))

    kinds = [(e.phase, e.kind) for e in events]
    assert (WikiPhase.ACQUIRING, WikiEventKind.STAGE_START) in kinds
    assert (WikiPhase.EXTRACTING, WikiEventKind.STAGE_START) in kinds
    assert (WikiPhase.PERSISTING, WikiEventKind.STAGE_STOP) in kinds
    assert events[-1].kind == WikiEventKind.DONE

    page = (tmp_path / "testvault" / "pages" / "concept" / "ducks.md").read_text()
    assert page.startswith("# Ducks")
    assert "[[Geese]]" in page

    meta = load_metadata(tmp_path / "testvault" / ".vault.json", name="testvault")
    assert set(meta.pages) == {"concept/ducks"}
    assert meta.pages["concept/ducks"].kind == "concept"
    assert meta.pages["concept/ducks"].one_line_summary == "Ducks"
    # The source is recorded with its extraction-stamped label.
    sha = _sha(src.data)
    assert sha in meta.sources
    assert meta.sources[sha].title == "Ducks"
    assert meta.sources[sha].one_line_summary == "Summary of Ducks."


def test_second_compile_with_same_source_is_idempotent(tmp_path, fake_llm):
    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl.")
    llm1 = fake_llm(
        [
            _extraction("Ducks", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}]),
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [_sha(src.data)]}),
            _page("Ducks"),
        ]
    )
    list(run_compile("v", [src], vault_root=tmp_path, llm=llm1))

    # Same source again — Acquire dedups, so nothing reaches the LLM (no
    # extractions → no mentions → Resolve makes no call).
    llm2 = fake_llm([])
    events = list(run_compile("v", [src], vault_root=tmp_path, llm=llm2))
    assert events[-1].kind == WikiEventKind.DONE
    assert "vault unchanged" in events[-1].message
    assert llm2.calls == []


def test_extend_path_updates_existing_page(tmp_path, fake_llm):
    src1 = SourceInput(name="a.md", data=b"# Ducks\nDucks are waterfowl.")
    src2 = SourceInput(name="b.md", data=b"# More ducks\nMallards are common.")

    create = fake_llm(
        [
            _extraction("A", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}]),
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [_sha(src1.data)]}),
            _page("Ducks", "Ducks are waterfowl."),
        ]
    )
    list(run_compile("v", [src1], vault_root=tmp_path, llm=create, synthesize_pages=True))

    # Second source about the same concept → Resolve emits "Ducks" again; it
    # already has a page → EXTEND (the existing-concept match ignores the floor).
    extend = fake_llm(
        [
            _extraction("B", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "mallards"}]),
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [_sha(src2.data)]}),
            _page("Ducks", "Ducks are waterfowl. Mallards are common."),
        ]
    )
    list(run_compile("v", [src2], vault_root=tmp_path, llm=extend, synthesize_pages=True))

    page = (tmp_path / "v" / "pages" / "concept" / "ducks.md").read_text()
    assert "Mallards" in page
    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    assert meta.pages["concept/ducks"].revision == 2
    assert _sha(src1.data) in meta.pages["concept/ducks"].source_shas
    assert _sha(src2.data) in meta.pages["concept/ducks"].source_shas


def test_execute_sees_sibling_creates_as_neighbours(tmp_path, fake_llm):
    """Each concept-create call is told about the other planned creates, so a
    fresh-vault batch can produce inter-page links."""
    src = SourceInput(name="bundle.md", data=b"# Bundle\nFoo and Bar.")
    sha = _sha(src.data)
    llm = fake_llm(
        [
            _extraction(
                "Bundle",
                concepts=[
                    {"topic": "foo", "subject": "bundle", "gloss": "a thing"},
                    {"topic": "bar", "subject": "bundle", "gloss": "another thing"},
                ],
            ),
            # Distinct (topic, subject) → two separate concepts (not merged).
            _resolve(
                {"title": "Foo", "topic": "foo", "subject": "bundle", "source_shas": [sha]},
                {"title": "Bar", "topic": "bar", "subject": "bundle", "source_shas": [sha]},
            ),
            _page("Foo"),
            _page("Bar"),
        ]
    )

    list(run_compile("v", [src], vault_root=tmp_path, llm=llm, synthesize_pages=True))

    # Calls: #0 extraction, #1 resolve, #2 Foo create, #3 Bar create.
    assert len(llm.calls) == 4
    assert llm.calls[1][0] == "propose_concepts"
    _, foo_user_msg = llm.calls[2]
    _, bar_user_msg = llm.calls[3]
    assert "Bar" in foo_user_msg
    assert "Foo" in bar_user_msg
    assert "(no neighbour pages)" not in foo_user_msg


def test_sources_recorded_without_concepts(tmp_path, fake_llm):
    """Two new sources with no concepts → no pages at all, but the sources and
    their labels are still recorded and the compile completes."""
    src_a = SourceInput(name="alpha.md", data=b"# Alpha\nText A.")
    src_b = SourceInput(name="beta.md", data=b"# Beta\nText B.")
    llm = fake_llm(
        [
            _extraction("Alpha", concepts=[]),
            _extraction("Beta", concepts=[]),
            # Both extractions emitted empty concept lists → mentions empty →
            # Resolve makes no LLM call, so no propose_concepts is scripted.
        ]
    )
    events = list(run_compile("v", [src_a, src_b], vault_root=tmp_path, llm=llm))
    assert events[-1].kind == WikiEventKind.DONE
    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    assert meta.pages == {}
    assert {s.original_name for s in meta.sources.values()} == {"alpha.md", "beta.md"}
    assert meta.sources[_sha(src_a.data)].one_line_summary == "Summary of Alpha."
    assert llm.calls[-1][0] == "emit_extraction"  # last call was an extraction, not a resolve


def test_concept_synthesis_reads_raw_body(tmp_path, fake_llm):
    """The concept synthesis call is fed the RAW source body — grounding
    synthesis in the full source (LLM-wiki A1 decision)."""
    src = SourceInput(name="ducks.md", data=b"# Ducks\nRAWONLYPHRASE: ducks quack.")
    llm = fake_llm(
        [
            _extraction("Ducks", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}]),
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [_sha(src.data)]}),
            _page("Ducks"),
        ]
    )
    list(run_compile("v", [src], vault_root=tmp_path, llm=llm, synthesize_pages=True))

    concept_tool, concept_user = llm.calls[-1]
    assert concept_tool == "emit_page"
    assert "RAWONLYPHRASE" in concept_user


def test_cross_document_concept_merges_sources(tmp_path, fake_llm, monkeypatch):
    """Two docs mention the same (topic, subject); Resolve collapses them into
    one concept page citing BOTH sources — the cross-document synthesis the
    method exists to surface. Floor of 2 is satisfied by the two sources."""
    monkeypatch.setenv("OT_WIKI_CONCEPT_MIN_SOURCES", "2")
    src1 = SourceInput(name="models.md", data=b"# Models\nValidation on models.")
    src2 = SourceInput(name="fields.md", data=b"# Fields\nValidation on fields.")
    sha1, sha2 = _sha(src1.data), _sha(src2.data)
    llm = fake_llm(
        [
            _extraction("Models", concepts=[{"topic": "validation", "subject": "lib", "gloss": "on models"}]),
            _extraction("Fields", concepts=[{"topic": "validation", "subject": "lib", "gloss": "on fields"}]),
            _resolve({"title": "Validation", "topic": "validation", "subject": "lib", "source_shas": [sha1, sha2]}),
            _page("Validation"),
        ]
    )
    list(run_compile("v", [src1, src2], vault_root=tmp_path, llm=llm, synthesize_pages=True))

    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    concepts = {s for s, p in meta.pages.items() if p.kind == "concept"}
    assert concepts == {"concept/validation"}
    assert set(meta.pages["concept/validation"].source_shas) == {sha1, sha2}


def test_empty_content_source_is_skipped(tmp_path, fake_llm):
    """A source that normalizes to ~empty (a logo/favicon, or here a blank .md)
    is dropped before the per-doc LLM call — no Source entry, no label —
    while real content is processed. Content gate, not a type gate."""
    real = SourceInput(name="real.md", data=b"# Real\nThis document has actual content to extract.")
    blank = SourceInput(name="logo.md", data=b"   \n   ")  # normalizes to whitespace → skipped
    llm = fake_llm(
        [
            # Only ONE extraction call — the blank source never reaches the LLM.
            _extraction("Real", concepts=[{"topic": "real", "subject": "thing", "gloss": "g"}]),
            _resolve({"title": "Real", "topic": "real", "subject": "thing", "source_shas": [_sha(real.data)]}),
            _page("Real"),
        ]
    )
    list(run_compile("v", [real, blank], vault_root=tmp_path, llm=llm))

    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    assert _sha(real.data) in meta.sources
    assert _sha(blank.data) not in meta.sources  # skipped entirely — no Source node either


def test_unified_call_emits_entities_into_graph(tmp_path, fake_llm):
    """The single emit_extraction call also yields entities + edges, which land
    in the graph as Idea/Person/... nodes (with description) + DERIVED_FROM edges."""
    pytest.importorskip("real_ladybug")
    from opentrace_agent.sources.markdown.prompts import make_entity_id
    from opentrace_agent.store import GraphStore

    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl studied by Karen.")
    sha = _sha(src.data)
    extraction = (
        "emit_extraction",
        {
            "one_line_summary": "About ducks.",
            "concepts": [{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}],
            "entities": [
                {"label": "Waterfowl Biology", "type": "idea", "description": "the study of waterfowl"},
                {"label": "Karen", "type": "person", "description": "a researcher"},
            ],
            "edges": [
                {
                    "source": "Karen",
                    "target": "Waterfowl Biology",
                    "relation": "studies",
                    "confidence": "EXTRACTED",
                    "confidence_score": 1.0,
                }
            ],
        },
    )
    llm = fake_llm(
        [
            extraction,
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [sha]}),
            _page("Ducks", "Ducks and Waterfowl Biology."),
        ]
    )

    db_path = str(tmp_path / "graph.db")
    gs = GraphStore(db_path)
    try:
        list(run_compile("v", [src], vault_root=tmp_path, llm=llm, graph_store=gs))

        idea = gs.get_node(make_entity_id("ducks", "Waterfowl Biology"))
        assert idea is not None and idea["type"] == "Idea"
        assert idea["properties"]["description"] == "the study of waterfowl"
        person = gs.get_node(make_entity_id("ducks", "Karen"))
        assert person is not None and person["type"] == "Person"
    finally:
        gs.close()


def test_single_source_concept_below_floor_makes_no_page(tmp_path, fake_llm, monkeypatch):
    """With the default floor of 2, a concept drawn from a single document is
    NOT paged — its raw source (labelled, load_source-readable) covers it."""
    monkeypatch.setenv("OT_WIKI_CONCEPT_MIN_SOURCES", "2")
    src = SourceInput(name="solo.md", data=b"# Solo\nOne doc.")
    llm = fake_llm(
        [
            _extraction("Solo", concepts=[{"topic": "solo", "subject": "thing", "gloss": "alone"}]),
            _resolve({"title": "Solo", "topic": "solo", "subject": "thing", "source_shas": [_sha(src.data)]}),
            # No concept-page synthesis call: the create is filtered by the floor.
        ]
    )
    list(run_compile("v", [src], vault_root=tmp_path, llm=llm))

    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    assert meta.pages == {}
    assert _sha(src.data) in meta.sources  # the source itself is still recorded


def test_source_status_persisted_and_mirrored(tmp_path, fake_llm):
    pytest.importorskip("real_ladybug")
    from opentrace_agent.store import GraphStore
    from opentrace_agent.wiki.ingest.graph_writer import corpus_doc_node_id

    src = SourceInput(
        name="openspec/changes/foo/proposal.md",
        data=b"# Proposal\nConflict thresholds design.",
        status="design_history",
    )
    llm = fake_llm(
        [
            _extraction("Proposal", concepts=[{"topic": "conflicts", "subject": "engram", "gloss": "g"}]),
            _resolve({"title": "Conflicts", "topic": "conflicts", "subject": "engram"}),
            _page("Conflicts", "Threshold design."),
        ]
    )
    db_path = str(tmp_path / "graph.db")
    graph_store = GraphStore(db_path)
    try:
        list(run_compile("v", [src], vault_root=tmp_path, llm=llm, graph_store=graph_store))
        node = graph_store.get_node(corpus_doc_node_id(_sha(src.data)))
        assert node["properties"]["status"] == "design_history"
    finally:
        graph_store.close()

    # And it survives in .vault.json for disk-only reloads / re-mirrors.
    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    assert meta.sources[_sha(src.data)].status == "design_history"


def test_ungrounded_numeric_claim_stripped_before_persist(tmp_path, fake_llm):
    # The synthesis output fabricates a 17x figure that appears in no source —
    # the verify stage must strip it before the body reaches disk.
    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl.")
    llm = fake_llm(
        [
            _extraction("Ducks", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}]),
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna"}),
            _page("Ducks", "Ducks are waterfowl.\nDucks fly 17x faster than geese."),
        ]
    )
    events = list(run_compile("v", [src], vault_root=tmp_path, llm=llm, synthesize_pages=True))
    page = (tmp_path / "v" / "pages" / "concept" / "ducks.md").read_text()
    assert "17x" not in page
    assert "waterfowl" in page
    assert any("Stripped 1 ungrounded" in (e.message or "") for e in events)


def test_grounded_numeric_claim_survives(tmp_path, fake_llm):
    src = SourceInput(name="perf.md", data=b"# Perf\nBenchmarked at 17x faster.")
    llm = fake_llm(
        [
            _extraction("Perf", concepts=[{"topic": "perf", "subject": "core", "gloss": "g"}]),
            _resolve({"title": "Perf", "topic": "perf", "subject": "core"}),
            _page("Perf", "The core is 17x faster."),
        ]
    )
    list(run_compile("v", [src], vault_root=tmp_path, llm=llm, synthesize_pages=True))
    assert "17x" in (tmp_path / "v" / "pages" / "concept" / "perf.md").read_text()


def test_corpus_only_is_the_default(tmp_path, fake_llm):
    """Without ``synthesize_pages`` the compile indexes the corpus and stops.

    The FakeLLM is scripted with ONLY the per-doc extraction call, so any
    resolve/synthesis call would exhaust it and fail — proving the synthesis
    half never runs (and costs nothing).
    """
    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl.")
    llm = fake_llm([_extraction("Ducks", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}])])

    events = list(run_compile("v", [src], vault_root=tmp_path, llm=llm))

    # No pages on disk, none in metadata.
    assert not (tmp_path / "v" / "pages" / "concept").exists()
    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    assert meta.pages == {}

    # The document itself IS indexed, with its navigation label.
    sha = _sha(src.data)
    assert sha in meta.sources
    assert meta.sources[sha].one_line_summary == "Summary of Ducks."

    done = events[-1]
    assert done.kind == WikiEventKind.DONE
    assert done.detail["synthesize_pages"] is False
    assert "corpus-only" in done.message
    # Planning never started.
    assert WikiPhase.PLANNING not in {e.phase for e in events}


def test_corpus_only_mirror_writes_docs_but_no_concepts(tmp_path, fake_llm):
    """The graph mirror of a corpus-only compile has KnowledgeDocs, no KnowledgeConcepts."""
    pytest.importorskip("real_ladybug")
    from opentrace_agent.store import GraphStore
    from opentrace_agent.wiki.ingest.graph_writer import (
        NODE_TYPE_KNOWLEDGE_CONCEPT,
        corpus_doc_node_id,
    )

    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl.", status="design_history")
    llm = fake_llm([_extraction("Ducks", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}])])

    graph_store = GraphStore(str(tmp_path / "graph.db"))
    try:
        list(run_compile("v", [src], vault_root=tmp_path, llm=llm, graph_store=graph_store))

        assert graph_store.list_nodes(NODE_TYPE_KNOWLEDGE_CONCEPT) == []

        doc = graph_store.get_node(corpus_doc_node_id(_sha(src.data)))
        assert doc is not None
        # Label + epistemic status are what make it findable and honest.
        assert doc["properties"]["title"] == "Ducks"
        assert doc["properties"]["summary"] == "Summary of Ducks."
        assert doc["properties"]["status"] == "design_history"
    finally:
        graph_store.close()
