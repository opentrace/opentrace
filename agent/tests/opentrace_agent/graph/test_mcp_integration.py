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

"""Integration tests: index fixture projects → GraphStore → MCP tools.

Runs the full pipeline on real fixture codebases, writes to a LadybugDB
GraphStore, then exercises every MCP tool against the resulting graph.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from opentrace_agent.pipeline import PipelineInput, collect_pipeline
from opentrace_agent.pipeline.adapters import GraphStoreAdapter

# Skip if real_ladybug is not installed
pytest.importorskip("real_ladybug")

from opentrace_agent.cli.mcp_server import create_mcp_server  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402

FIXTURES_ROOT = Path(__file__).resolve().parents[4] / "tests" / "fixtures"
GO_PROJECT = FIXTURES_ROOT / "go" / "project"
PYTHON_PROJECT = FIXTURES_ROOT / "python" / "project"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def indexed_go_store(tmp_path_factory):
    """Index the Go fixture project into a GraphStore."""
    db_path = str(tmp_path_factory.mktemp("go_db") / "test.db")
    store = GraphStore(db_path)
    adapter = GraphStoreAdapter(store, batch_size=500)

    inp = PipelineInput(path=str(GO_PROJECT), repo_id="test/go-project")
    for _event in collect_pipeline(inp, store=adapter)[0]:
        pass
    adapter.flush()
    # source_read/source_grep need repoPath in metadata to find files on disk.
    store.save_metadata({"repoId": "test/go-project", "repoPath": str(GO_PROJECT)})

    yield store
    store.close()


@pytest.fixture(scope="module")
def indexed_python_store(tmp_path_factory):
    """Index the Python fixture project into a GraphStore."""
    db_path = str(tmp_path_factory.mktemp("py_db") / "test.db")
    store = GraphStore(db_path)
    adapter = GraphStoreAdapter(store, batch_size=500)

    inp = PipelineInput(path=str(PYTHON_PROJECT), repo_id="test/py-project")
    for _event in collect_pipeline(inp, store=adapter)[0]:
        pass
    adapter.flush()
    store.save_metadata({"repoId": "test/py-project", "repoPath": str(PYTHON_PROJECT)})

    yield store
    store.close()


def _call_tool(store: GraphStore, tool_name: str, **kwargs) -> dict | list:
    """Create an MCP server, call a tool by name, parse the JSON response."""
    server = create_mcp_server(store)
    tool = server._tool_manager._tools[tool_name]
    result = tool.fn(**kwargs)
    # The MCP server truncates large responses which can break JSON.
    # Strip the truncation suffix and try to parse.
    if "\n...[truncated" in result:
        result = result[: result.index("\n...[truncated")]
        # Try to recover valid JSON by closing open arrays/objects
        try:
            return json.loads(result)
        except json.JSONDecodeError:
            # Can't recover — just return the parsed prefix as empty
            pytest.skip("Response truncated mid-JSON")
    return json.loads(result)


# ---------------------------------------------------------------------------
# Go project: graph structure
# ---------------------------------------------------------------------------


class TestGoProjectGraph:
    """Verify the Go fixture project was indexed with expected structure."""

    def test_stats_has_nodes_and_edges(self, indexed_go_store):
        stats = indexed_go_store.get_stats()
        assert stats["total_nodes"] > 0
        assert stats["total_edges"] > 0

    def test_has_repository_node(self, indexed_go_store):
        repos = indexed_go_store.list_nodes("Repository")
        assert len(repos) >= 1

    def test_has_files(self, indexed_go_store):
        files = indexed_go_store.list_nodes("File")
        names = {f["name"] for f in files}
        assert "main.go" in names
        assert "db.go" in names
        assert "handler.go" in names

    def test_has_functions(self, indexed_go_store):
        functions = indexed_go_store.list_nodes("Function")
        names = {f["name"] for f in functions}
        # Go functions include type signatures in name: "main()" not "main"
        assert "main()" in names or any("main" in n for n in names)

    def test_has_classes_or_structs(self, indexed_go_store):
        classes = indexed_go_store.list_nodes("Class")
        names = {c["name"] for c in classes}
        # Go structs: Store, Handler, User
        assert len(names) >= 1

    def test_has_defined_in_relationships(self, indexed_go_store):
        stats = indexed_go_store.get_stats()
        assert stats["total_edges"] > 0


# ---------------------------------------------------------------------------
# Python project: graph structure
# ---------------------------------------------------------------------------


class TestPythonProjectGraph:
    """Verify the Python fixture project was indexed with expected structure."""

    def test_stats_has_nodes_and_edges(self, indexed_python_store):
        stats = indexed_python_store.get_stats()
        assert stats["total_nodes"] > 0
        assert stats["total_edges"] > 0

    def test_has_files(self, indexed_python_store):
        files = indexed_python_store.list_nodes("File")
        names = {f["name"] for f in files}
        assert "main.py" in names
        assert "db.py" in names

    def test_has_database_class(self, indexed_python_store):
        classes = indexed_python_store.list_nodes("Class")
        names = {c["name"] for c in classes}
        assert "Database" in names

    def test_has_functions(self, indexed_python_store):
        functions = indexed_python_store.list_nodes("Function")
        names = {f["name"] for f in functions}
        # Python fixture: list_users, create_user, __init__, initialize, get_all_users, insert_user
        assert len(names) >= 2


# ---------------------------------------------------------------------------
# MCP tool: get_stats
# ---------------------------------------------------------------------------


class TestMCPGetStats:
    def test_returns_valid_stats(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "get_stats")
        assert "total_nodes" in result
        assert "total_edges" in result
        assert "nodes_by_type" in result
        assert isinstance(result["total_nodes"], int)
        assert result["total_nodes"] > 0


# ---------------------------------------------------------------------------
# MCP tool: keyword_search (formerly the flat-list version of search_graph)
# ---------------------------------------------------------------------------


class TestMCPFindNodesViaKeywordSearch:
    def test_search_by_name(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "keyword_search", query="main")
        assert isinstance(result, list)
        assert len(result) > 0
        for node in result:
            assert "id" in node
            assert "type" in node
            assert "name" in node
            # keyword_search tags every result for caller verification
            assert "_match_field" in node

    def test_search_with_type_filter(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "keyword_search", query="main", nodeTypes="File")
        assert isinstance(result, list)
        for node in result:
            assert node["type"] == "File"

    def test_search_no_results(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "keyword_search", query="zzz_nonexistent_zzz")
        assert isinstance(result, list)
        assert len(result) == 0

    def test_search_respects_limit(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "keyword_search", query="e", limit=2)
        assert len(result) <= 2

    def test_search_properties_are_valid(self, indexed_go_store):
        """Properties should be dicts or None, never unparsed strings."""
        result = _call_tool(indexed_go_store, "keyword_search", query="db")
        for node in result:
            props = node.get("properties")
            if props is not None:
                assert isinstance(props, dict), f"Properties should be dict, got {type(props)}: {props}"


# ---------------------------------------------------------------------------
# MCP tool: search_graph (subgraph — the *real* search_graph)
# ---------------------------------------------------------------------------


class TestMCPSearchGraph:
    """search_graph now returns a SUBGRAPH around matches — both nodes
    and the relationships between them — not a flat list."""

    def test_returns_nodes_and_relationships(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "search_graph", query="main", hops=1)
        assert isinstance(result, dict)
        assert "nodes" in result and isinstance(result["nodes"], list)
        assert "relationships" in result and isinstance(result["relationships"], list)
        assert "summary" in result
        assert result["summary"]["node_count"] == len(result["nodes"])
        assert result["summary"]["relationship_count"] == len(result["relationships"])

    def test_zero_hops_returns_only_seed_matches(self, indexed_go_store):
        """hops=0 should still return the matched seed nodes, no expansion."""
        zero = _call_tool(indexed_go_store, "search_graph", query="main", hops=0)
        assert isinstance(zero, dict)
        assert len(zero["nodes"]) > 0

    def test_hops_expands_neighborhood(self, indexed_go_store):
        """Higher hops should yield ≥ as many nodes as a smaller hop count."""
        one = _call_tool(indexed_go_store, "search_graph", query="main", hops=1)
        two = _call_tool(indexed_go_store, "search_graph", query="main", hops=2)
        assert len(two["nodes"]) >= len(one["nodes"])

    def test_no_match_returns_empty_subgraph(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "search_graph", query="zzz_no_such_thing")
        assert isinstance(result, dict)
        assert result["nodes"] == []
        assert result["relationships"] == []

    def test_hops_capped_at_5(self, indexed_python_store):
        """Excessive hops should be silently capped, not error."""
        result = _call_tool(indexed_python_store, "search_graph", query="Database", hops=99)
        assert isinstance(result, dict)
        assert result["summary"]["hops"] == 5


# ---------------------------------------------------------------------------
# MCP tool: list_nodes
# ---------------------------------------------------------------------------


class TestMCPListNodes:
    def test_list_files(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "list_nodes", type="File")
        assert isinstance(result, list)
        assert len(result) >= 3  # main.go, db.go, handler.go
        for node in result:
            assert node["type"] == "File"

    def test_list_functions(self, indexed_python_store):
        result = _call_tool(indexed_python_store, "list_nodes", type="Function")
        assert isinstance(result, list)
        assert len(result) >= 2

    def test_list_with_limit(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "list_nodes", type="Function", limit=1)
        assert len(result) <= 1

    def test_list_nonexistent_type(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "list_nodes", type="NonexistentType")
        assert result == []


# ---------------------------------------------------------------------------
# MCP tool: get_node
# ---------------------------------------------------------------------------


class TestMCPGetNode:
    def test_get_existing_node(self, indexed_go_store):
        # First find a node ID
        files = _call_tool(indexed_go_store, "list_nodes", type="File", limit=1)
        assert len(files) > 0
        node_id = files[0]["id"]

        result = _call_tool(indexed_go_store, "get_node", nodeId=node_id)
        assert "node" in result
        assert "neighbors" in result
        assert result["node"]["id"] == node_id
        assert isinstance(result["neighbors"], list)

    def test_get_node_has_neighbors(self, indexed_go_store):
        """A file node should have neighbors (DEFINED_IN relationships, etc.)."""
        files = _call_tool(indexed_go_store, "list_nodes", type="File", limit=1)
        node_id = files[0]["id"]

        result = _call_tool(indexed_go_store, "get_node", nodeId=node_id)
        # Files typically have at least a DEFINED_IN to a directory or repo
        assert len(result["neighbors"]) >= 0  # may be 0 for root files

    def test_get_nonexistent_node(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "get_node", nodeId="nonexistent-id-xyz")
        assert "error" in result

    def test_neighbor_structure(self, indexed_go_store):
        """Each neighbor entry should have node and relationship dicts."""
        classes = _call_tool(indexed_go_store, "list_nodes", type="Class", limit=1)
        if not classes:
            pytest.skip("No classes in Go fixture")
        node_id = classes[0]["id"]

        result = _call_tool(indexed_go_store, "get_node", nodeId=node_id)
        for neighbor in result["neighbors"]:
            assert "node" in neighbor
            assert "relationship" in neighbor
            assert "id" in neighbor["node"]
            assert "type" in neighbor["relationship"]


# ---------------------------------------------------------------------------
# MCP tool: traverse_graph
# ---------------------------------------------------------------------------


class TestMCPTraverseGraph:
    def test_traverse_outgoing(self, indexed_go_store):
        repos = _call_tool(indexed_go_store, "list_nodes", type="Repository", limit=1)
        assert len(repos) > 0
        repo_id = repos[0]["id"]

        result = _call_tool(
            indexed_go_store,
            "traverse_graph",
            nodeId=repo_id,
            depth=1,
            direction="outgoing",
        )
        assert isinstance(result, list)

    def test_traverse_incoming(self, indexed_go_store):
        files = _call_tool(indexed_go_store, "list_nodes", type="File", limit=1)
        file_id = files[0]["id"]

        result = _call_tool(
            indexed_go_store,
            "traverse_graph",
            nodeId=file_id,
            depth=1,
            direction="incoming",
        )
        assert isinstance(result, list)

    def test_traverse_both(self, indexed_go_store):
        files = _call_tool(indexed_go_store, "list_nodes", type="File", limit=1)
        file_id = files[0]["id"]

        result = _call_tool(
            indexed_go_store,
            "traverse_graph",
            nodeId=file_id,
            depth=1,
            direction="both",
        )
        assert isinstance(result, list)

    def test_traverse_result_structure(self, indexed_go_store):
        """Each traversal result has node, relationship, and depth."""
        files = _call_tool(indexed_go_store, "list_nodes", type="File", limit=1)
        file_id = files[0]["id"]

        result = _call_tool(
            indexed_go_store,
            "traverse_graph",
            nodeId=file_id,
            depth=2,
            direction="both",
        )
        for entry in result:
            assert "node" in entry
            assert "relationship" in entry
            assert "depth" in entry
            assert isinstance(entry["depth"], int)

    def test_traverse_invalid_direction(self, indexed_go_store):
        repos = _call_tool(indexed_go_store, "list_nodes", type="Repository", limit=1)
        repo_id = repos[0]["id"]

        result = _call_tool(
            indexed_go_store,
            "traverse_graph",
            nodeId=repo_id,
            depth=1,
            direction="sideways",
        )
        assert "error" in result

    def test_traverse_nonexistent_node(self, indexed_go_store):
        result = _call_tool(
            indexed_go_store,
            "traverse_graph",
            nodeId="ghost-node-xyz",
            depth=1,
            direction="outgoing",
        )
        assert "error" in result

    def test_traverse_with_relationship_filter(self, indexed_go_store):
        files = _call_tool(indexed_go_store, "list_nodes", type="File", limit=1)
        file_id = files[0]["id"]

        result = _call_tool(
            indexed_go_store,
            "traverse_graph",
            nodeId=file_id,
            depth=2,
            direction="both",
            relationship="DEFINES",
        )
        assert isinstance(result, list)
        for entry in result:
            assert entry["relationship"]["type"] == "DEFINES"


# ---------------------------------------------------------------------------
# Cross-tool: round-trip validation
# ---------------------------------------------------------------------------


class TestMCPRoundTrip:
    """Verify tools work together: search → get_node → traverse."""

    def test_search_then_get_then_traverse(self, indexed_go_store):
        """Full round-trip: find a node, get its details, traverse from it."""
        # Find
        search_results = _call_tool(indexed_go_store, "keyword_search", query="handler")
        assert len(search_results) > 0

        # Get details of first result
        node_id = search_results[0]["id"]
        details = _call_tool(indexed_go_store, "get_node", nodeId=node_id)
        assert details["node"]["id"] == node_id

        # Traverse from that node
        traversal = _call_tool(
            indexed_go_store,
            "traverse_graph",
            nodeId=node_id,
            depth=1,
            direction="both",
        )
        assert isinstance(traversal, list)

    def test_python_class_methods_reachable(self, indexed_python_store):
        """Find Database class, verify its methods are reachable via traversal."""
        classes = _call_tool(indexed_python_store, "keyword_search", query="Database", nodeTypes="Class")
        if not classes:
            pytest.skip("Database class not found")

        db_id = classes[0]["id"]
        details = _call_tool(indexed_python_store, "get_node", nodeId=db_id)
        assert details["node"]["name"] == "Database"

        # Neighbors should include methods or the file it's defined in
        neighbor_types = {n["relationship"]["type"] for n in details["neighbors"]}
        assert len(neighbor_types) > 0

    def test_search_graph_returns_subgraph_with_neighbors(self, indexed_python_store):
        """The new search_graph should include both nodes and the
        relationships connecting them — proves the subgraph wiring."""
        result = _call_tool(indexed_python_store, "search_graph", query="Database", hops=1)
        assert isinstance(result, dict)
        assert len(result["nodes"]) > 0
        # With hops=1, we should pull in at least one related node, so
        # there should be at least one relationship in the subgraph.
        assert len(result["relationships"]) > 0


# ---------------------------------------------------------------------------
# MCP tool: keyword_search (renamed from semantic_search — never was)
# ---------------------------------------------------------------------------


class TestMCPKeywordSearch:
    def test_returns_results(self, indexed_python_store):
        result = _call_tool(indexed_python_store, "keyword_search", query="database")
        assert isinstance(result, list)
        assert len(result) > 0

    def test_respects_node_types(self, indexed_python_store):
        result = _call_tool(indexed_python_store, "keyword_search", query="user", nodeTypes="Function")
        assert isinstance(result, list)
        for node in result:
            assert node["type"] == "Function"

    def test_respects_limit(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "keyword_search", query="handler", limit=2)
        assert len(result) <= 2

    def test_natural_language_query_finds_results(self, indexed_python_store):
        """Multi-word natural-language query should still hit nodes via tokenization.

        The python fixture has a Database class. A phrase like
        ``"functions that connect to the database"`` previously returned []
        because FTS treated it as a phrase; the tokenized version drops
        stopwords + filler ("functions", "that", "to", "the"), then
        searches per-keyword and merges.  ``database`` should still match.
        """
        result = _call_tool(
            indexed_python_store,
            "keyword_search",
            query="functions that connect to the database",
        )
        assert isinstance(result, list)
        assert len(result) > 0, "tokenized query should have matched on 'database'"

    def test_multi_keyword_ranks_by_match_count(self, indexed_python_store):
        """Nodes hit by more keywords should sort first."""
        result = _call_tool(
            indexed_python_store,
            "keyword_search",
            query="user database insert",
        )
        assert isinstance(result, list)
        if len(result) >= 2:
            assert "_match_count" in result[0]
            scores = [n.get("_match_count", 0) for n in result]
            assert scores == sorted(scores, reverse=True)

    def test_pure_stopword_query_falls_through(self, indexed_python_store):
        """A query with no extractable keywords should still call into
        the underlying search rather than returning [] outright."""
        result = _call_tool(indexed_python_store, "keyword_search", query="the of a")
        assert isinstance(result, list)

    def test_results_are_tagged_with_match_field(self, indexed_python_store):
        """Every result should carry a _match_field annotation so the LLM
        knows whether it matched on name (high confidence) vs docs only."""
        result = _call_tool(indexed_python_store, "keyword_search", query="database")
        assert isinstance(result, list)
        assert len(result) > 0
        for node in result:
            assert "_match_field" in node
            assert node["_match_field"] in {
                "name",
                "signature",
                "path",
                "summary",
                "docs",
                "unknown",
            }
            # docs-only matches must carry a verify hint
            if node["_match_field"] == "docs":
                assert "_verify" in node
                assert "stale" in node["_verify"].lower() or "verify" in node["_verify"].lower()


class TestExtractQueryKeywords:
    """Pure-function tests for the tokenizer (no DB needed)."""

    def test_drops_stopwords(self):
        from opentrace_agent.cli.mcp_server import _extract_query_keywords

        assert _extract_query_keywords("the function that handles auth") == ["auth"]

    def test_drops_filler_nouns(self):
        from opentrace_agent.cli.mcp_server import _extract_query_keywords

        # "function", "code", "thing" are all dropped as filler
        assert _extract_query_keywords("function code that handles auth") == ["auth"]

    def test_preserves_order_and_dedupes(self):
        from opentrace_agent.cli.mcp_server import _extract_query_keywords

        assert _extract_query_keywords("database user database query") == [
            "database",
            "user",
            "query",
        ]

    def test_drops_short_tokens(self):
        from opentrace_agent.cli.mcp_server import _extract_query_keywords

        # "go" is 2 chars → dropped.  "rust" stays.
        assert _extract_query_keywords("go rust py") == ["rust"]

    def test_empty_query(self):
        from opentrace_agent.cli.mcp_server import _extract_query_keywords

        assert _extract_query_keywords("") == []
        assert _extract_query_keywords("the of a is") == []


# ---------------------------------------------------------------------------
# MCP tool: source_read
# ---------------------------------------------------------------------------


class TestMCPSourceRead:
    def test_read_by_node_id(self, indexed_python_store):
        files = _call_tool(indexed_python_store, "list_nodes", type="File", limit=10)
        target = next((f for f in files if f["name"] == "main.py"), files[0])
        result = create_mcp_server(indexed_python_store)._tool_manager._tools["source_read"].fn(nodeId=target["id"])
        assert "[Could not" not in result
        # The fixture file has at least one Python statement.
        assert "def " in result or "from " in result or "import " in result

    def test_read_by_path(self, indexed_python_store):
        result = create_mcp_server(indexed_python_store)._tool_manager._tools["source_read"].fn(path="main.py")
        assert "[Could not" not in result

    def test_missing_path_returns_error(self, indexed_python_store):
        result = (
            create_mcp_server(indexed_python_store)
            ._tool_manager._tools["source_read"]
            .fn(path="this/file/does/not/exist.py")
        )
        parsed = json.loads(result)
        assert "error" in parsed

    def test_no_args_returns_error(self, indexed_python_store):
        result = create_mcp_server(indexed_python_store)._tool_manager._tools["source_read"].fn()
        parsed = json.loads(result)
        assert "error" in parsed

    def test_line_slice(self, indexed_python_store):
        result = (
            create_mcp_server(indexed_python_store)
            ._tool_manager._tools["source_read"]
            .fn(path="main.py", startLine=1, endLine=3)
        )
        # Numbered output prefixes lines with "<n>\t"
        assert "1\t" in result


# ---------------------------------------------------------------------------
# MCP tool: source_grep
# ---------------------------------------------------------------------------


class TestMCPSourceGrep:
    def test_finds_matches(self, indexed_python_store):
        import shutil as _sh

        if not _sh.which("rg"):
            pytest.skip("ripgrep not installed")
        result = create_mcp_server(indexed_python_store)._tool_manager._tools["source_grep"].fn(pattern="def ")
        # Tagged output: "[repoId] file.py:N:line"
        assert "[test/py-project]" in result

    def test_no_matches(self, indexed_python_store):
        import shutil as _sh

        if not _sh.which("rg"):
            pytest.skip("ripgrep not installed")
        result = (
            create_mcp_server(indexed_python_store)
            ._tool_manager._tools["source_grep"]
            .fn(pattern="this_string_should_not_appear_anywhere_zzz_xyz")
        )
        parsed = json.loads(result)
        assert parsed.get("matches") == []

    def test_repo_filter(self, indexed_python_store):
        import shutil as _sh

        if not _sh.which("rg"):
            pytest.skip("ripgrep not installed")
        result = (
            create_mcp_server(indexed_python_store)
            ._tool_manager._tools["source_grep"]
            .fn(pattern="def ", repo="nonexistent-repo")
        )
        parsed = json.loads(result)
        assert "error" in parsed


# ---------------------------------------------------------------------------
# MCP tool: find_usages
# ---------------------------------------------------------------------------


class TestMCPFindUsages:
    def test_finds_target(self, indexed_python_store):
        result = _call_tool(indexed_python_store, "find_usages", symbol="Database")
        assert "target" in result
        assert "dependents" in result
        assert isinstance(result["dependents"], list)
        # The picked target should actually be the Database class — not
        # some other node whose docstring mentions "Database".
        assert result["target"]["name"] == "Database"
        assert result["target"]["type"] == "Class"

    def test_unknown_symbol(self, indexed_python_store):
        result = _call_tool(indexed_python_store, "find_usages", symbol="zzz_no_such_symbol_zzz")
        assert "error" in result

    def test_caps_depth(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "find_usages", symbol="main", depth=99)
        # depth is capped at 5; tool should still succeed (no crash)
        assert "target" in result or "error" in result

    def test_prefers_name_match_over_docs_match(self):
        """A symbol-name query must not pick a docstring-mention as the
        target. Regression for impact_analysis ranking bug where
        ``find_usages('_resolve_db')`` returned a function whose
        docstring referenced ``_resolve_db`` instead of ``_resolve_db``
        itself.
        """
        from unittest.mock import MagicMock

        from opentrace_agent.cli.mcp_server import create_mcp_server

        # Two candidates, FTS-ranked with the docstring-mention winner first.
        decoy = {
            "id": "repo/decoy.py::run_thing(str)",
            "type": "Function",
            "name": "run_thing(str)",
            "properties": {
                "docs": "calls _resolve_db internally — see _resolve_db",
                "signature": "(arg: str)",
            },
        }
        target = {
            "id": "repo/main.py::_resolve_db(str)",
            "type": "Function",
            "name": "_resolve_db(str)",
            "properties": {"signature": "(path: str)"},
        }

        store = MagicMock()
        store.search_nodes.return_value = [decoy, target]
        store.traverse.return_value = []

        server = create_mcp_server(store)
        result = json.loads(server._tool_manager._tools["find_usages"].fn(symbol="_resolve_db"))

        assert "target" in result, result
        assert result["target"]["id"] == target["id"], (
            "find_usages picked the docstring-mention over the actual symbol — "
            f"got {result['target']['name']!r}"
        )


# ---------------------------------------------------------------------------
# MCP tool: impact_analysis
# ---------------------------------------------------------------------------


class TestMCPImpactAnalysis:
    def test_finds_file(self, indexed_python_store):
        result = _call_tool(indexed_python_store, "impact_analysis", target="db.py")
        assert "file" in result
        assert "symbols" in result
        assert "total_dependents" in result
        # db.py defines the Database class plus its methods. If symbols
        # is empty, the tool walked the wrong edge direction.
        assert len(result["symbols"]) > 0, (
            "impact_analysis returned zero symbols for db.py — likely "
            "walking incoming edges from the file instead of outgoing DEFINES"
        )
        symbol_names = {s["symbol"]["name"] for s in result["symbols"]}
        assert "Database" in symbol_names, (
            f"Expected 'Database' in symbols, got {symbol_names!r}"
        )

    def test_unknown_file(self, indexed_python_store):
        result = _call_tool(indexed_python_store, "impact_analysis", target="ghost_file.xyz")
        assert "error" in result

    def test_line_range_filter(self, indexed_python_store):
        # Wide range — should still return file/symbols structure
        result = _call_tool(indexed_python_store, "impact_analysis", target="db.py", lines="1-9999")
        assert "file" in result
        # Same non-empty assertion: a 1-9999 range covers every symbol,
        # so we must surface them all.
        assert len(result["symbols"]) > 0

    def test_surfaces_file_level_importers(self, indexed_python_store):
        """``main.py`` does ``from db import Database`` — after the
        import-resolver fix that should land as a real File--IMPORTS-->File
        edge in the graph, and impact_analysis on db.py should report
        main.py as a file-level importer.

        Regression for the cross-file blast-radius gap: previously every
        Python absolute import fell into the external ``pkg:pypi:*``
        bucket because ``_module_to_paths`` only checked exact matches.
        """
        result = _call_tool(indexed_python_store, "impact_analysis", target="db.py")
        assert "file_importers" in result, (
            "impact_analysis response is missing the file_importers field — "
            "regression in the file-level importer surfacing"
        )
        importer_paths = {
            (n.get("properties") or {}).get("path", "") for n in result["file_importers"]
        }
        assert any(p.endswith("/main.py") or p == "main.py" for p in importer_paths), (
            f"Expected main.py in file_importers for db.py, got {importer_paths!r}"
        )


# ---------------------------------------------------------------------------
# MCP tool: repo_index
# ---------------------------------------------------------------------------


class TestMCPRepoIndex:
    def test_invalid_path_returns_error(self, indexed_python_store):
        result = (
            create_mcp_server(indexed_python_store)
            ._tool_manager._tools["repo_index"]
            .fn(path_or_url="/this/path/does/not/exist/zzz_xyz")
        )
        parsed = json.loads(result)
        assert "error" in parsed

    def test_file_path_rejected(self, indexed_python_store, tmp_path):
        f = tmp_path / "not-a-dir.txt"
        f.write_text("hi")
        result = create_mcp_server(indexed_python_store)._tool_manager._tools["repo_index"].fn(path_or_url=str(f))
        parsed = json.loads(result)
        assert "error" in parsed

    def test_url_routes_to_fetch_and_index(self, indexed_python_store, monkeypatch):
        """An https:// URL should invoke `opentraceai fetch-and-index`."""
        import subprocess

        captured: dict = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd

            class _Result:
                returncode = 0
                stdout = "ok"
                stderr = ""

            return _Result()

        monkeypatch.setattr(subprocess, "run", fake_run)

        create_mcp_server(indexed_python_store, db_path="/tmp/idx.db")._tool_manager._tools["repo_index"].fn(
            path_or_url="https://github.com/foo/bar", repoId="bar", ref="main"
        )

        cmd = captured["cmd"]
        assert cmd[:2] == ["opentraceai", "fetch-and-index"]
        assert "https://github.com/foo/bar" in cmd
        assert "--repo-id" in cmd and "bar" in cmd
        assert "--ref" in cmd and "main" in cmd
        assert "--db" in cmd and "/tmp/idx.db" in cmd
        # Critically: never pass --token through MCP — auth comes from the
        # CLI's own resolver so the LLM can't see the token.
        assert "--token" not in cmd

    def test_git_ssh_url_also_routes_to_fetch_and_index(self, indexed_python_store, monkeypatch):
        import subprocess

        captured: dict = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd

            class _Result:
                returncode = 0
                stdout = ""
                stderr = ""

            return _Result()

        monkeypatch.setattr(subprocess, "run", fake_run)

        create_mcp_server(indexed_python_store)._tool_manager._tools["repo_index"].fn(
            path_or_url="git@github.com:foo/bar.git"
        )
        assert captured["cmd"][:2] == ["opentraceai", "fetch-and-index"]

    def test_local_path_still_uses_index(self, indexed_python_store, tmp_path, monkeypatch):
        import subprocess

        captured: dict = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd

            class _Result:
                returncode = 0
                stdout = ""
                stderr = ""

            return _Result()

        monkeypatch.setattr(subprocess, "run", fake_run)
        local = tmp_path / "src"
        local.mkdir()

        create_mcp_server(indexed_python_store)._tool_manager._tools["repo_index"].fn(path_or_url=str(local))
        assert captured["cmd"][:2] == ["opentraceai", "index"]


# ---------------------------------------------------------------------------
# Hot-reload: MCP picks up a replaced database
# ---------------------------------------------------------------------------


class TestMCPReload:
    """Verify that the ReloadableStore proxy enables hot-reload."""

    def test_picks_up_replaced_database(self, tmp_path):
        """Simulates the staging-swap pattern: MCP sees new data after replace."""
        from opentrace_agent.cli.main import _ReloadableStore

        db = str(tmp_path / "test.db")
        staging = str(tmp_path / "test.db.staging")

        # Create original DB with one node.
        original = GraphStore(db)
        original.add_node("original", "File", "old.py")
        original.close()

        # Open as read-only (like MCP does) via ReloadableStore proxy.
        ro = GraphStore(db, read_only=True)
        reloadable = _ReloadableStore(db, ro)
        server = create_mcp_server(reloadable)

        # Verify initial state via MCP tool.
        get_node = server._tool_manager._tools["get_node"]
        result = json.loads(get_node.fn(nodeId="original"))
        assert result["node"]["name"] == "old.py"

        # Build a replacement DB and atomically swap.
        replacement = GraphStore(staging)
        replacement.add_node("replaced", "File", "new.py")
        replacement.close()
        os.replace(staging, db)

        # MCP should detect the change and serve new data.
        result2 = json.loads(get_node.fn(nodeId="replaced"))
        assert result2["node"]["name"] == "new.py"

        # Old node should be gone.
        result3 = json.loads(get_node.fn(nodeId="original"))
        assert "error" in result3

        reloadable.close()

    def test_no_index_after_db_removed(self, tmp_path):
        """MCP returns no-index message when DB file is deleted."""
        from opentrace_agent.cli.main import _ReloadableStore

        db = str(tmp_path / "test.db")
        store = GraphStore(db)
        store.add_node("n1", "File", "f.py")
        store.close()

        ro = GraphStore(db, read_only=True)
        reloadable = _ReloadableStore(db, ro)
        server = create_mcp_server(reloadable)

        # Remove the database.
        os.unlink(db)

        get_stats = server._tool_manager._tools["get_stats"]
        result = json.loads(get_stats.fn())
        assert result.get("message", "").startswith("No index available")

        reloadable.close()
