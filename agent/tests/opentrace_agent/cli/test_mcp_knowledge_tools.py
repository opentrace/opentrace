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
            "corpus::abc",
            "KnowledgeDoc",
            "doc.md",
            {"sha256": "abc", "filename": "doc.md", "corpus_path": "corpus/abc.md"},
        )

        res = _call(store, "load_source", nodeId="corpus::abc")
        assert res["type"] == "KnowledgeDoc"
        assert res["body"] == "# Doc\nbody text"
        assert res["filename"] == "doc.md"

    def test_source_node_rejects_path_traversal(self, store):
        store.add_node("corpus::evil", "KnowledgeDoc", "x", {"corpus_path": "../../etc/passwd"})
        assert "error" in _call(store, "load_source", nodeId="corpus::evil")


class TestReadVaultPage:
    """Page reads must hand the agent the page's primary sources (CITES) and
    the citation contract — cite the primary alongside the page, never the
    page alone — so vault answers stay traceable to repo documents."""

    def _vault_on_disk(self, tmp_path, body: str = "# Conflicts\n\nRule text.\n"):
        vault_dir = tmp_path / ".opentrace" / "vaults" / "kb"
        (vault_dir / "pages" / "concept").mkdir(parents=True)
        (vault_dir / ".vault.json").write_text('{"name": "kb"}')
        (vault_dir / "pages" / "concept" / "conflicts.md").write_text(body)
        return vault_dir

    @pytest.fixture()
    def vault_store(self, tmp_path):
        self._vault_on_disk(tmp_path)
        s = GraphStore(str(tmp_path / ".opentrace" / "index.db"))
        s.add_node(
            "kb::concept/conflicts",
            "KnowledgeConcept",
            "Conflicts",
            {"vault": "kb", "slug": "concept/conflicts", "kind": "concept"},
        )
        s.add_node(
            "corpus::sha-auth",
            "KnowledgeDoc",
            "docs/AGENT-SETUP.md",
            {"sha256": "sha-auth", "filename": "docs/AGENT-SETUP.md", "path": "docs/AGENT-SETUP.md", "status": "authoritative"},
        )
        s.add_node(
            "corpus::sha-prop",
            "KnowledgeDoc",
            "openspec/proposal.md",
            {"sha256": "sha-prop", "filename": "openspec/proposal.md", "status": "design_history"},
        )
        s.add_node("local/repo/docs/AGENT-SETUP.md", "File", "AGENT-SETUP.md")
        s.add_relationship("c1", "CITES", "kb::concept/conflicts", "corpus::sha-auth")
        s.add_relationship("c2", "CITES", "kb::concept/conflicts", "corpus::sha-prop")
        s.add_relationship("m1", "MIRRORS", "corpus::sha-auth", "local/repo/docs/AGENT-SETUP.md")
        yield s
        s.close()

    def test_returns_body_and_cited_sources(self, vault_store):
        out = _call(vault_store, "read_vault_page", nodeId="kb::concept/conflicts")
        assert "Rule text." in out["body"]
        cited = {c["filename"]: c for c in out["cited_sources"]}
        assert set(cited) == {"docs/AGENT-SETUP.md", "openspec/proposal.md"}
        assert cited["docs/AGENT-SETUP.md"]["status"] == "authoritative"
        assert cited["docs/AGENT-SETUP.md"]["file"] == "local/repo/docs/AGENT-SETUP.md"
        assert cited["openspec/proposal.md"]["status"] == "design_history"
        # Seam #2: epistemic framing travels with the payload.
        assert out["nature"] == "documentation-synthesis"
        assert "not its code" in out["provenance_note"]

    def test_page_without_cites_returns_empty_list(self, tmp_path):
        self._vault_on_disk(tmp_path)
        s = GraphStore(str(tmp_path / ".opentrace" / "index.db"))
        try:
            s.add_node(
                "kb::concept/conflicts",
                "KnowledgeConcept",
                "Conflicts",
                {"vault": "kb", "slug": "concept/conflicts", "kind": "concept"},
            )
            out = _call(s, "read_vault_page", nodeId="kb::concept/conflicts")
            assert out["cited_sources"] == []
        finally:
            s.close()

    def test_load_source_concept_branch_carries_cited_sources(self, vault_store):
        out = _call(vault_store, "load_source", nodeId="kb::concept/conflicts")
        assert [c["filename"] for c in out["cited_sources"]]
        # Seam #2 framing travels through the load_source dispatch too.
        assert out["nature"] == "documentation-synthesis"

    def test_epistemic_contract_pinned_in_docstring(self, vault_store):
        # The docstring is the behavioural surface — agents read it to decide
        # how to treat a page. Pin the seam-#2 contract's load-bearing phrases:
        # the page is documentation (not a code oracle), and code-behavior
        # claims must be confirmed against the code, not the page's cited docs.
        import re

        server = create_mcp_server(vault_store)
        doc = server._tool_manager._tools["read_vault_page"].fn.__doc__
        norm = re.sub(r"\s+", " ", doc).lower()
        assert "faithful to the docs, not a statement about the code" in norm
        assert "confirm the specific against the code" in norm
        assert 'do not equate "the docs say x" with "the code does x"' in norm
        assert "design_history" in norm


class TestLoadSourceDocPaging:
    """lineRange must work on doc/page bodies, and an unranged read of a huge
    doc must return a usable head + continuation hint — the MCP client hard-
    rejects oversized results, and a restricted session has no other way in
    (observed: an arm dead-ended re-requesting a 91 KB DOCS.md)."""

    def _doc(self, store, body: str, sha: str = "big"):
        db_dir = Path(store.db_path).parent
        (db_dir / "corpus").mkdir(parents=True, exist_ok=True)
        (db_dir / "corpus" / f"{sha}.md").write_text(body)
        store.add_node(
            f"corpus::{sha}",
            "KnowledgeDoc",
            f"{sha}.md",
            {"sha256": sha, "filename": f"{sha}.md", "corpus_path": f"corpus/{sha}.md"},
        )
        return f"corpus::{sha}"

    def test_line_range_slices_doc_body(self, store):
        nid = self._doc(store, "\n".join(f"line {i}" for i in range(1, 101)))
        res = _call(store, "load_source", nodeId=nid, lineRange="10-12")
        assert res["body"] == "line 10\nline 11\nline 12"
        assert res["lineRange"] == "10-12"
        assert res["totalLines"] == 100

    def test_open_ended_range(self, store):
        nid = self._doc(store, "\n".join(f"line {i}" for i in range(1, 6)))
        res = _call(store, "load_source", nodeId=nid, lineRange="4-")
        assert res["body"] == "line 4\nline 5"
        assert res["lineRange"] == "4-5"

    def test_small_doc_unranged_gets_total_lines_untruncated(self, store):
        nid = self._doc(store, "a\nb\nc")
        res = _call(store, "load_source", nodeId=nid)
        assert res["body"] == "a\nb\nc"
        assert res["totalLines"] == 3
        assert "truncated" not in res

    def test_huge_doc_unranged_returns_head_with_hint(self, store):
        # ~90 KB doc (the DOCS.md shape): head must fit the cap, and the hint
        # must tell the agent the exact lineRange to continue from.
        nid = self._doc(store, "\n".join(f"line {i} " + "x" * 90 for i in range(1, 1001)))
        res = _call(store, "load_source", nodeId=nid)
        assert res["truncated"] is True
        assert len(res["body"]) <= 40_000
        assert res["totalLines"] == 1000
        end = int(res["lineRange"].split("-")[1])
        assert f'lineRange="{end + 1}-"' in res["hint"]
        # And the hinted continuation actually works.
        rest = _call(store, "load_source", nodeId=nid, lineRange=f"{end + 1}-")
        assert rest["body"].splitlines()[0].startswith(f"line {end + 1} ")
        assert rest["lineRange"] == f"{end + 1}-1000"

    def test_improvised_separators_accepted(self, store):
        # Agents improvise formats (observed: "1200, 1420"); commas/colons/
        # whitespace must parse rather than silently returning the whole body.
        nid = self._doc(store, "\n".join(f"line {i}" for i in range(1, 21)))
        for spec in ("3, 5", "3:5", "3 5"):
            res = _call(store, "load_source", nodeId=nid, lineRange=spec)
            assert res["body"] == "line 3\nline 4\nline 5", spec

    def test_unparseable_range_errors_loudly(self, store):
        # A bad range must NOT fall back to the whole body (that turns a
        # paging attempt into an oversized client-rejected response).
        nid = self._doc(store, "\n".join(f"line {i}" for i in range(1, 21)))
        res = _call(store, "load_source", nodeId=nid, lineRange="ten to twenty")
        assert "error" in res and "lineRange" in res["error"]
