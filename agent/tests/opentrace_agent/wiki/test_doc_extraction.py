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

"""Tests for the DocExtraction stage — per-doc labels, concept Map, entities."""

from __future__ import annotations

from opentrace_agent.wiki.ingest.doc_extraction import (
    DEFAULT_MAX_DOC_CHARS,
    _chunk_markdown,
    _disambiguated_titles,
    _max_doc_chars,
    _merge_chunk_results,
    _parse_concepts,
    _split_sections,
    extract_docs,
)
from opentrace_agent.wiki.ingest.types import ConceptMention, NormalizedSource
from opentrace_agent.wiki.vault import VaultMetadata


def _src(sha: str, name: str) -> NormalizedSource:
    return NormalizedSource(sha256=sha, original_name=name, markdown="# x\nbody")


class TestDisambiguatedTitles:
    def test_unique_filenames_keep_bare_titles(self):
        srcs = [_src("1", "models.md"), _src("2", "validators.md")]
        titles = _disambiguated_titles(srcs)
        assert titles == {"1": "Models", "2": "Validators"}

    def test_duplicate_basenames_first_bare_rest_qualified(self):
        # First claimant (deterministic order: docs < pydantic) keeps the bare
        # title; the collision is qualified by directory.
        srcs = [_src("1", "docs/README.md"), _src("2", "pydantic/README.md")]
        titles = _disambiguated_titles(srcs)
        assert titles == {"1": "Readme", "2": "Readme (pydantic)"}
        assert len(set(titles.values())) == 2  # unique

    def test_widens_path_when_shallow_hint_still_collides(self):
        # Three index.md, two under a "docs" parent: bare, then "(docs)", then
        # the third must widen past the already-taken "(docs)".
        srcs = [
            _src("1", "a/index.md"),
            _src("2", "b/docs/index.md"),
            _src("3", "c/docs/index.md"),
        ]
        titles = _disambiguated_titles(srcs)
        assert titles == {"1": "Index", "2": "Index (docs)", "3": "Index (c/docs)"}

    def test_root_level_duplicate_falls_back_to_numeric(self):
        # Same basename, no directory context to distinguish on.
        srcs = [_src("1", "README"), _src("2", "README")]
        titles = _disambiguated_titles(srcs)
        assert set(titles.values()) == {"Readme", "Readme (2)"}


class TestParseConcepts:
    def test_parses_and_stamps_sha(self):
        result = {
            "concepts": [
                {"topic": "validation", "subject": "lib", "gloss": "how validation works"},
                {"topic": "serialization", "subject": "lib", "gloss": "dumping models"},
            ]
        }
        mentions = _parse_concepts(result, "sha123")
        assert [m.topic for m in mentions] == ["validation", "serialization"]
        assert all(m.source_sha == "sha123" for m in mentions)

    def test_tolerates_missing_and_malformed(self):
        assert _parse_concepts({}, "s") == []
        assert _parse_concepts({"concepts": None}, "s") == []
        # Non-dict items and entries missing topic/subject are dropped.
        result = {"concepts": ["junk", {"topic": "t"}, {"topic": "x", "subject": "y", "gloss": "g"}]}
        mentions = _parse_concepts(result, "s")
        assert len(mentions) == 1
        assert mentions[0] == ConceptMention(topic="x", subject="y", gloss="g", source_sha="s")


class TestMaxDocChars:
    def test_env_override_wins(self, monkeypatch):
        monkeypatch.setenv("OT_WIKI_MAX_DOC_CHARS", "1234")
        assert _max_doc_chars() == 1234

    def test_ignores_garbage_override(self, monkeypatch):
        monkeypatch.setenv("OT_WIKI_MAX_DOC_CHARS", "not-a-number")
        assert _max_doc_chars() == DEFAULT_MAX_DOC_CHARS

    def test_default_is_generous(self, monkeypatch):
        monkeypatch.delenv("OT_WIKI_MAX_DOC_CHARS", raising=False)
        # Extraction output is small, so the threshold guards input context, not
        # the output budget — generous enough that only enormous docs are split.
        assert _max_doc_chars() == DEFAULT_MAX_DOC_CHARS
        assert DEFAULT_MAX_DOC_CHARS >= 100_000


class TestChunkMarkdown:
    def test_small_doc_is_one_chunk_verbatim(self):
        md = "# Title\n\nshort body"
        assert _chunk_markdown(md, 1000) == [md]

    def test_splits_on_heading_boundaries(self):
        a = "# Alpha\n" + ("a" * 80) + "\n"
        b = "## Beta\n" + ("b" * 80) + "\n"
        chunks = _chunk_markdown(a + b, 120)
        assert len(chunks) == 2
        assert chunks[0].startswith("# Alpha")
        assert chunks[1].startswith("## Beta")

    def test_oversized_single_section_is_hard_split(self):
        # One heading, body far larger than max_chars and no paragraph breaks.
        md = "# Big\n" + ("x" * 500)
        chunks = _chunk_markdown(md, 100)
        assert len(chunks) > 1
        assert all(len(c) <= 100 for c in chunks)
        assert "".join(chunks).rstrip("\n") == md  # no interior content dropped

    def test_split_sections_keeps_preamble(self):
        secs = _split_sections("intro text\n# H1\nbody")
        assert secs[0] == "intro text\n"
        assert secs[1] == "# H1\nbody"


class TestMergeChunkResults:
    def test_single_result_passthrough(self):
        r = {"one_line_summary": "s"}
        assert _merge_chunk_results([r]) is r

    def test_first_nonempty_one_liner_wins(self):
        merged = _merge_chunk_results(
            [
                {"one_line_summary": ""},
                {"one_line_summary": "second"},
                {"one_line_summary": "third"},
            ]
        )
        assert merged["one_line_summary"] == "second"

    def test_unions_and_dedups_concepts_and_entities(self):
        merged = _merge_chunk_results(
            [
                {
                    "one_line_summary": "part one",
                    "concepts": [{"topic": "t1", "subject": "s", "gloss": "g"}],
                    "entities": [{"label": "Pydantic", "type": "module"}],
                    "edges": [{"source": "Pydantic", "target": "Mypy", "relation": "integrates"}],
                },
                {
                    "one_line_summary": "part two",
                    "concepts": [
                        {"topic": "t1", "subject": "s", "gloss": "dup"},  # same (topic,subject) → dropped
                        {"topic": "t2", "subject": "s", "gloss": "g2"},
                    ],
                    "entities": [
                        {"label": "pydantic", "type": "module"},  # case-insensitive dup → dropped
                        {"label": "Mypy", "type": "service"},
                    ],
                    "edges": [{"source": "Pydantic", "target": "Mypy", "relation": "integrates"}],  # dup
                },
            ]
        )
        assert [c["topic"] for c in merged["concepts"]] == ["t1", "t2"]
        assert {e["label"] for e in merged["entities"]} == {"Pydantic", "Mypy"}
        assert len(merged["edges"]) == 1


def test_extract_docs_chunks_large_doc_and_merges(fake_llm, monkeypatch):
    """A doc over the (forced low) threshold is split, each part extracted, and
    the parts merged into one label + one concept/entity inventory."""
    monkeypatch.setenv("OT_WIKI_MAX_DOC_CHARS", "120")
    monkeypatch.setenv("OT_WIKI_CONCURRENCY", "1")
    body = "# Alpha\n" + ("a" * 80) + "\n## Beta\n" + ("b" * 80) + "\n"
    src = NormalizedSource(sha256="big", original_name="big-doc.md", markdown=body)
    responses = [
        (
            "emit_extraction",
            {
                "one_line_summary": "Part one.",
                "concepts": [{"topic": "alpha", "subject": "lib", "gloss": "a"}],
                "entities": [{"label": "Lib", "type": "module"}],
            },
        ),
        (
            "emit_extraction",
            {
                "one_line_summary": "Part two.",
                "concepts": [{"topic": "beta", "subject": "lib", "gloss": "b"}],
                "entities": [{"label": "Lib", "type": "module"}],  # dup across chunks
            },
        ),
    ]
    llm = fake_llm(responses)
    mentions: list[ConceptMention] = []
    entity_nodes: list = []
    list(extract_docs([src], VaultMetadata.empty("v"), llm, mentions, entity_nodes_out=entity_nodes))

    assert len(llm.calls) == 2  # one call per chunk
    assert "PART 1 of 2" in llm.calls[0][1] and "PART 2 of 2" in llm.calls[1][1]
    assert src.title == "Big Doc"
    assert src.one_line_summary == "Part one."  # first non-empty across chunks
    assert {m.topic for m in mentions} == {"alpha", "beta"}
    assert len(entity_nodes) == 1  # "Lib" deduped across the two chunks


def test_extract_docs_stamps_labels_and_collects_mentions(fake_llm):
    src = NormalizedSource(sha256="abc", original_name="ducks.md", markdown="# Ducks\nstuff")
    resp = (
        "emit_extraction",
        {
            "one_line_summary": "About ducks.",
            "concepts": [{"topic": "waterfowl", "subject": "ducks", "gloss": "ducks are waterfowl"}],
        },
    )
    mentions: list[ConceptMention] = []
    list(extract_docs([src], VaultMetadata.empty("v"), fake_llm([resp]), mentions))

    assert src.title == "Ducks"
    assert src.one_line_summary == "About ducks."
    assert len(mentions) == 1
    assert mentions[0].topic == "waterfowl"
    assert mentions[0].source_sha == "abc"  # stamped from the document


def test_extract_docs_without_mentions_out_is_fine(fake_llm):
    """mentions_out is optional — omitting it must not break extraction."""
    src = NormalizedSource(sha256="abc", original_name="a.md", markdown="# A\nx")
    resp = ("emit_extraction", {"one_line_summary": "s", "concepts": []})
    list(extract_docs([src], VaultMetadata.empty("v"), fake_llm([resp])))
    assert src.one_line_summary == "s"
