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
  - one ``emit_page`` per new source (the file-summary + folded concept map),
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


def _summary(title: str, *, concepts: list[dict] | None = None, body: str = "summary body") -> tuple[str, dict]:
    """A file-summary ``emit_page`` response, optionally carrying the folded
    concept inventory used by Resolve."""
    payload = {"markdown_body": f"# {title}\n\n{body}\n", "one_line_summary": f"Summary of {title}."}
    if concepts is not None:
        payload["concepts"] = concepts
    return ("emit_page", payload)


def _resolve(*concepts: dict) -> tuple[str, dict]:
    """A Level-2 propose_concepts response. Resolve derives a concept's sources
    from its member (subject, topic) pair ids, so each scripted concept is
    auto-assigned the i-th pair id (t1, t2, …) — these tests script one concept
    per distinct pair, in pair order, so positional ids line up. (Subjects are
    single per test, so Level 1 makes no call.)"""
    out = [{**c, "member_ids": c.get("member_ids", [f"t{i}"])} for i, c in enumerate(concepts, 1)]
    return ("propose_concepts", {"concepts": out})


def _concept_page(title: str, body: str = "Synthesised body.") -> tuple[str, dict]:
    return ("emit_page", {"markdown_body": f"# {title}\n\n{body}\n", "one_line_summary": title})


def test_first_compile_with_graph_store_mirrors_into_graph(tmp_path, fake_llm):
    pytest.importorskip("real_ladybug")
    from opentrace_agent.store import GraphStore
    from opentrace_agent.wiki.ingest.graph_writer import (
        NODE_TYPE_WIKI_PAGE,
        NODE_TYPE_WIKI_VAULT,
        page_node_id,
        vault_node_id,
    )

    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl.")
    llm = fake_llm(
        [
            _summary("Ducks", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}]),
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [_sha(src.data)]}),
            _concept_page("Ducks", "See [[File Summary: Ducks]]."),
        ]
    )

    db_path = str(tmp_path / "graph.db")
    graph_store = GraphStore(db_path)
    try:
        events = list(run_compile("testvault", [src], vault_root=tmp_path, llm=llm, graph_store=graph_store))

        assert (tmp_path / "testvault" / "pages" / "concept" / "ducks.md").exists()

        vault_node = graph_store.get_node(vault_node_id("testvault"))
        assert vault_node is not None and vault_node["type"] == NODE_TYPE_WIKI_VAULT

        ducks_node = graph_store.get_node(page_node_id("testvault", "concept/ducks"))
        assert ducks_node is not None and ducks_node["type"] == NODE_TYPE_WIKI_PAGE
        assert ducks_node["properties"]["kind"] == "concept"

        assert [e for e in events if "Mirrored vault to graph" in (e.message or "")]
    finally:
        graph_store.close()


def test_first_compile_creates_pages(tmp_path, fake_llm):
    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl.")
    llm = fake_llm(
        [
            _summary("Ducks", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}]),
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [_sha(src.data)]}),
            _concept_page("Ducks", "Ducks are waterfowl. See [[Geese]]."),
        ]
    )

    events = list(run_compile("testvault", [src], vault_root=tmp_path, llm=llm))

    kinds = [(e.phase, e.kind) for e in events]
    assert (WikiPhase.ACQUIRING, WikiEventKind.STAGE_START) in kinds
    assert (WikiPhase.SUMMARIZING_SOURCES, WikiEventKind.STAGE_START) in kinds
    assert (WikiPhase.PERSISTING, WikiEventKind.STAGE_STOP) in kinds
    assert events[-1].kind == WikiEventKind.DONE

    page = (tmp_path / "testvault" / "pages" / "concept" / "ducks.md").read_text()
    assert page.startswith("# Ducks")
    assert "[[Geese]]" in page

    meta = load_metadata(tmp_path / "testvault" / ".vault.json", name="testvault")
    assert meta.pages["concept/ducks"].kind == "concept"
    assert meta.pages["file-summary/ducks"].kind == "file_summary"
    assert meta.pages["concept/ducks"].one_line_summary == "Ducks"
    assert _sha(src.data) in meta.sources


def test_second_compile_with_same_source_is_idempotent(tmp_path, fake_llm):
    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl.")
    llm1 = fake_llm(
        [
            _summary("Ducks", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}]),
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [_sha(src.data)]}),
            _concept_page("Ducks"),
        ]
    )
    list(run_compile("v", [src], vault_root=tmp_path, llm=llm1))

    # Same source again — Acquire dedups, so nothing reaches the LLM (no
    # summaries → no mentions → Resolve makes no call).
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
            _summary("A", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}]),
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [_sha(src1.data)]}),
            _concept_page("Ducks", "Ducks are waterfowl."),
        ]
    )
    list(run_compile("v", [src1], vault_root=tmp_path, llm=create))

    # Second source about the same concept → Resolve emits "Ducks" again; it
    # already has a page → EXTEND (the existing-concept match ignores the floor).
    extend = fake_llm(
        [
            _summary("B", concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "mallards"}]),
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [_sha(src2.data)]}),
            _concept_page("Ducks", "Ducks are waterfowl. Mallards are common."),
        ]
    )
    list(run_compile("v", [src2], vault_root=tmp_path, llm=extend))

    page = (tmp_path / "v" / "pages" / "concept" / "ducks.md").read_text()
    assert "Mallards" in page
    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    assert meta.pages["concept/ducks"].revision == 2
    assert _sha(src1.data) in meta.pages["concept/ducks"].source_shas
    assert _sha(src2.data) in meta.pages["concept/ducks"].source_shas


def test_execute_sees_sibling_creates_as_neighbours(tmp_path, fake_llm):
    """Each concept-create call is told about the other planned creates and the
    file-summary page, so a fresh-vault batch can produce inter-page links."""
    src = SourceInput(name="bundle.md", data=b"# Bundle\nFoo and Bar.")
    sha = _sha(src.data)
    llm = fake_llm(
        [
            _summary(
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
            _concept_page("Foo"),
            _concept_page("Bar"),
        ]
    )

    list(run_compile("v", [src], vault_root=tmp_path, llm=llm))

    # Calls: #0 summary, #1 resolve, #2 Foo create, #3 Bar create.
    assert len(llm.calls) == 4
    assert llm.calls[1][0] == "propose_concepts"
    _, foo_user_msg = llm.calls[2]
    _, bar_user_msg = llm.calls[3]
    assert "Bar" in foo_user_msg
    assert "Foo" in bar_user_msg
    assert "[file_summary] Bundle" in foo_user_msg
    assert "(no neighbour pages)" not in foo_user_msg


def test_file_summaries_emitted_one_per_new_source(tmp_path, fake_llm):
    """Two new sources → two file-summary pages; Resolve finds no concepts."""
    src_a = SourceInput(name="alpha.md", data=b"# Alpha\nText A.")
    src_b = SourceInput(name="beta.md", data=b"# Beta\nText B.")
    llm = fake_llm(
        [
            _summary("Alpha", concepts=[]),
            _summary("Beta", concepts=[]),
            # Both summaries emitted empty concept lists → mentions empty →
            # Resolve makes no LLM call, so no propose_concepts is scripted.
        ]
    )
    list(run_compile("v", [src_a, src_b], vault_root=tmp_path, llm=llm))
    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    summaries = {s for s, p in meta.pages.items() if p.kind == "file_summary"}
    assert summaries == {"file-summary/alpha", "file-summary/beta"}
    assert llm.calls[-1][0] == "emit_page"  # last call was a summary, not a resolve


def test_concept_synthesis_reads_raw_body_not_summary(tmp_path, fake_llm):
    """The concept synthesis call is fed the RAW source body, not the digest
    summary — grounding synthesis in the full source (LLM-wiki A1 decision)."""
    src = SourceInput(name="ducks.md", data=b"# Ducks\nRAWONLYPHRASE: ducks quack.")
    llm = fake_llm(
        [
            _summary(
                "Ducks",
                body="SUMMARYMARKER: ducks are waterfowl.",
                concepts=[{"topic": "ducks", "subject": "fauna", "gloss": "waterfowl"}],
            ),
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [_sha(src.data)]}),
            _concept_page("Ducks"),
        ]
    )
    list(run_compile("v", [src], vault_root=tmp_path, llm=llm))

    concept_tool, concept_user = llm.calls[-1]
    assert concept_tool == "emit_page"
    assert "RAWONLYPHRASE" in concept_user
    assert "SUMMARYMARKER" not in concept_user


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
            _summary("Models", concepts=[{"topic": "validation", "subject": "lib", "gloss": "on models"}]),
            _summary("Fields", concepts=[{"topic": "validation", "subject": "lib", "gloss": "on fields"}]),
            _resolve({"title": "Validation", "topic": "validation", "subject": "lib", "source_shas": [sha1, sha2]}),
            _concept_page("Validation"),
        ]
    )
    list(run_compile("v", [src1, src2], vault_root=tmp_path, llm=llm))

    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    concepts = {s for s, p in meta.pages.items() if p.kind == "concept"}
    assert concepts == {"concept/validation"}
    assert set(meta.pages["concept/validation"].source_shas) == {sha1, sha2}


def test_empty_content_source_is_skipped(tmp_path, fake_llm):
    """A source that normalizes to ~empty (a logo/favicon, or here a blank .md)
    is dropped before the per-doc LLM call — no summary page, no Source entry —
    while real content is processed. Content gate, not a type gate."""
    real = SourceInput(name="real.md", data=b"# Real\nThis document has actual content to summarise.")
    blank = SourceInput(name="logo.md", data=b"   \n   ")  # normalizes to whitespace → skipped
    llm = fake_llm(
        [
            # Only ONE summary call — the blank source never reaches the LLM.
            _summary("Real", concepts=[{"topic": "real", "subject": "thing", "gloss": "g"}]),
            _resolve({"title": "Real", "topic": "real", "subject": "thing", "source_shas": [_sha(real.data)]}),
            _concept_page("Real"),
        ]
    )
    list(run_compile("v", [real, blank], vault_root=tmp_path, llm=llm))

    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    summaries = {s for s, p in meta.pages.items() if p.kind == "file_summary"}
    assert summaries == {"file-summary/real"}
    assert _sha(real.data) in meta.sources
    assert _sha(blank.data) not in meta.sources  # skipped entirely — no Source node either


def test_unified_call_emits_entities_into_graph(tmp_path, fake_llm):
    """The single emit_page call now also yields entities + edges, which land in
    the graph as Idea/Person/... nodes (with description) + DERIVED_FROM edges."""
    pytest.importorskip("real_ladybug")
    from opentrace_agent.sources.markdown.prompts import make_entity_id
    from opentrace_agent.store import GraphStore

    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl studied by Karen.")
    sha = _sha(src.data)
    summary = (
        "emit_page",
        {
            "markdown_body": "# Ducks\n\nDucks are waterfowl. Karen studies them.\n",
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
            summary,
            _resolve({"title": "Ducks", "topic": "ducks", "subject": "fauna", "source_shas": [sha]}),
            _concept_page("Ducks", "Ducks and Waterfowl Biology."),
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


def test_single_source_concept_below_floor_makes_no_concept_page(tmp_path, fake_llm, monkeypatch):
    """With the default floor of 2, a concept drawn from a single document is
    NOT paged — its file-summary already covers it."""
    monkeypatch.setenv("OT_WIKI_CONCEPT_MIN_SOURCES", "2")
    src = SourceInput(name="solo.md", data=b"# Solo\nOne doc.")
    llm = fake_llm(
        [
            _summary("Solo", concepts=[{"topic": "solo", "subject": "thing", "gloss": "alone"}]),
            _resolve({"title": "Solo", "topic": "solo", "subject": "thing", "source_shas": [_sha(src.data)]}),
            # No concept-page synthesis call: the create is filtered by the floor.
        ]
    )
    list(run_compile("v", [src], vault_root=tmp_path, llm=llm))

    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    assert not [s for s, p in meta.pages.items() if p.kind == "concept"]
    assert "file-summary/solo" in meta.pages
