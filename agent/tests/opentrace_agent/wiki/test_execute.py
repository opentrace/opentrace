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

from opentrace_agent.wiki.ingest.execute import force_h1


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
