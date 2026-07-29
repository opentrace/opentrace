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

"""Tests for the mechanical numeric-claim verifier (strip + log, no LLM)."""

from __future__ import annotations

from opentrace_agent.wiki.ingest.types import CompiledPage
from opentrace_agent.wiki.ingest.verify import strip_ungrounded_numerics


def _page(body: str, shas: list[str] | None = None) -> CompiledPage:
    return CompiledPage(
        slug="concept/perf",
        title="Performance",
        markdown_body=body,
        one_line_summary="s",
        source_shas=shas if shas is not None else ["s1"],
        revision=1,
        is_new=True,
    )


class TestStripUngrounded:
    def test_strips_fabricated_multiplier_sentence(self):
        # The benchmark proof case: "17× faster according to the README" with
        # no such figure in any source.
        page = _page(
            "# Performance\n\nCore design notes.\n"
            "According to the README, it is approximately 17× faster than V1. "
            "The core is written in Rust.\n"
        )
        events = list(strip_ungrounded_numerics([page], {"s1": "The core is written in Rust."}))
        assert "17×" not in page.markdown_body
        assert "written in Rust" in page.markdown_body  # rest of the line survives
        assert any("Stripped 1 ungrounded" in (e.message or "") for e in events)

    def test_grounded_multiplier_survives_spelling_variants(self):
        # Page says 17×, source says "17x" — same claim, different spelling.
        page = _page("# Performance\n\nIt is 17× faster than V1.\n")
        assert not list(strip_ungrounded_numerics([page], {"s1": "benchmarked at 17x faster"}))
        assert "17×" in page.markdown_body

    def test_grounded_via_times_spelling(self):
        page = _page("# Performance\n\nIt is 5-50x faster.\n")
        assert not list(strip_ungrounded_numerics([page], {"s1": "between 5-50 times faster"}))
        assert "5-50x" in page.markdown_body

    def test_partial_number_does_not_ground(self):
        # "217x" in the source must not ground a "17x" claim.
        page = _page("# Performance\n\nRoughly 17x faster.\n")
        list(strip_ungrounded_numerics([page], {"s1": "the 217x case"}))
        assert "17x" not in page.markdown_body

    def test_ungrounded_percentage_stripped(self):
        page = _page("# Performance\n\nMemory use drops by 45%.\n")
        list(strip_ungrounded_numerics([page], {"s1": "memory use drops"}))
        assert "45%" not in page.markdown_body

    def test_grounded_percentage_via_percent_word(self):
        page = _page("# Performance\n\nMemory use drops by 45%.\n")
        assert not list(strip_ungrounded_numerics([page], {"s1": "drops by 45 percent"}))

    def test_ungrounded_version_stripped(self):
        page = _page("# Performance\n\nRequires exactly v2.7.1 to run.\n")
        list(strip_ungrounded_numerics([page], {"s1": "requires a recent release"}))
        assert "v2.7.1" not in page.markdown_body

    def test_grounded_version_without_v_prefix(self):
        page = _page("# Performance\n\nShipped in v2.7.1.\n")
        assert not list(strip_ungrounded_numerics([page], {"s1": "shipped in 2.7.1"}))

    def test_bare_integers_and_decimals_not_checked(self):
        # "3 retries" / "2.5 seconds" are not claim-shaped; never stripped.
        page = _page("# Performance\n\nIt retries 3 times of course, waits 2.5 seconds, uses 8 workers.\n")
        body_before = page.markdown_body
        # "3 times" IS a multiplier claim; ground it. 2.5 / 8 alone are not.
        list(strip_ungrounded_numerics([page], {"s1": "retries 3 times"}))
        assert page.markdown_body == body_before

    def test_list_item_removed_whole(self):
        page = _page("# Performance\n\nIntro.\n\n- 17x faster than V1\n- Written in Rust\n")
        list(strip_ungrounded_numerics([page], {"s1": "Written in Rust"}))
        assert "17x" not in page.markdown_body
        assert "- Written in Rust" in page.markdown_body

    def test_table_row_removed_whole(self):
        page = _page("# Performance\n\n| claim | value |\n|---|---|\n| speedup | 17x |\n| lang | Rust |\n")
        list(strip_ungrounded_numerics([page], {"s1": "lang Rust"}))
        assert "17x" not in page.markdown_body
        assert "| lang | Rust |" in page.markdown_body

    def test_heading_never_stripped(self):
        page = _page("# Performance\n\n## The 17x claim\n\nBody text.\n")
        events = list(strip_ungrounded_numerics([page], {"s1": "body text"}))
        assert "## The 17x claim" in page.markdown_body
        assert any("Kept 1 unverifiable" in (e.message or "") for e in events)

    def test_missing_source_body_keeps_claim(self):
        # Conservative: with any cited body unavailable, nothing is stripped.
        page = _page("# Performance\n\nIt is 17x faster.\n", shas=["s1", "s2"])
        events = list(strip_ungrounded_numerics([page], {"s1": "unrelated"}))
        assert "17x" in page.markdown_body
        assert any("cited source(s) unavailable" in (e.message or "") for e in events)

    def test_multiple_claims_one_sentence_single_strip(self):
        page = _page("# Performance\n\nIt is 17x faster and uses 45% less memory.\nIt is fast.\n")
        events = list(strip_ungrounded_numerics([page], {"s1": "it is fast"}))
        assert "17x" not in page.markdown_body and "45%" not in page.markdown_body
        assert "It is fast." in page.markdown_body
        assert len(events) == 1  # one strip event for the page
