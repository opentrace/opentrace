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

"""Tests for the DocExtraction stage — the per-doc navigation label."""

from __future__ import annotations

from opentrace_agent.wiki.ingest.doc_extraction import (
    DEFAULT_MAX_DOC_CHARS,
    _chunk_markdown,
    _disambiguated_titles,
    _max_doc_chars,
    _merge_chunk_results,
    _split_sections,
    extract_docs,
)
from opentrace_agent.wiki.ingest.types import NormalizedSource


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

    def test_merge_emits_only_the_summary(self):
        """The call emits one field, so the merge must not invent others —
        anything a model returns beyond the schema is dropped, not carried."""
        merged = _merge_chunk_results(
            [
                {"one_line_summary": "part one", "entities": [{"label": "Pydantic"}]},
                {"one_line_summary": "part two"},
            ]
        )
        assert merged == {"one_line_summary": "part one"}


def test_extract_docs_chunks_large_doc_and_merges(fake_llm, monkeypatch):
    """A doc over the (forced low) threshold is split, each part extracted, and
    the parts merged into one label."""
    monkeypatch.setenv("OT_WIKI_MAX_DOC_CHARS", "120")
    monkeypatch.setenv("OT_WIKI_CONCURRENCY", "1")
    body = "# Alpha\n" + ("a" * 80) + "\n## Beta\n" + ("b" * 80) + "\n"
    src = NormalizedSource(sha256="big", original_name="big-doc.md", markdown=body)
    responses = [
        ("emit_extraction", {"one_line_summary": "Part one."}),
        ("emit_extraction", {"one_line_summary": "Part two."}),
    ]
    llm = fake_llm(responses)
    list(extract_docs([src], llm))

    assert len(llm.calls) == 2  # one call per chunk
    assert "PART 1 of 2" in llm.calls[0][1] and "PART 2 of 2" in llm.calls[1][1]
    assert src.title == "Big Doc"
    assert src.one_line_summary == "Part one."  # first non-empty across chunks


def test_extract_docs_stamps_labels(fake_llm):
    """Title is derived mechanically from the filename; the one-liner comes
    from the model. Both are stamped on the NormalizedSource in place."""
    src = NormalizedSource(sha256="abc", original_name="ducks.md", markdown="# Ducks\nstuff")
    resp = ("emit_extraction", {"one_line_summary": "About ducks."})
    list(extract_docs([src], fake_llm([resp])))

    assert src.title == "Ducks"
    assert src.one_line_summary == "About ducks."
