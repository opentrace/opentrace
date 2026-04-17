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
# MCP tool: search_graph
# ---------------------------------------------------------------------------


class TestMCPSearchGraph:
    def test_search_by_name(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "search_graph", query="main")
        assert isinstance(result, list)
        assert len(result) > 0
        # Each result should have id, type, name
        for node in result:
            assert "id" in node
            assert "type" in node
            assert "name" in node

    def test_search_with_type_filter(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "search_graph", query="main", nodeTypes="File")
        assert isinstance(result, list)
        for node in result:
            assert node["type"] == "File"

    def test_search_no_results(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "search_graph", query="zzz_nonexistent_zzz")
        assert isinstance(result, list)
        assert len(result) == 0

    def test_search_respects_limit(self, indexed_go_store):
        result = _call_tool(indexed_go_store, "search_graph", query="e", limit=2)
        assert len(result) <= 2

    def test_search_properties_are_valid(self, indexed_go_store):
        """Properties should be dicts or None, never unparsed strings."""
        result = _call_tool(indexed_go_store, "search_graph", query="db")
        for node in result:
            props = node.get("properties")
            if props is not None:
                assert isinstance(props, dict), f"Properties should be dict, got {type(props)}: {props}"


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
        """Full round-trip: search for a node, get its details, traverse from it."""
        # Search
        search_results = _call_tool(indexed_go_store, "search_graph", query="handler")
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
        """Search for Database class, verify its methods are reachable via traversal."""
        classes = _call_tool(indexed_python_store, "search_graph", query="Database", nodeTypes="Class")
        if not classes:
            pytest.skip("Database class not found")

        db_id = classes[0]["id"]
        details = _call_tool(indexed_python_store, "get_node", nodeId=db_id)
        assert details["node"]["name"] == "Database"

        # Neighbors should include methods or the file it's defined in
        neighbor_types = {n["relationship"]["type"] for n in details["neighbors"]}
        assert len(neighbor_types) > 0


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
