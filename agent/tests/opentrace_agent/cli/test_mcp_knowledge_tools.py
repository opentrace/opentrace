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


def _call_raw(store: GraphStore | None, tool_name: str, **kwargs) -> str:
    """The undecoded response — for asserting a payload is parseable at all."""
    server = create_mcp_server(store)
    return server._tool_manager._tools[tool_name].fn(**kwargs)


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


class TestConceptPageSurfaceIsGone:
    """The concept-page read surface must stay removed.

    ``read_vault_page`` / ``list_vault_pages`` and ``load_source``'s
    ``KnowledgeConcept`` branch were removed 2026-08-04 with the layer they
    served — synthesis measured 88.4% against a 98.6% control (-10.2pp),
    because restating a document strips its hedges, tense, and attribution.
    Verbatim ``load_source`` plus corpus ``grep`` answer the same questions.
    A tool the docstrings advertise is a capability the agent will reach for,
    so re-adding either one has to be a deliberate decision, not a merge.
    """

    def test_page_tools_are_not_registered(self, store):
        tools = create_mcp_server(store)._tool_manager._tools
        assert "read_vault_page" not in tools
        assert "list_vault_pages" not in tools

    def test_no_tool_description_advertises_page_reads(self, store):
        store.add_node("corpus::seed", "KnowledgeDoc", "seed.md", {"sha256": "seed"})
        tools = create_mcp_server(store)._tool_manager._tools
        for name, spec in tools.items():
            blob = f"{spec.description or ''} {spec.fn.__doc__ or ''}".lower()
            for gone in ("read_vault_page", "list_vault_pages", "knowledgeconcept"):
                assert gone not in blob, f"{name} still advertises {gone}"

    def test_load_source_on_a_page_shaped_node_is_not_a_page_read(self, store):
        """A pre-removal graph can still hold a ``KnowledgeConcept`` node. It
        must fall through to the code path and error cleanly, never resurrect
        a disk page read."""
        store.add_node(
            "kb::concept/conflicts",
            "KnowledgeConcept",
            "Conflicts",
            {"vault": "kb", "slug": "concept/conflicts", "kind": "concept"},
        )
        out = _call(store, "load_source", nodeId="kb::concept/conflicts")
        assert "error" in out
        assert "body" not in out


class TestLoadSourceDocPaging:
    """lineRange must work on document bodies, and an unranged read of a huge
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


class TestDocStatusSurfacing:
    """A doc's epistemic status must travel WITH its body.

    Benchmark finding: the wiki arm read design-history docs and never
    distinguished proposal from shipped behaviour, because ``load_source``
    returned filename/sha/body and dropped ``status`` entirely — the label
    existed in the graph but was invisible at the moment of reading.
    """

    def _doc(self, store, sha: str, *, status: str | None, path: str):
        db_dir = Path(store.db_path).parent
        (db_dir / "corpus").mkdir(parents=True, exist_ok=True)
        (db_dir / "corpus" / f"{sha}.md").write_text("# Doc\n\nBody text.\n")
        props = {
            "sha256": sha,
            "filename": path,
            "path": path,
            "corpus_path": f"corpus/{sha}.md",
            "title": "Doc",
            "one_line_summary": "What this document is about.",
        }
        if status is not None:
            props["status"] = status
        store.add_node(f"corpus::{sha}", "KnowledgeDoc", path, props)
        return f"corpus::{sha}"

    def test_design_history_read_carries_status_and_warning(self, store):
        nid = self._doc(store, "prop", status="design_history", path="openspec/changes/api.md")
        res = _call(store, "load_source", nodeId=nid)
        assert res["status"] == "design_history"
        note = res["statusNote"].lower()
        assert "proposed" in note and "not what ships" in note
        # Body still comes through, plus the label + navigation metadata.
        assert "Body text." in res["body"]
        assert res["title"] == "Doc"
        assert res["path"] == "openspec/changes/api.md"
        assert res["summary"] == "What this document is about."

    def test_authoritative_read_is_labelled_too(self, store):
        nid = self._doc(store, "cur", status="authoritative", path="docs/guide.md")
        res = _call(store, "load_source", nodeId=nid)
        assert res["status"] == "authoritative"
        assert "current documentation" in res["statusNote"].lower()

    def test_missing_status_defaults_to_authoritative(self, store):
        """Docs mirrored before status stamping must not read as unlabelled."""
        nid = self._doc(store, "old", status=None, path="docs/legacy.md")
        res = _call(store, "load_source", nodeId=nid)
        assert res["status"] == "authoritative"
        assert res["statusNote"]

    def test_archived_status_labelled(self, store):
        nid = self._doc(store, "arc", status="design_history_archived", path="openspec/archive/x.md")
        res = _call(store, "load_source", nodeId=nid)
        assert res["status"] == "design_history_archived"
        assert "superseded" in res["statusNote"].lower()


class TestListNodesDiscoverability:
    """``list_nodes`` is the only tool that can prove absence — its description
    must say so and must name the doc types.

    Benchmark finding: the wiki arm never called ``list_nodes`` once in 201
    tool calls (the code arm called it 9×) and lost the corpus-enumeration
    question, because the docstring listed only code types — KnowledgeDoc
    wasn't mentioned at all.
    """

    def test_description_names_doc_types_and_completeness_use(self, store):
        import re

        # A doc type is only advertised when the index HAS one, so seed a doc
        # before reading the description (see TestDocTypesAdvertisedConditionally).
        store.add_node("corpus::seed", "KnowledgeDoc", "seed.md", {"sha256": "seed"})
        server = create_mcp_server(store)
        doc = server._tool_manager._tools["list_nodes"].description
        norm = re.sub(r"\s+", " ", doc).lower()
        assert "knowledgedoc" in norm
        # It must state WHY to reach for it over ranked search.
        assert "list every" in norm
        assert "cannot establish that something is absent" in norm
        # And that status scoping is possible.
        assert "design_history" in norm

    def test_enumerates_docs_and_filters_by_status(self, store):
        db_dir = Path(store.db_path).parent
        (db_dir / "corpus").mkdir(parents=True, exist_ok=True)
        for sha, status in (("a", "authoritative"), ("b", "authoritative"), ("c", "design_history")):
            store.add_node(
                f"corpus::{sha}",
                "KnowledgeDoc",
                f"{sha}.md",
                {"sha256": sha, "filename": f"{sha}.md", "status": status},
            )
        allk = _call(store, "list_nodes", type="KnowledgeDoc", limit=100, paged=True)
        assert allk["returned"] == 3
        # hasMore=False is the completeness signal that licenses an absence claim.
        assert allk["hasMore"] is False
        # Compact projection by default — name + status, not the full blob
        # (see TestListNodesEnumeration for why).
        filtered = _call(
            store,
            "list_nodes",
            type="KnowledgeDoc",
            filters={"status": "design_history"},
            limit=100,
            paged=True,
        )
        assert [n["name"] for n in filtered["items"]] == ["c.md"]
        assert [n["status"] for n in filtered["items"]] == ["design_history"]


class TestPreExistingToolsAdvertiseDocLayer:
    """Generic tools that predate the doc layer must still describe it.

    ``search_graph``, ``list_nodes``, and ``traverse_graph`` all shipped with
    the original MCP server, months before KnowledgeDoc existed. Their
    docstrings are the agent's only map of what the graph holds, so a node or
    edge type absent from them is effectively absent from the graph: the
    benchmark's wiki arm made 72 ``search_graph`` calls and 0 ``list_nodes``
    calls while its docstring named only code types.
    """

    def _doc(self, store, name: str) -> str:
        """The tool DESCRIPTION (what the model actually sees), not __doc__ —
        the doc-layer copy is appended at server-build time, so a docstring
        assertion would pass while the model saw nothing."""
        import re

        store.add_node("corpus::seed", "KnowledgeDoc", "seed.md", {"sha256": "seed"})
        server = create_mcp_server(store)
        return re.sub(r"\s+", " ", server._tool_manager._tools[name].description).lower()

    def test_search_graph_describes_doc_hits(self, store):
        doc = self._doc(store, "search_graph")
        assert "knowledgedoc" in doc
        # The body lives behind load_source, and status comes with it.
        assert "load_source" in doc and "status" in doc
        # fileTwin is emitted by the twin collapse — it must be documented.
        assert "filetwin" in doc
        # A hit is a pointer to text, so the tools that read it must be named.
        assert "grep" in doc
        # And ranked search cannot prove absence — point at list_nodes.
        assert "list_nodes" in doc

    def test_traverse_graph_names_doc_edges(self, store):
        doc = self._doc(store, "traverse_graph")
        for edge in ("links_to", "mirrors"):
            assert edge in doc, f"{edge} missing from traverse_graph docstring"
        # None of these edges is written any more, so the docstring must not
        # imply one. "Which docs mention X" routes to grep; there is no
        # page→source citation to walk.
        for gone in ("mentions", "derived_from", "cites"):
            assert gone not in doc, f"{gone} is no longer written; advertising it invents a capability"
        assert "grep" in doc


class TestListNodesEnumeration:
    """``list_nodes`` is the only tool that can answer a completeness question,
    so it has to actually return the set.

    It previously returned full property blobs (~863 chars/node for a
    KnowledgeDoc) against a 4 KB cap, and the overflow was string-sliced — so
    asking for 25 documents returned ~4 of them inside a payload that raised
    ``JSONDecodeError`` at char 4000. Unparseable, not merely partial.
    """

    def _docs(self, store, n: int):
        for i in range(n):
            store.add_node(
                f"corpus::sha-{i:03d}",
                "KnowledgeDoc",
                f"docs/page-{i:03d}.md",
                {
                    "sha256": f"sha-{i:03d}",
                    "filename": f"docs/page-{i:03d}.md",
                    "path": f"docs/page-{i:03d}.md",
                    "title": f"Page {i}",
                    "status": "design_history" if i % 5 == 0 else "authoritative",
                    "corpus_path": f"corpus/sha-{i:03d}.md",
                    "acquired_at": "2026-07-29T00:00:00",
                    "content_type": "text/markdown",
                    # The bulk that used to blow the cap.
                    "one_line_summary": "A document about " + ("x" * 90),
                    "summary": "A document about " + ("x" * 90),
                },
            )

    @staticmethod
    def _items(raw):
        parsed = json.loads(raw)  # must ALWAYS parse
        return parsed if isinstance(parsed, list) else parsed["items"]

    def test_returns_whole_corpus_and_stays_parseable(self, store):
        self._docs(store, 40)
        raw = _call_raw(store, "list_nodes", type="KnowledgeDoc", limit=1000, paged=True)
        items = self._items(raw)
        assert len(items) == 40, "a 40-doc corpus must enumerate in one call"
        # Compact projection: triage fields in, bulk out.
        one = items[0]
        assert {"id", "type", "name", "path", "title", "status"} <= set(one)
        assert "corpus_path" not in one and "sha256" not in one and "acquired_at" not in one
        # A single gloss, not the duplicated pair.
        assert "one_line_summary" not in one
        assert len(one["summary"]) <= 121

    def test_paging_covers_the_set_without_overlap(self, store):
        self._docs(store, 40)
        seen: list[str] = []
        offset = 0
        for _ in range(10):
            payload = json.loads(_call_raw(store, "list_nodes", type="KnowledgeDoc", limit=15, offset=offset))
            seen += [i["id"] for i in payload["items"]]
            if not payload["hasMore"]:
                break
            offset += payload["returned"]
        assert len(seen) == 40
        assert len(set(seen)) == 40, "pages must not overlap"

    def test_status_filter_narrows_the_set(self, store):
        self._docs(store, 40)
        items = self._items(
            _call_raw(
                store,
                "list_nodes",
                type="KnowledgeDoc",
                limit=1000,
                filters={"status": "design_history"},
                paged=True,
            )
        )
        assert len(items) == 8  # every 5th of 40
        assert {i["status"] for i in items} == {"design_history"}

    def test_verbose_opts_back_into_full_records(self, store):
        self._docs(store, 3)
        items = self._items(_call_raw(store, "list_nodes", type="KnowledgeDoc", limit=10, verbose=True, paged=True))
        assert "properties" in items[0]
        assert items[0]["properties"]["corpus_path"]

    def test_oversized_set_degrades_to_valid_json(self, store):
        """Past the window budget it must drop ITEMS and say so — never slice bytes."""
        self._docs(store, 400)
        raw = _call_raw(store, "list_nodes", type="KnowledgeDoc", limit=1000, paged=True)
        payload = json.loads(raw)  # the assertion that used to fail
        assert payload["hasMore"] is True
        assert payload["returned"] == len(payload["items"]) < 400
        assert "offset=" in payload["hint"]


class TestDocTypesAdvertisedConditionally:
    """Generic tools must describe the graph they're actually pointed at.

    Advertising `KnowledgeDoc` on a code-only index makes an agent hunt for a
    layer that isn't there. Measured in the benchmark: after the doc types were
    added unconditionally, the CODE arm — which has no doc layer at all — spent
    19 tool calls across 8 questions on `list_nodes(type="KnowledgeDoc")`,
    `search_graph(nodeTypes="KnowledgeDoc")` and `count_by(nodeType=...)`, all
    returning nothing. That also broke pickup measurement, which counted those
    attempts as doc-layer usage.
    """

    ADVERTISED = ("list_nodes", "search_graph", "traverse_graph")

    @staticmethod
    def _descriptions(store):
        server = create_mcp_server(store)
        return {n: server._tool_manager._tools[n].description for n in TestDocTypesAdvertisedConditionally.ADVERTISED}

    def test_code_only_graph_never_mentions_doc_types(self, store):
        store.add_node("repo", "Repository", "repo", {})
        store.add_node("repo/a.py", "File", "a.py", {"path": "a.py"})
        for name, desc in self._descriptions(store).items():
            assert "KnowledgeDoc" not in desc, f"{name} advertises KnowledgeDoc on a code-only index"
            assert "KnowledgeConcept" not in desc, f"{name} advertises KnowledgeConcept on a code-only index"

    def test_doc_bearing_graph_does_mention_them(self, store):
        store.add_node("corpus::sha1", "KnowledgeDoc", "guide.md", {"sha256": "sha1"})
        descs = self._descriptions(store)
        assert "KnowledgeDoc" in descs["list_nodes"]
        assert "KnowledgeDoc" in descs["search_graph"]
        assert "LINKS_TO" in descs["traverse_graph"]

    def test_universal_copy_survives_on_a_code_only_graph(self, store):
        """Stripping the doc copy must not strip the tool's core guidance."""
        store.add_node("repo", "Repository", "repo", {})
        descs = self._descriptions(store)
        assert "absent" in descs["list_nodes"]  # completeness / absence-proving role
        assert "Repository" in descs["list_nodes"]  # code types still listed
        assert "CALLS" in descs["traverse_graph"]  # code edges still listed

    def test_no_index_is_safe(self):
        """A server with no store at all must build without touching the graph."""
        server = create_mcp_server(None)
        for n in self.ADVERTISED:
            assert "KnowledgeDoc" not in server._tool_manager._tools[n].description


class TestOversizedPayloadsStayParseable:
    """No tool may hand the agent JSON it cannot parse.

    `_json_response` string-sliced anything over 4 KB, which cuts mid-token.
    Lists were fixed first, but `search_graph` returns `{hits, count, query}`
    and `get_node` returns `{node, neighbours}` — both dicts, so both kept
    falling through to the slicing path. Measured on one 15-question benchmark
    run: 39% of search_graph results and 78% of get_node results reached the
    agent as invalid JSON, which is what drove it to re-issue the same query in
    seven different phrasings (37 searches on a single question).
    """

    @staticmethod
    def _parses(raw: str):
        json.loads(raw)  # raises on the bug
        return json.loads(raw)

    def test_search_shaped_dict_sheds_hits_not_bytes(self):
        from opentrace_agent.cli.mcp_server import MAX_RESULT_CHARS, _json_response

        payload = {
            "hits": [{"id": f"n{i}", "name": "x" * 60, "snippet": "y" * 120, "score": 1.0} for i in range(80)],
            "count": 80,
            "query": "something",
        }
        out = _json_response(payload)
        d = self._parses(out)
        assert len(out) <= MAX_RESULT_CHARS
        assert 0 < len(d["hits"]) < 80
        assert d["hasMore"] is True
        assert d["total"] == 80
        # a sibling count must not contradict the list it describes
        assert d["count"] == len(d["hits"])
        assert d["query"] == "something"  # non-list context preserved

    def test_get_node_shaped_dict_sheds_neighbours(self):
        from opentrace_agent.cli.mcp_server import _json_response

        payload = {
            "node": {"id": "a", "properties": {"p": "z" * 200}},
            "neighbours": [{"node": {"id": f"n{i}", "name": "n" * 50}, "target_summary": "s" * 80} for i in range(60)],
        }
        d = self._parses(_json_response(payload))
        assert 0 < len(d["neighbours"]) < 60
        assert d["node"]["id"] == "a"  # the thing you actually asked for survives

    def test_dict_with_no_list_returns_a_valid_envelope(self):
        """Nothing to shed — must still be parseable, not a sliced document."""
        from opentrace_agent.cli.mcp_server import _json_response

        d = self._parses(_json_response({"body": "Z" * 20000}))
        assert d["truncated"] is True
        assert d["totalChars"] > 20000
        assert d["head"]  # data preserved as a string value

    def test_small_payloads_are_untouched(self):
        from opentrace_agent.cli.mcp_server import _json_response

        payload = {"hits": [{"id": "a"}], "count": 1, "query": "q"}
        assert json.loads(_json_response(payload)) == payload

    def test_live_search_over_a_seeded_graph_is_parseable(self, store):
        """End-to-end through the real tool, with enough nodes to overflow."""
        for i in range(200):
            store.add_node(
                f"n{i}",
                "Function",
                f"handle_documentation_request_{i}",
                {"summary": "documentation " * 30, "path": f"src/module_{i}/handler.py"},
            )
        raw = _call_raw(store, "search_graph", query="documentation handler", limit=100)
        d = self._parses(raw)
        assert d.get("hits"), "search returned no hits to test truncation against"


class TestReadPathSymmetry:
    """The same document must not return more text via one node type than another.

    The caps were 200K (File → disk) and 40K (KnowledgeDoc → corpus), so a 90KB
    document returned 2.26x more text through its File twin. That decided a
    benchmark question: reading DOCS.md whole surfaced two /conflicts routes
    that only appear there, while the arm on the doc path read it in slices and
    reported the discrepancy as absent.
    """

    def _both_paths(self, store, tmp_path, size):
        body = "".join(f"line {i} " + "x" * 60 + "\n" for i in range(size))
        repo = tmp_path / "repo"
        repo.mkdir(exist_ok=True)
        (repo / "BIG.md").write_text(body)
        store.save_metadata({"repoId": "r", "repoPath": str(repo)})
        store.add_node("r/BIG.md", "File", "BIG.md", {"path": "BIG.md"})
        db_dir = Path(store.db_path).parent
        (db_dir / "corpus").mkdir(parents=True, exist_ok=True)
        (db_dir / "corpus" / "big.md").write_text(body)
        store.add_node(
            "corpus::big",
            "KnowledgeDoc",
            "BIG.md",
            {"sha256": "big", "filename": "BIG.md", "path": "BIG.md", "corpus_path": "corpus/big.md"},
        )
        return _call(store, "load_source", nodeId="corpus::big"), _call(store, "load_source", nodeId="r/BIG.md")

    def test_large_document_reads_identically_either_way(self, store, tmp_path):
        doc, file = self._both_paths(store, tmp_path, 900)
        assert doc["truncated"] and file["truncated"], "test doc must exceed the cap"
        assert abs(len(doc["body"]) - len(file["body"])) < 200, "asymmetric read budget"

    def test_both_paths_tell_you_how_to_continue(self, store, tmp_path):
        doc, file = self._both_paths(store, tmp_path, 900)
        # A bare slice with no hint is how an arm dead-ended re-requesting a file.
        assert "lineRange" in doc.get("hint", "")
        assert "lineRange" in file.get("hint", "")

    def test_small_documents_are_not_truncated_either_way(self, store, tmp_path):
        doc, file = self._both_paths(store, tmp_path, 5)
        assert not doc.get("truncated") and not file.get("truncated")


class TestAbsenceClaimsCarryTheirPopulation:
    """`find_orphans` answers 'nothing links to X'. That is only true relative to
    the graph's population, which for documents is NOT the filesystem."""

    def test_doc_orphans_declare_population_and_caveat(self, store):
        for i in range(3):
            store.add_node(f"corpus::d{i}", "KnowledgeDoc", f"d{i}.md", {"sha256": f"d{i}"})
        store.add_relationship("l1", "LINKS_TO", "corpus::d0", "corpus::d1")
        r = _call(store, "find_orphans", nodeType="KnowledgeDoc", edgeType="LINKS_TO", direction="incoming")
        scope = r["scope"]
        assert scope["population"] == 3
        assert "not over the filesystem" in scope["meaning"]
        assert "grep" in scope["caveat"], "must tell the caller how to confirm an absence"

    def test_code_types_get_population_without_the_doc_caveat(self, store):
        r = _call(store, "find_orphans", nodeType="Function", edgeType="CALLS")
        assert isinstance(r["scope"]["population"], int)
        assert "caveat" not in r["scope"]


class TestSearchGraphDocHits:
    """search_graph over a doc-bearing index: document hits carry their triage
    fields, and legacy node types left over from the removed entity layer are
    returned like anything else (no filtering — the layer that made filtering
    worthwhile is gone)."""

    @staticmethod
    def _seed(store):
        store.add_node(
            "ent::engram",
            "Idea",
            "engram",
            {"derived_from": "corpus::sha-en", "description": "the engram project"},
        )
        store.add_node(
            "corpus::sha-en",
            "KnowledgeDoc",
            "engram-overview.md",
            {
                "sha256": "sha-en",
                "title": "Engram Overview",
                "status": "authoritative",
                "one_line_summary": "engram overview of the project",
                "summary": "engram overview of the project",
                "path": "docs/engram-overview.md",
            },
        )
        store.add_node("svc::engram-api", "Service", "engram-api", {})  # runtime, no derived_from

    def test_default_returns_docs_and_legacy_nodes_alike(self, store):
        self._seed(store)
        r = _call(store, "search_graph", query="engram")
        types_by_id = {h["id"]: h["type"] for h in r["hits"]}
        assert "corpus::sha-en" in types_by_id
        assert "svc::engram-api" in types_by_id
        assert "ent::engram" in types_by_id, "a pre-existing graph's nodes stay reachable"
        assert "hint" not in r

    def test_node_types_filter_reaches_legacy_types(self, store):
        self._seed(store)
        r = _call(store, "search_graph", query="engram", nodeTypes="Idea")
        assert {h["id"] for h in r["hits"]} == {"ent::engram"}

    def test_doc_hits_carry_triage_fields(self, store):
        self._seed(store)
        r = _call(store, "search_graph", query="engram overview")
        doc = next(h for h in r["hits"] if h["id"] == "corpus::sha-en")
        assert doc["title"] == "Engram Overview"
        assert doc["status"] == "authoritative"
        assert doc["one_line_summary"] == "engram overview of the project"
        assert doc["path"] == "docs/engram-overview.md"

    def test_knowledge_doc_type_filter_unaffected(self, store):
        self._seed(store)
        r = _call(store, "search_graph", query="engram", nodeTypes="KnowledgeDoc")
        assert {h["id"] for h in r["hits"]} == {"corpus::sha-en"}


class TestGrepResponseFitting:
    """grep answers "which documents", so truncation must shed line detail, never
    documents.

    Regression guard for the defect that produced run 5's coverage loss: a
    sweep matched 39 lines across 18 documents, the generic 4 KB truncation
    kept 8 matches and dropped 10+ documents outright, and the arm concluded
    the thing it was looking for did not exist. The evidence was retrieved and
    then discarded in transport.
    """

    @staticmethod
    def _matches(n_docs: int, per_doc: int, text_len: int = 120):
        return [
            {
                "node_id": "corpus::" + "a" * 60 + str(d),
                "file_path": f"doc{d}.md",
                "line_number": ln,
                "line_text": "x" * text_len,
                "title": f"Doc {d}",
                "status": "authoritative",
                "structural_context": {"scope_type": "KnowledgeVault", "vault": "v", "layer": "corpus"},
            }
            for d in range(n_docs)
            for ln in range(per_doc)
        ]

    def _fit(self, matches):
        from opentrace_agent.cli.mcp_server import _fit_grep_response

        payload = {"matches": matches, "count": len(matches), "scope": "vault::v", "mode": "python"}
        return json.loads(_fit_grep_response(payload))

    def test_small_result_keeps_full_line_text(self):
        out = self._fit(self._matches(2, 2))
        assert out["matched_documents"] == 2
        assert out["documents"][0]["lines"][0]["text"]
        assert "detail" not in out

    def test_routine_sweep_stays_complete_and_actionable(self):
        """The invariant for a routine sweep (31 of 48 documents, ~120 matches —
        measured shape from a real run): every document listed, every entry
        addressable, and text still present even if shortened to snippets.

        grep runs on the LIST budget (20 KB), not the general 4 KB cap. On the
        small cap this exact sweep degraded all the way to bare paths with no
        node_ids, and the arm — unable to address any hit — answered a
        31-document question with 3 reads and 38 flailing greps."""
        out = self._fit(self._matches(31, 4))
        assert out["matched_documents"] == 31
        assert len(out["documents"]) == 31
        first = out["documents"][0]
        assert "node_id" in first and "path" in first, "hits must stay addressable"
        assert first["lines"], "some line signal must survive (snippets or line numbers)"

    def test_small_sweep_keeps_untruncated_text(self):
        out = self._fit(self._matches(6, 2))
        assert "detail" not in out
        assert len(out["documents"][0]["lines"][0]["text"]) == 120

    def test_oversized_result_keeps_every_document(self):
        out = self._fit(self._matches(60, 20, text_len=400))
        assert out["matched_documents"] == 60
        assert len(out["documents"]) == 60, "documents must never be dropped"
        assert "detail" in out  # says what was degraded
        # Degradation never costs addressability — an entry you can't pass to
        # load_source is one you can't act on.
        assert all("node_id" in d and "path" in d for d in out["documents"])

    def test_extreme_result_still_lists_all_documents(self):
        out = self._fit(self._matches(60, 10, text_len=400))
        assert out["matched_documents"] == 60
        assert len(out["documents"]) == 60
        paths = [d if isinstance(d, str) else d.get("path") for d in out["documents"]]
        assert "doc59.md" in paths

    def test_response_stays_within_budget_and_parses(self):
        from opentrace_agent.cli.mcp_server import MAX_LIST_RESULT_CHARS, _fit_grep_response

        raw = _fit_grep_response(
            {"matches": self._matches(40, 8, text_len=300), "count": 320, "scope": "vault::v", "mode": "python"}
        )
        assert len(raw) <= MAX_LIST_RESULT_CHARS
        json.loads(raw)  # must be parseable, not a sliced string

    def test_extreme_overflow_trims_documents_but_says_so(self):
        """Only when even id+path+count per document overflows may the document
        list be cut — and then it must be flagged, never silently short."""
        out = self._fit(self._matches(4000, 2, text_len=200))
        assert out["hasMore"] is True
        assert out["returned_documents"] == len(out["documents"]) < out["matched_documents"]
        assert "INCOMPLETE" in out["detail"]
        assert all("node_id" in d for d in out["documents"])

    def test_error_and_empty_results_pass_through(self):
        from opentrace_agent.cli.mcp_server import _fit_grep_response

        err = json.loads(
            _fit_grep_response({"matches": [], "count": 0, "scope": "x", "mode": "error", "error": "nope"})
        )
        assert err["mode"] == "error" and err["error"] == "nope"
        empty = json.loads(_fit_grep_response({"matches": [], "count": 0, "scope": "x", "mode": "python"}))
        assert empty["count"] == 0


class TestListNodesBackwardCompatibility:
    """`list_nodes` predates the vault work, so its DEFAULT response shape must
    stay what it always was — a plain array of full nodes. The compact paged
    window is an addition, opt-in via `paged`.

    Guards the boundary the branch is held to: add to the existing product,
    don't silently change it. Flipping this default is a separate decision.
    """

    @pytest.fixture()
    def store(self, tmp_path):
        s = GraphStore(str(tmp_path / "ln.db"))
        for i in range(3):
            s.add_node(f"corpus::{i}", "KnowledgeDoc", f"doc{i}.md", {"title": f"Doc {i}", "status": "authoritative"})
        yield s
        s.close()

    def test_default_returns_a_plain_array_of_full_nodes(self, store):
        out = _call(store, "list_nodes", type="KnowledgeDoc")
        assert isinstance(out, list), "default shape must stay a bare JSON array"
        assert len(out) == 3
        # Full nodes, not the compact projection.
        assert "properties" in out[0]

    def test_paged_opts_into_the_window_shape(self, store):
        out = _call(store, "list_nodes", type="KnowledgeDoc", paged=True)
        assert isinstance(out, dict)
        assert out["returned"] == 3
        assert out["hasMore"] is False  # the completeness signal
        assert "properties" not in out["items"][0]  # compact projection
        assert out["items"][0]["title"] == "Doc 0"

    def test_nonzero_offset_implies_paged(self, store):
        out = _call(store, "list_nodes", type="KnowledgeDoc", limit=2, offset=1)
        assert isinstance(out, dict)
        assert out["offset"] == 1

    def test_paged_verbose_returns_full_nodes_in_the_window(self, store):
        out = _call(store, "list_nodes", type="KnowledgeDoc", paged=True, verbose=True)
        assert "properties" in out["items"][0]

    def test_unpaged_hasmore_signal_is_absent_by_design(self, store):
        """The legacy array carries no completeness signal — that's exactly why
        the docstring steers absence questions to paged=True."""
        out = _call(store, "list_nodes", type="KnowledgeDoc")
        assert isinstance(out, list)


class TestListNodesLegacyShapePreserved:
    """`list_nodes` predates the vault work, so its DEFAULT response shape must
    stay what it always was: a plain JSON array of full nodes.

    The compact `{items, returned, offset, hasMore, hint}` window is an
    addition, opt-in via `paged=True`. Changing the default would break
    consumers that were here first — a modification to shipped behaviour, which
    belongs in its own change rather than riding along with docs retrieval.
    """

    @pytest.fixture()
    def store(self, tmp_path):
        s = GraphStore(str(tmp_path / "legacy.db"))
        for i in range(3):
            s.add_node(f"r/f{i}.py", "File", f"f{i}.py", {"path": f"src/f{i}.py", "extension": ".py"})
        yield s
        s.close()

    def test_default_returns_plain_array_of_full_nodes(self, store):
        out = _call(store, "list_nodes", type="File", limit=10)
        assert isinstance(out, list), "default shape must stay a bare JSON array"
        assert len(out) == 3
        # Full records, not the compact projection.
        assert "properties" in out[0]
        assert out[0]["properties"]["extension"] == ".py"

    def test_default_has_no_window_envelope(self, store):
        out = _call(store, "list_nodes", type="File", limit=10)
        assert not isinstance(out, dict)  # no items/returned/hasMore wrapper

    def test_paged_opts_into_the_window(self, store):
        out = _call(store, "list_nodes", type="File", limit=10, paged=True)
        assert isinstance(out, dict)
        assert out["hasMore"] is False
        assert len(out["items"]) == 3
        assert "properties" not in out["items"][0]  # compact projection

    def test_offset_implies_paging(self, store):
        """A non-zero offset is meaningless in the bare-array shape, so it
        implies the window rather than being silently ignored."""
        out = _call(store, "list_nodes", type="File", limit=1, offset=1)
        assert isinstance(out, dict)
        assert out["offset"] == 1
        assert len(out["items"]) == 1
