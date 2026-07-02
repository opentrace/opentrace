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

"""Tests for the new MCP knowledge-graph tools.

Exercises ``get_communities``, ``get_god_nodes``, ``get_bridges``, and
``find_path`` against a hand-built GraphStore. Mirrors the pattern in
``tests/opentrace_agent/graph/test_mcp_integration.py``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("real_ladybug")
pytest.importorskip("networkx")

from opentrace_agent.cli.mcp_server import create_mcp_server  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402


def _call(store: GraphStore | None, tool_name: str, **kwargs):
    server = create_mcp_server(store)
    return json.loads(server._tool_manager._tools[tool_name].fn(**kwargs))


@pytest.fixture()
def store(tmp_path):
    s = GraphStore(str(tmp_path / "db"))
    # Two communities of two nodes each, with a bridge.
    for i in range(2):
        s.add_node(f"a{i}", "Function", f"a{i}")
        s.add_node(f"b{i}", "Function", f"b{i}")
    s.add_relationship("ea", "CALLS", "a0", "a1")
    s.add_relationship("eb", "CALLS", "b0", "b1")
    s.add_relationship("ebridge", "CALLS", "a0", "b0")
    s.save_community("ca", "A cluster", 1, 0.7, 2, is_god=True)
    s.save_community("cb", "B cluster", 2, 0.7, 2)
    for nid, cid in (("a0", "ca"), ("a1", "ca"), ("b0", "cb"), ("b1", "cb")):
        s.save_membership(f"m-{nid}", nid, cid)
    yield s
    s.close()


class TestGetCommunities:
    def test_returns_both(self, store):
        rows = _call(store, "get_communities")
        names = sorted(r["name"] for r in rows)
        assert names == ["A cluster", "B cluster"]

    def test_no_index_message(self):
        rows = _call(None, "get_communities")
        assert rows.get("status") == "ok"
        assert "No index" in rows["message"]

    def test_limit_applied(self, store):
        rows = _call(store, "get_communities", limit=1)
        assert len(rows) == 1


class TestGetGodNodes:
    def test_top_by_degree(self, store):
        # a0 and b0 both have degree 2 (each touches one intra-community
        # edge and the bridge). The top result should be one of them.
        rows = _call(store, "get_god_nodes", limit=2)
        top_ids = {r["id"] for r in rows}
        assert top_ids & {"a0", "b0"}
        assert max(r["degree"] for r in rows) >= 2

    def test_no_index_message(self):
        rows = _call(None, "get_god_nodes")
        assert rows.get("status") == "ok"


class TestGetBridges:
    def test_returns_cross_community_edges(self, store):
        rows = _call(store, "get_bridges")
        # The bridge edge connects a0 ↔ b0; should appear with distinct community IDs.
        bridge = next(
            (r for r in rows if {r["source_id"], r["target_id"]} == {"a0", "b0"}),
            None,
        )
        assert bridge is not None
        assert bridge["source_community_id"] != bridge["target_community_id"]

    def test_no_index_message(self):
        rows = _call(None, "get_bridges")
        assert rows.get("status") == "ok"


class TestFindPath:
    """Validates the retrieval-layer find_path exposed as an MCP tool.

    Uses startId/endId + maxHops parameter names (camelCase MCP convention)
    and returns ``{path: [{node, relationship, depth}, …], length: N}`` —
    the canonical retrieval-layer shape. The earlier networkx-backed
    duplicate that returned a flat ID list has been removed.
    """

    def test_direct_neighbor(self, store):
        result = _call(store, "find_path", startId="a0", endId="a1")
        ids = [step["node"]["id"] for step in result["path"]]
        assert ids == ["a0", "a1"]
        assert result["length"] == 1

    def test_via_bridge(self, store):
        result = _call(store, "find_path", startId="a1", endId="b1")
        # Walk is outgoing-only — a1 has no outgoing edge today, so no
        # path is found. (The networkx variant treated edges as undirected;
        # the retrieval BFS does not.)
        assert result["path"] is None

    def test_missing_node(self, store):
        result = _call(store, "find_path", startId="ghost", endId="a0")
        assert result["path"] is None
        assert "not found" in result["error"]

    def test_max_hops_exceeded(self, store):
        result = _call(store, "find_path", startId="a0", endId="b1", maxHops=1)
        assert result["path"] is None
        assert result["length"] is None

    def test_no_index_message(self):
        rows = _call(None, "find_path", startId="a", endId="b")
        assert rows.get("status") == "ok"


class TestToolsRegistered:
    def test_tools_present(self, store):
        server = create_mcp_server(store)
        names = set(server._tool_manager._tools.keys())
        for expected in ("get_communities", "get_god_nodes", "get_bridges", "find_path", "load_source"):
            assert expected in names


class TestLoadSource:
    def test_no_index_message(self):
        assert _call(None, "load_source", nodeId="x").get("status") == "ok"

    def test_missing_node(self, store):
        assert "error" in _call(store, "load_source", nodeId="nope")

    def test_code_node_reads_file_slice(self, tmp_path, store):
        # A File node whose path resolves via the indexed repo's repoPath.
        src = tmp_path / "repo" / "mod.py"
        src.parent.mkdir(parents=True)
        src.write_text("line1\nline2\nline3\nline4\n")
        store.save_metadata({"repoId": "r", "repoPath": str(tmp_path / "repo")})
        store.add_node("r/mod.py", "File", "mod.py", {"path": "mod.py"})

        res = _call(store, "load_source", nodeId="r/mod.py", lineRange="2-3")
        assert res["type"] == "File"
        assert res["body"] == "line2\nline3"
        assert res["lineRange"] == "2-3"

    def test_code_node_defaults_to_node_line_range(self, tmp_path, store):
        src = tmp_path / "repo2" / "mod.py"
        src.parent.mkdir(parents=True)
        src.write_text("a\nb\nc\nd\ne\n")
        store.save_metadata({"repoId": "r2", "repoPath": str(tmp_path / "repo2")})
        store.add_node("r2/mod.py::fn", "Function", "fn", {"path": "mod.py", "start_line": 2, "end_line": 4})

        res = _call(store, "load_source", nodeId="r2/mod.py::fn")
        assert res["body"] == "b\nc\nd"

    def test_source_node_reads_corpus(self, tmp_path, store):
        # ``Source`` body lives at <db_dir>/corpus/<sha>.md, db_dir = parent of db.
        db_dir = Path(store.db_path).parent
        (db_dir / "corpus").mkdir(parents=True, exist_ok=True)
        (db_dir / "corpus" / "abc.md").write_text("# Doc\nbody text")
        store.add_node(
            "source::abc",
            "Source",
            "doc.md",
            {"sha256": "abc", "filename": "doc.md", "corpus_path": "corpus/abc.md"},
        )

        res = _call(store, "load_source", nodeId="source::abc")
        assert res["type"] == "Source"
        assert res["body"] == "# Doc\nbody text"
        assert res["filename"] == "doc.md"

    def test_source_node_rejects_path_traversal(self, store):
        store.add_node("source::evil", "Source", "x", {"corpus_path": "../../etc/passwd"})
        assert "error" in _call(store, "load_source", nodeId="source::evil")
