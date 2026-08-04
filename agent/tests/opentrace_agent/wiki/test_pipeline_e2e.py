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

Call shape per compile: exactly ONE ``emit_extraction`` per new source (its
navigation label). Nothing else — synthesis and the entity layer were both
removed, so a compile makes no other LLM calls and writes no other nodes.
"""

from __future__ import annotations

import hashlib

import pytest

from opentrace_agent.wiki import SourceInput, run_compile
from opentrace_agent.wiki.ingest.types import WikiEventKind, WikiPhase
from opentrace_agent.wiki.vault import load_metadata


@pytest.fixture(autouse=True)
def _deterministic_wiki(monkeypatch):
    # Serialise LLM calls so the FakeLLM's strict pop-order is deterministic.
    monkeypatch.setenv("OT_WIKI_CONCURRENCY", "1")


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _extraction(title: str) -> tuple[str, dict]:
    """One emit_extraction response: the doc's navigation label."""
    return ("emit_extraction", {"one_line_summary": f"Summary of {title}."})

def test_first_compile_with_graph_store_mirrors_into_graph(tmp_path, fake_llm):
    pytest.importorskip("real_ladybug")
    from opentrace_agent.store import GraphStore
    from opentrace_agent.wiki.ingest.graph_writer import (
        NODE_TYPE_KNOWLEDGE_DOC,
        NODE_TYPE_KNOWLEDGE_VAULT,
        corpus_doc_node_id,
        vault_node_id,
    )

    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl.")
    llm = fake_llm(
        [
            _extraction("Ducks"),
        ]
    )

    db_path = str(tmp_path / "graph.db")
    graph_store = GraphStore(db_path)
    try:
        events = list(
            run_compile(
                "testvault", [src], vault_root=tmp_path, llm=llm, graph_store=graph_store
            )
        )

        # Corpus-only: the vault node and the doc land in the graph, and NO
        # page is written to disk (synthesis was removed).
        assert not list((tmp_path / "testvault" / "pages").rglob("*.md"))

        vault_node = graph_store.get_node(vault_node_id("testvault"))
        assert vault_node is not None and vault_node["type"] == NODE_TYPE_KNOWLEDGE_VAULT

        # The KnowledgeDoc node carries its navigation label.
        source_node = graph_store.get_node(corpus_doc_node_id(_sha(src.data)))
        assert source_node is not None and source_node["type"] == NODE_TYPE_KNOWLEDGE_DOC
        assert source_node["properties"]["title"] == "Ducks"
        assert source_node["properties"]["one_line_summary"] == "Summary of Ducks."

        assert [e for e in events if "Mirrored vault to graph" in (e.message or "")]
    finally:
        graph_store.close()


def test_second_compile_with_same_source_is_idempotent(tmp_path, fake_llm):
    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl.")
    llm1 = fake_llm(
        [
            _extraction("Ducks"),
        ]
    )
    list(run_compile("v", [src], vault_root=tmp_path, llm=llm1))

    # Same source again — Acquire dedups, so nothing reaches the LLM.
    llm2 = fake_llm([])
    events = list(run_compile("v", [src], vault_root=tmp_path, llm=llm2))
    assert events[-1].kind == WikiEventKind.DONE
    assert "vault unchanged" in events[-1].message
    assert llm2.calls == []


def test_sources_and_labels_recorded_with_no_pages(tmp_path, fake_llm):
    """Two new sources → no pages ever, but the sources and their labels are
    recorded and the compile completes on exactly one call per doc."""
    src_a = SourceInput(name="alpha.md", data=b"# Alpha\nText A.")
    src_b = SourceInput(name="beta.md", data=b"# Beta\nText B.")
    llm = fake_llm(
        [
            _extraction("Alpha"),
            _extraction("Beta"),
        ]
    )
    events = list(run_compile("v", [src_a, src_b], vault_root=tmp_path, llm=llm))
    assert events[-1].kind == WikiEventKind.DONE
    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    assert meta.pages == {}
    assert {s.original_name for s in meta.sources.values()} == {"alpha.md", "beta.md"}
    assert meta.sources[_sha(src_a.data)].one_line_summary == "Summary of Alpha."
    assert [c[0] for c in llm.calls] == ["emit_extraction", "emit_extraction"]  # nothing else


def test_empty_content_source_is_skipped(tmp_path, fake_llm):
    """A source that normalizes to ~empty (a logo/favicon, or here a blank .md)
    is dropped before the per-doc LLM call — no Source entry, no label —
    while real content is processed. Content gate, not a type gate."""
    real = SourceInput(name="real.md", data=b"# Real\nThis document has actual content to extract.")
    blank = SourceInput(name="logo.md", data=b"   \n   ")  # normalizes to whitespace → skipped
    llm = fake_llm(
        [
            # Only ONE extraction call — the blank source never reaches the LLM.
            _extraction("Real"),
        ]
    )
    events = list(run_compile("v", [real, blank], vault_root=tmp_path, llm=llm))

    meta = load_metadata(tmp_path / "v" / ".vault.json", name="v")
    assert _sha(real.data) in meta.sources
    assert _sha(blank.data) not in meta.sources  # skipped entirely — no Source node either
    # The gate's skip count travels as structured detail (the CLI summary
    # reads it), not just message text.
    gate_events = [e for e in events if e.detail and "low_content_skipped" in e.detail]
    assert [e.detail["low_content_skipped"] for e in gate_events] == [1]


def test_compile_writes_no_entity_nodes(tmp_path, fake_llm):
    """The extraction call emits ONLY the label, so a compile mirrors a
    labelled KnowledgeDoc and nothing else. Regression guard for the entity
    layer removed 2026-08-04: even if a model volunteers `entities`/`edges`
    off-schema, no Idea/Person/... node may appear in the graph."""
    pytest.importorskip("real_ladybug")
    from opentrace_agent.store import GraphStore
    from opentrace_agent.wiki.ingest.graph_writer import corpus_doc_node_id

    src = SourceInput(name="ducks.md", data=b"# Ducks\nDucks are waterfowl studied by Karen.")
    sha = _sha(src.data)
    extraction = (
        "emit_extraction",
        {
            "one_line_summary": "About ducks.",
            # Off-schema leftovers a model might still volunteer.
            "entities": [{"label": "Karen", "type": "person"}],
            "edges": [{"source": "Karen", "target": "Ducks", "relation": "studies"}],
        },
    )
    llm = fake_llm([extraction])

    db_path = str(tmp_path / "graph.db")
    gs = GraphStore(db_path)
    try:
        list(run_compile("v", [src], vault_root=tmp_path, llm=llm, graph_store=gs))

        doc = gs.get_node(corpus_doc_node_id(sha))
        assert doc is not None
        assert doc["properties"]["one_line_summary"] == "About ducks."
        for ntype in ("Idea", "Service", "Module", "Paper", "Person", "Event"):
            assert gs.list_nodes(ntype, limit=10) == []
    finally:
        gs.close()


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
            _extraction("Proposal"),
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


