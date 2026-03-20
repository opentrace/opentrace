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

"""Tests for GraphStore helpers and integration."""

from __future__ import annotations

import json

import pytest

from opentrace_agent.store.graph_store import (
    _marshal_props,
    _parse_props,
    _row_to_node,
    _unmarshal_props,
    build_search_text,
    matches_filters,
)

# ---------------------------------------------------------------------------
# Pure helper tests (no DB required)
# ---------------------------------------------------------------------------


class TestBuildSearchText:
    def test_name_and_type(self):
        assert build_search_text("Foo", "Class", {}) == "Foo Class"

    def test_includes_summary(self):
        text = build_search_text("bar", "Function", {"summary": "does stuff"})
        assert "does stuff" in text

    def test_includes_path(self):
        text = build_search_text("baz", "File", {"path": "src/baz.py"})
        assert "src/baz.py" in text

    def test_includes_both_summary_and_path(self):
        text = build_search_text("x", "Module", {"summary": "A module", "path": "src/x.py"})
        assert "A module" in text
        assert "src/x.py" in text

    def test_ignores_other_properties(self):
        text = build_search_text("y", "File", {"language": "python"})
        assert "python" not in text


class TestMatchesFilters:
    def test_exact_match(self):
        assert matches_filters({"lang": "go"}, {"lang": "go"})

    def test_mismatch(self):
        assert not matches_filters({"lang": "go"}, {"lang": "python"})

    def test_missing_property(self):
        assert not matches_filters({}, {"lang": "go"})

    def test_multiple_filters_all_match(self):
        assert matches_filters({"a": "1", "b": "2"}, {"a": "1", "b": "2"})

    def test_multiple_filters_partial_mismatch(self):
        assert not matches_filters({"a": "1", "b": "2"}, {"a": "1", "b": "3"})

    def test_numeric_coercion(self):
        """Filters compare via str(), so int properties match string filters."""
        assert matches_filters({"lines": 42}, {"lines": "42"})

    def test_empty_filters(self):
        assert matches_filters({"any": "val"}, {})


class TestMarshalProps:
    def test_none_returns_empty_object(self):
        assert _marshal_props(None) == "{}"

    def test_empty_dict_returns_empty_object(self):
        assert _marshal_props({}) == "{}"

    def test_roundtrip(self):
        props = {"language": "python", "lines": 42, "nested": {"a": 1}}
        s = _marshal_props(props)
        assert json.loads(s) == props


class TestUnmarshalProps:
    def test_empty_string(self):
        assert _unmarshal_props("") is None

    def test_empty_object_string(self):
        assert _unmarshal_props("{}") is None

    def test_valid_json(self):
        assert _unmarshal_props('{"a": 1}') == {"a": 1}

    def test_invalid_json_raises(self):
        with pytest.raises(json.JSONDecodeError):
            _unmarshal_props("not json")

    def test_single_quoted_raises(self):
        """This is the exact bug _parse_props was created to fix."""
        with pytest.raises(json.JSONDecodeError):
            _unmarshal_props("{'key': 'value'}")


class TestParseProps:
    """Tests for the _parse_props helper that handles both dict and str inputs."""

    def test_dict_passthrough(self):
        d = {"language": "go", "lines": 100}
        assert _parse_props(d) == d

    def test_empty_dict_returns_none(self):
        assert _parse_props({}) is None

    def test_json_string(self):
        assert _parse_props('{"a": 1}') == {"a": 1}

    def test_empty_string(self):
        assert _parse_props("") is None

    def test_empty_object_string(self):
        assert _parse_props("{}") is None

    def test_none_value(self):
        assert _parse_props(None) is None

    def test_falsy_zero(self):
        assert _parse_props(0) is None

    def test_dict_with_nested_values(self):
        d = {"outer": {"inner": [1, 2, 3]}}
        assert _parse_props(d) == d

    def test_invalid_string_raises(self):
        with pytest.raises(json.JSONDecodeError):
            _parse_props("not json")


class TestRowToNode:
    def test_basic(self):
        row = ["node-1", "Function", "foo", '{"path": "src/foo.py"}']
        result = _row_to_node(row)
        assert result == {
            "id": "node-1",
            "type": "Function",
            "name": "foo",
            "properties": {"path": "src/foo.py"},
        }

    def test_dict_properties(self):
        """When LadybugDB returns properties already deserialized as a dict."""
        row = ["node-2", "Class", "Bar", {"language": "python"}]
        result = _row_to_node(row)
        assert result["properties"] == {"language": "python"}

    def test_none_properties(self):
        row = ["node-3", "File", "readme.md", None]
        result = _row_to_node(row)
        assert result["properties"] is None

    def test_empty_string_properties(self):
        row = ["node-4", "Module", "mod", ""]
        result = _row_to_node(row)
        assert result["properties"] is None

    def test_empty_dict_properties(self):
        row = ["node-5", "Module", "mod", {}]
        result = _row_to_node(row)
        assert result["properties"] is None

    def test_empty_object_string(self):
        row = ["node-6", "Module", "mod", "{}"]
        result = _row_to_node(row)
        assert result["properties"] is None

    def test_numeric_id_coerced_to_string(self):
        row = [123, "File", "x.py", None]
        result = _row_to_node(row)
        assert result["id"] == "123"


# ---------------------------------------------------------------------------
# GraphStore integration tests (require real_ladybug)
# ---------------------------------------------------------------------------

ladybug = pytest.importorskip("real_ladybug")

from opentrace_agent.store import GraphStore  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    db_path = str(tmp_path / "testdb")
    s = GraphStore(db_path)
    yield s
    s.close()


def _seed(store: GraphStore) -> None:
    """Insert a small graph for testing."""
    store.add_node("svc-api", "Service", "api-gateway", {"language": "go", "port": 8080})
    store.add_node("svc-db", "Database", "postgres", {"engine": "postgresql", "version": "16"})
    store.add_node("fn-handle", "Function", "handleRequest", {"path": "cmd/server/main.go", "lines": 45})
    store.add_node("fn-query", "Function", "queryDB", {"path": "pkg/db/query.go", "lines": 30})
    store.add_node("cls-user", "Class", "UserService", {"path": "pkg/user/service.go"})
    store.add_relationship("r1", "CALLS", "fn-handle", "fn-query")
    store.add_relationship("r2", "CONTAINS", "svc-api", "fn-handle")
    store.add_relationship("r3", "CONNECTS_TO", "svc-api", "svc-db")
    store.add_relationship("r4", "CONTAINS", "svc-api", "cls-user")


class TestGraphStoreGetNode:
    def test_get_existing(self, store):
        store.add_node("n1", "File", "main.py", {"language": "python"})
        node = store.get_node("n1")
        assert node is not None
        assert node["id"] == "n1"
        assert node["type"] == "File"
        assert node["name"] == "main.py"
        assert node["properties"]["language"] == "python"

    def test_get_missing(self, store):
        assert store.get_node("does-not-exist") is None

    def test_properties_roundtrip_complex(self, store):
        """Nested properties survive the marshal/unmarshal round-trip."""
        props = {"tags": ["a", "b"], "meta": {"nested": True}, "count": 42}
        store.add_node("complex", "Module", "complex", props)
        node = store.get_node("complex")
        assert node["properties"] == props

    def test_node_without_properties(self, store):
        store.add_node("bare", "File", "bare.txt")
        node = store.get_node("bare")
        assert node is not None
        assert node["properties"] is None


class TestGraphStoreListNodes:
    def test_list_by_type(self, store):
        _seed(store)
        functions = store.list_nodes("Function")
        assert len(functions) == 2
        names = {n["name"] for n in functions}
        assert names == {"handleRequest", "queryDB"}

    def test_list_with_filters(self, store):
        _seed(store)
        result = store.list_nodes("Function", filters={"path": "cmd/server/main.go"})
        assert len(result) == 1
        assert result[0]["name"] == "handleRequest"

    def test_list_empty_type(self, store):
        _seed(store)
        assert store.list_nodes("NonexistentType") == []

    def test_list_respects_limit(self, store):
        _seed(store)
        result = store.list_nodes("Function", limit=1)
        assert len(result) == 1


class TestGraphStoreSearchNodes:
    def test_substring_search(self, store):
        _seed(store)
        results = store.search_nodes("query")
        names = {n["name"] for n in results}
        assert "queryDB" in names

    def test_case_insensitive(self, store):
        _seed(store)
        results = store.search_nodes("HANDLEREQUEST")
        names = {n["name"] for n in results}
        assert "handleRequest" in names

    def test_search_with_type_filter(self, store):
        _seed(store)
        results = store.search_nodes("api", node_types=["Service"])
        assert all(n["type"] == "Service" for n in results)

    def test_search_no_results(self, store):
        _seed(store)
        results = store.search_nodes("zzz_nonexistent_zzz")
        assert results == []

    def test_search_respects_limit(self, store):
        _seed(store)
        results = store.search_nodes("e", limit=2)  # broad query
        assert len(results) <= 2


class TestGraphStoreSearchGraph:
    def test_search_graph_returns_neighbors(self, store):
        _seed(store)
        nodes, rels = store.search_graph("handleRequest", hops=1)
        node_ids = {n["id"] for n in nodes}
        # Should include the match and its neighbors
        assert "fn-handle" in node_ids
        assert len(rels) > 0

    def test_search_graph_hops_zero(self, store):
        _seed(store)
        nodes, rels = store.search_graph("api", hops=0)
        # hops=0 means only matched nodes, no expansion
        assert len(nodes) >= 1
        # rels should only be between matched nodes
        node_ids = {n["id"] for n in nodes}
        for r in rels:
            assert r["source_id"] in node_ids
            assert r["target_id"] in node_ids

    def test_search_graph_no_match(self, store):
        _seed(store)
        nodes, rels = store.search_graph("zzz_nonexistent_zzz")
        assert nodes == []
        assert rels == []

    def test_hops_clamped_to_max(self, store):
        """hops > 5 should be clamped to 5 (not error)."""
        _seed(store)
        nodes, rels = store.search_graph("api", hops=100)
        assert isinstance(nodes, list)


class TestGraphStoreTraverse:
    def test_outgoing(self, store):
        _seed(store)
        results = store.traverse("fn-handle", direction="outgoing", max_depth=1)
        neighbor_ids = {r["node"]["id"] for r in results}
        assert "fn-query" in neighbor_ids

    def test_incoming(self, store):
        _seed(store)
        results = store.traverse("fn-handle", direction="incoming", max_depth=1)
        neighbor_ids = {r["node"]["id"] for r in results}
        assert "svc-api" in neighbor_ids

    def test_both_directions(self, store):
        _seed(store)
        results = store.traverse("fn-handle", direction="both", max_depth=1)
        neighbor_ids = {r["node"]["id"] for r in results}
        assert "fn-query" in neighbor_ids
        assert "svc-api" in neighbor_ids

    def test_relationship_type_filter(self, store):
        _seed(store)
        results = store.traverse("svc-api", direction="outgoing", max_depth=1, relationship_type="CALLS")
        # svc-api has no direct CALLS — only CONTAINS and CONNECTS_TO
        assert len(results) == 0

    def test_depth_limited(self, store):
        _seed(store)
        results = store.traverse("svc-api", direction="outgoing", max_depth=1)
        # depth=1 from svc-api: fn-handle, svc-db, cls-user
        ids = {r["node"]["id"] for r in results}
        assert "fn-handle" in ids
        # fn-query is 2 hops away — should NOT appear
        assert "fn-query" not in ids

    def test_multi_hop(self, store):
        _seed(store)
        results = store.traverse("svc-api", direction="outgoing", max_depth=2)
        ids = {r["node"]["id"] for r in results}
        # fn-query is 2 hops: svc-api → fn-handle → fn-query
        assert "fn-query" in ids

    def test_traverse_nonexistent_node_raises(self, store):
        with pytest.raises(ValueError, match="node not found"):
            store.traverse("ghost", direction="outgoing")

    def test_relationship_properties_roundtrip(self, store):
        """Relationship properties should survive traversal."""
        store.add_node("a", "Service", "a")
        store.add_node("b", "Service", "b")
        store.add_relationship("r-ab", "CALLS", "a", "b", properties={"latency_ms": 50})
        results = store.traverse("a", direction="outgoing", max_depth=1)
        assert len(results) == 1
        assert results[0]["relationship"]["properties"]["latency_ms"] == 50

    def test_traverse_includes_depth(self, store):
        _seed(store)
        results = store.traverse("svc-api", direction="outgoing", max_depth=2)
        depths = {r["node"]["id"]: r["depth"] for r in results}
        assert depths.get("fn-handle") == 1
        assert depths.get("fn-query") == 2


class TestGraphStoreStats:
    def test_stats_empty(self, store):
        stats = store.get_stats()
        assert stats["total_nodes"] == 0
        assert stats["total_edges"] == 0
        assert stats["nodes_by_type"] == {}

    def test_stats_after_seed(self, store):
        _seed(store)
        stats = store.get_stats()
        assert stats["total_nodes"] == 5
        assert stats["total_edges"] == 4
        assert stats["nodes_by_type"]["Function"] == 2
        assert stats["nodes_by_type"]["Service"] == 1

    def test_stats_after_node_update(self, store):
        """MERGE should not duplicate nodes."""
        store.add_node("n1", "File", "a.py")
        store.add_node("n1", "File", "a_renamed.py")  # same id = update
        stats = store.get_stats()
        assert stats["total_nodes"] == 1


class TestGraphStoreImportBatch:
    def test_batch_import(self, store):
        nodes = [
            {"id": "b1", "type": "File", "name": "a.py", "properties": {"lang": "py"}},
            {"id": "b2", "type": "File", "name": "b.py", "properties": None},
        ]
        rels = [{"id": "br1", "type": "IMPORTS", "source_id": "b1", "target_id": "b2"}]
        summary = store.import_batch(nodes, rels)
        assert summary["nodes_created"] == 2
        assert summary["relationships_created"] == 1
        assert summary["errors"] == 0

    def test_batch_empty(self, store):
        summary = store.import_batch([], [])
        assert summary["nodes_created"] == 0
        assert summary["relationships_created"] == 0


class TestGraphStoreContextManager:
    def test_context_manager(self, tmp_path):
        db_path = str(tmp_path / "ctxdb")
        with GraphStore(db_path) as s:
            s.add_node("cm-1", "File", "test.py")
            assert s.get_node("cm-1") is not None
        # After __exit__, re-opening should still see the data
        with GraphStore(db_path) as s2:
            assert s2.get_node("cm-1") is not None
