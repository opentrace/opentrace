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

"""Unit tests for the Execute stage's pure helpers."""

from __future__ import annotations

from opentrace_agent.wiki.ingest.execute import _sections_block, _sources_block, force_h1
from opentrace_agent.wiki.ingest.types import NormalizedSource


class TestSectionsBlock:
    """The absorbed sub-topics are handed to synthesis as a section outline so
    each is written as a section rather than silently merged away."""

    def test_empty_when_no_sections(self):
        assert _sections_block([]) == ""

    def test_lists_sections_as_heading_directive(self):
        block = _sections_block(["Aliases", "Exclusion"])
        assert "Aliases" in block and "Exclusion" in block
        assert "##" in block  # instructs section headings


class TestSourcesBlock:
    """Concept synthesis reads the RAW source body (the digest is for browsing +
    citation, not synthesis input) — see the LLM-wiki A1 decision."""

    def _src(self, sha: str, name: str, body: str) -> NormalizedSource:
        return NormalizedSource(sha256=sha, original_name=name, markdown=body)

    def test_renders_raw_body_with_filename(self):
        src = self._src("aaa", "doc.md", "THE FULL RAW BODY")
        block = _sources_block([src], ["aaa"])
        assert "THE FULL RAW BODY" in block
        assert "doc.md" in block

    def test_skips_unknown_sha(self):
        assert _sources_block([], ["missing"]) == ""

    def test_authoritative_status_label(self):
        block = _sources_block([self._src("aaa", "docs/guide.md", "body")], ["aaa"])
        assert "[current documentation]" in block

    def test_design_history_status_label(self):
        src = NormalizedSource(
            sha256="bbb", original_name="openspec/p.md", markdown="body", status="design_history"
        )
        block = _sources_block([src], ["bbb"])
        assert "design proposal or spec" in block
        assert "superseded" in block

    def test_archived_design_history_label(self):
        src = NormalizedSource(
            sha256="ccc", original_name="openspec/archive/p.md", markdown="body", status="design_history_archived"
        )
        assert "; archived" in _sources_block([src], ["ccc"])

    def test_augmented_source_marked(self):
        planned = self._src("aaa", "planned.md", "body a")
        scanned = self._src("bbb", "scanned.md", "body b")
        block = _sources_block([planned, scanned], ["aaa", "bbb"], augmented_shas=["bbb"])
        # Only the relevance-scan source carries the marker.
        assert block.count("added by relevance scan") == 1
        assert "scanned.md [current documentation; added by relevance scan]" in block


class TestForceH1:
    def test_replaces_existing_h1(self):
        body = "# Wrong Title\n\nSome body text.\n"
        assert force_h1(body, "Right Title") == "# Right Title\n\nSome body text.\n"

    def test_replaces_h1_when_only_line(self):
        assert force_h1("# Old", "New") == "# New"

    def test_prepends_when_first_line_is_not_h1(self):
        body = "Plain prose without a heading.\n"
        assert force_h1(body, "T") == "# T\n\nPlain prose without a heading.\n"

    def test_prepends_when_first_line_is_lower_heading(self):
        # ## H2 must NOT be treated as the page H1.
        body = "## Subsection\n\ntext\n"
        assert force_h1(body, "T") == "# T\n\n## Subsection\n\ntext\n"

    def test_empty_body_returns_just_h1(self):
        assert force_h1("", "Hello") == "# Hello\n"

    def test_whitespace_only_body_returns_just_h1(self):
        assert force_h1("\n\n", "Hello") == "# Hello\n"

    def test_strips_leading_blank_lines_before_existing_h1(self):
        body = "\n\n# Old\n\nbody\n"
        assert force_h1(body, "New") == "# New\n\nbody\n"

    def test_preserves_body_after_h1_verbatim(self):
        body = "# Old\n\nParagraph with [[Link]] and **bold**.\n\n## Subhead\n"
        expected = "# T\n\nParagraph with [[Link]] and **bold**.\n\n## Subhead\n"
        assert force_h1(body, "T") == expected

    def test_title_with_punctuation_is_preserved_verbatim(self):
        # The renderer treats whatever follows `# ` as the title — colons,
        # ampersands, em-dashes etc. must survive untouched.
        title = "McDonald's North American Supply & Delivery — Overview"
        assert force_h1("# wrong\n\nbody\n", title) == f"# {title}\n\nbody\n"
