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

"""Tests for ``opentrace source-search`` CLI surface.

Exercises the full pipeline — FTS via Kuzu, post-FTS filtering, repo
resolution, and both output modes — against a real GraphStore in
``tmp_path``. Mocking the store would skip the parts most likely to
break (the parameterized Cypher), so the tests pay the cost of a real
DB to keep the surface honest.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from click.testing import CliRunner

from opentrace_agent.cli.source_search import strip_repo_prefix  # noqa: E402

real_ladybug = pytest.importorskip("real_ladybug")

from opentrace_agent.cli.main import app  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402


class TestStripRepoPrefix:
    """Pure-Python tests for the longest-prefix repo-id stripper."""

    def test_strips_multi_segment_repo_id(self) -> None:
        assert strip_repo_prefix("acme/widget/src/parser.py", ["acme/widget"]) == "src/parser.py"

    def test_exact_repo_id_match_returns_empty(self) -> None:
        """When path_like *is* the repo id (no remainder), result is empty."""
        assert strip_repo_prefix("acme/widget", ["acme/widget"]) == ""

    def test_longest_match_wins_when_repo_ids_nest(self) -> None:
        """A multi-segment id must be preferred over its single-segment prefix."""
        # Caller's contract: pass repo_ids sorted longest-first.
        repo_ids = ["acme/widget", "acme"]
        assert strip_repo_prefix("acme/widget/src/foo.py", repo_ids) == "src/foo.py"

    def test_orphan_falls_back_to_first_slash_split(self) -> None:
        """No matching repo id, but a slash present: drop the leading segment."""
        assert strip_repo_prefix("orphan/src/x.py", ["other-repo"]) == "src/x.py"

    def test_orphan_no_slash_returns_empty(self) -> None:
        """No matching repo id and no slash: nothing to strip."""
        assert strip_repo_prefix("foo.py", ["other-repo"]) == ""

    def test_empty_repo_ids_falls_back_to_split(self) -> None:
        assert strip_repo_prefix("a/b/c", []) == "b/c"


@pytest.fixture()
def search_store(tmp_path):
    """A GraphStore with Repository, Function, and Class nodes across two repos.

    The two-repo setup lets us exercise the ``--repo`` filter — same
    symbol names exist in both, so a filtered query *must* drop the
    other repo's hits to be considered correct.

    The writer connection is closed before yielding so the CLI under
    test can open its own read-only connection on the same DB without
    Kuzu segfaulting on concurrent opens.
    """
    db_path = str(tmp_path / "search.db")
    store = GraphStore(db_path)

    # Repository nodes
    store.add_node("repo-alpha", "Repository", "repo-alpha", {})
    store.add_node("repo-beta", "Repository", "repo-beta", {})

    # repo-alpha symbols
    store.add_node(
        "repo-alpha/src/parser.py",
        "File",
        "parser.py",
        {"path": "src/parser.py", "language": "python"},
    )
    store.add_node(
        "repo-alpha/src/parser.py::ParserService",
        "Class",
        "ParserService",
        {
            "path": "src/parser.py",
            "start_line": 10,
            "end_line": 50,
            "language": "python",
        },
    )
    store.add_node(
        "repo-alpha/src/parser.py::parse_input",
        "Function",
        "parse_input",
        {
            "path": "src/parser.py",
            "start_line": 60,
            "end_line": 75,
            "signature": "(text: str)",
            "summary": "Tokenize input string into AST nodes.",
        },
    )

    # repo-beta symbols (same kind of stuff, deliberate name overlap)
    store.add_node(
        "repo-beta/lib/parser.py",
        "File",
        "parser.py",
        {"path": "lib/parser.py", "language": "python"},
    )
    store.add_node(
        "repo-beta/lib/parser.py::parse_input",
        "Function",
        "parse_input",
        {
            "path": "lib/parser.py",
            "start_line": 1,
            "end_line": 20,
            "signature": "(s: str)",
        },
    )
    store.add_node(
        "repo-beta/lib/handler.py::HandlerClass",
        "Class",
        "HandlerClass",
        {
            "path": "lib/handler.py",
            "start_line": 5,
            "end_line": 100,
        },
    )

    # A Repository whose id and name diverge — exercises the contract
    # that --repo matches by id, not by name.
    store.add_node("rep-divergent-id", "Repository", "human-friendly-name", {})
    store.add_node(
        "rep-divergent-id/src/foo.py::parse_thing",
        "Function",
        "parse_thing",
        {"path": "src/foo.py", "start_line": 1, "end_line": 5},
    )

    # Owner/repo-style id (the form DirectoryWalker.walk documents) —
    # exercises that the Repo: text-output column and the --repo
    # filter both handle repo ids that themselves contain '/'.
    store.add_node("acme/widget", "Repository", "widget", {})
    store.add_node(
        "acme/widget/src/parser.py::parse_widget",
        "Function",
        "parse_widget",
        {"path": "src/parser.py", "start_line": 1, "end_line": 5},
    )

    store.close()
    yield db_path


def _invoke(db_path: str, *args: str) -> Any:
    """Run the click command against *db_path* with extra args."""
    return CliRunner().invoke(app, ["source-search", *args, "--db", db_path])


class TestNoRepoSearch:
    def test_finds_results_across_repos(self, search_store) -> None:
        db_path = search_store
        result = _invoke(db_path, "parse", "--limit", "10")

        assert result.exit_code == 0, result.output
        # Both repos' parse_input should appear in the unfiltered search.
        assert "repo-alpha/src/parser.py::parse_input" in result.output
        assert "repo-beta/lib/parser.py::parse_input" in result.output

    def test_text_format_has_expected_fields(self, search_store) -> None:
        db_path = search_store
        result = _invoke(db_path, "ParserService", "--limit", "5")

        assert result.exit_code == 0, result.output
        assert "[Class] ParserService" in result.output
        assert "Repo: repo-alpha" in result.output
        assert "File: src/parser.py" in result.output
        assert "Lines: 10-50" in result.output
        assert "Node ID: repo-alpha/src/parser.py::ParserService" in result.output

    def test_text_omits_relevance_score(self, search_store) -> None:
        # BM25 scores are deliberately omitted from text mode — they're
        # noise for LLM consumers and add no signal a human can act on.
        db_path = search_store
        result = _invoke(db_path, "ParserService", "--limit", "5")

        assert result.exit_code == 0, result.output
        assert "Relevance:" not in result.output
        assert "Score:" not in result.output


class TestRepoFilter:
    def test_repo_filter_excludes_other_repo(self, search_store) -> None:
        db_path = search_store
        result = _invoke(db_path, "parse", "--repo", "repo-alpha", "--limit", "10")

        assert result.exit_code == 0, result.output
        assert "repo-alpha/src/parser.py::parse_input" in result.output
        # The same symbol exists in repo-beta — it must be filtered out.
        assert "repo-beta" not in result.output

    def test_repo_filter_in_text_header(self, search_store) -> None:
        db_path = search_store
        result = _invoke(db_path, "parse", "--repo", "repo-alpha")

        assert result.exit_code == 0, result.output
        assert "in repo 'repo-alpha'" in result.output

    def test_unknown_repo_lists_candidates(self, search_store) -> None:
        db_path = search_store
        result = _invoke(db_path, "parse", "--repo", "does-not-exist")

        assert result.exit_code != 0
        assert "No repo with id 'does-not-exist'" in result.output
        assert "repo-alpha" in result.output
        assert "repo-beta" in result.output

    def test_repo_filter_uses_id_not_name(self, search_store) -> None:
        # The fixture's `rep-divergent-id` repo has node name
        # `human-friendly-name`; --repo must match the id.
        db_path = search_store

        ok = _invoke(db_path, "parse", "--repo", "rep-divergent-id")
        assert ok.exit_code == 0, ok.output
        assert "rep-divergent-id/src/foo.py::parse_thing" in ok.output

        nope = _invoke(db_path, "parse", "--repo", "human-friendly-name")
        assert nope.exit_code != 0
        assert "No repo with id 'human-friendly-name'" in nope.output


class TestNodeTypesFilter:
    def test_types_restricts_to_listed_types(self, search_store) -> None:
        db_path = search_store
        result = _invoke(
            db_path,
            "parse",
            "--types",
            "Function",
            "--limit",
            "10",
        )

        assert result.exit_code == 0, result.output
        # Function entries appear...
        assert "[Function] parse_input" in result.output
        # ...and Class/File ones don't.
        assert "[Class]" not in result.output
        assert "[File]" not in result.output

    def test_multiple_types(self, search_store) -> None:
        db_path = search_store
        result = _invoke(
            db_path,
            "Parser",
            "--types",
            "Class,Function",
            "--limit",
            "10",
        )

        assert result.exit_code == 0, result.output
        assert "[Class] ParserService" in result.output


class TestJsonOutput:
    def test_shape(self, search_store) -> None:
        db_path = search_store
        result = _invoke(
            db_path,
            "ParserService",
            "--repo",
            "repo-alpha",
            "--json",
        )

        assert result.exit_code == 0, result.output
        data = json.loads(result.output)

        assert data["query"] == "ParserService"
        assert data["repo"] == "repo-alpha"
        assert data["totalResults"] == 1
        assert data["truncated"] is False
        assert data["limit"] == 20
        assert len(data["results"]) == 1

        node = data["results"][0]
        assert node["id"] == "repo-alpha/src/parser.py::ParserService"
        assert node["name"] == "ParserService"
        assert node["type"] == "Class"
        assert isinstance(node["score"], float)
        assert node["properties"]["path"] == "src/parser.py"
        assert node["properties"]["start_line"] == 10
        assert node["properties"]["end_line"] == 50

    def test_empty_results_json(self, search_store) -> None:
        db_path = search_store
        result = _invoke(db_path, "zzznosuchsymbolzzz", "--json")

        assert result.exit_code == 0, result.output
        data = json.loads(result.output)
        assert data["totalResults"] == 0
        assert data["results"] == []
        assert data["truncated"] is False

    def test_repo_null_when_not_filtered(self, search_store) -> None:
        db_path = search_store
        result = _invoke(db_path, "parse_input", "--json")

        assert result.exit_code == 0, result.output
        data = json.loads(result.output)
        assert data["repo"] is None


class TestEmptyResults:
    def test_text_message_when_no_matches(self, search_store) -> None:
        db_path = search_store
        result = _invoke(db_path, "zzznosuchsymbolzzz")

        assert result.exit_code == 0, result.output
        assert "No results found for 'zzznosuchsymbolzzz'" in result.output
        assert "opentrace repos" in result.output  # hint to caller

    def test_text_message_includes_repo_filter(self, search_store) -> None:
        db_path = search_store
        result = _invoke(db_path, "zzznosuchsymbolzzz", "--repo", "repo-alpha")

        assert result.exit_code == 0, result.output
        assert "in repo 'repo-alpha'" in result.output


class TestLimitAndTruncation:
    def test_limit_caps_results_and_flags_truncated(self, search_store) -> None:
        # The fixture has multiple `parse*` matches across repos; a
        # tight --limit must cap the result set and signal truncation.
        db_path = search_store
        result = _invoke(db_path, "parse", "--limit", "2", "--json")

        assert result.exit_code == 0, result.output
        data = json.loads(result.output)
        assert len(data["results"]) == 2
        assert data["totalResults"] == 2
        assert data["truncated"] is True

    def test_truncated_false_when_under_limit(self, search_store) -> None:
        db_path = search_store
        result = _invoke(db_path, "ParserService", "--limit", "10", "--json")

        assert result.exit_code == 0, result.output
        data = json.loads(result.output)
        assert len(data["results"]) < 10
        assert data["truncated"] is False

    def test_truncated_false_when_results_exactly_match_limit(self, search_store) -> None:
        """If there are exactly *N* matches in the graph and the user
        asks for ``--limit N``, ``truncated`` must be ``False``.
        """
        db_path = search_store
        # Restrict to one repo + Class-only so the candidate set is
        # tightly known: repo-alpha has exactly one Class
        # (ParserService) matching "Parser".
        result = _invoke(
            db_path,
            "Parser",
            "--repo",
            "repo-alpha",
            "--types",
            "Class",
            "--limit",
            "1",
            "--json",
        )

        assert result.exit_code == 0, result.output
        data = json.loads(result.output)
        assert len(data["results"]) == 1
        assert data["totalResults"] == 1
        assert data["truncated"] is False


class TestCombinedFilters:
    def test_repo_and_types_apply_together(self, search_store) -> None:
        db_path = search_store
        result = _invoke(
            db_path,
            "parse",
            "--repo",
            "repo-alpha",
            "--types",
            "Function",
            "--limit",
            "10",
        )

        assert result.exit_code == 0, result.output
        # Only repo-alpha Functions remain.
        assert "[Function] parse_input" in result.output
        # Class in repo-alpha is filtered out by --types.
        assert "[Class] ParserService" not in result.output
        # repo-beta is filtered out by --repo.
        assert "repo-beta" not in result.output


class TestRepoIdWithSlash:
    """Repo ids may themselves contain '/' (e.g. 'owner/repo' style).

    Verifies the two places that have to handle this: the ``--repo``
    Cypher predicate and the text output's ``Repo:`` column.
    """

    def test_filter_matches_owner_repo_style_id(self, search_store) -> None:
        db_path = search_store
        result = _invoke(db_path, "parse", "--repo", "acme/widget", "--limit", "10")

        assert result.exit_code == 0, result.output
        assert "acme/widget/src/parser.py::parse_widget" in result.output
        # Other repos are filtered out — 'acme/widget' is the *only*
        # path-prefix match for the predicate `id STARTS WITH 'acme/widget/'`.
        assert "repo-alpha" not in result.output
        assert "repo-beta" not in result.output

    def test_text_repo_column_shows_full_owner_repo_id(self, search_store) -> None:
        # A naive split on the first '/' would attribute
        # acme/widget/src/parser.py::parse_widget to repo "acme";
        # the assertion below pins the full owner/repo prefix.
        db_path = search_store
        result = _invoke(db_path, "parse_widget", "--limit", "10")

        assert result.exit_code == 0, result.output
        assert "Repo: acme/widget" in result.output
        # Negative: no row was attributed to the truncated 'acme'.
        for line in result.output.splitlines():
            if line.startswith("  Repo:"):
                assert line.strip() != "Repo: acme"
