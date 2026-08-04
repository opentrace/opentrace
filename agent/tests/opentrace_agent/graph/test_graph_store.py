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
    _parse_ladybug_map,
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

    def test_includes_one_line_summary(self):
        # KnowledgeConcept pages store their gloss under one_line_summary.
        text = build_search_text("Auth", "KnowledgeConcept", {"one_line_summary": "how staff sign in"})
        assert "how staff sign in" in text

    def test_includes_description(self):
        # Some legacy node types store their gloss under description — index
        # it so those nodes stay findable by content, not just by name.
        text = build_search_text("Engram", "Service", {"description": "persistent memory system"})
        assert "persistent memory system" in text

    def test_includes_all_gloss_keys_together(self):
        text = build_search_text(
            "n",
            "KnowledgeDoc",
            {"summary": "a", "one_line_summary": "b", "description": "c", "path": "p"},
        )
        for token in ("a", "b", "c", "p"):
            assert token in text.split()

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

    def test_wildcard_substring(self):
        assert matches_filters({"name": "userService"}, {"name": "*Service"})
        assert matches_filters({"name": "userService"}, {"name": "user*"})
        assert matches_filters({"name": "userService"}, {"name": "*erSer*"})

    def test_wildcard_no_match(self):
        assert not matches_filters({"name": "userService"}, {"name": "*foo*"})

    def test_wildcard_anchors(self):
        # 'user*' is anchored — does not match a string starting with something else
        assert not matches_filters({"name": "MyUserService"}, {"name": "user*"})

    def test_wildcard_only_when_star_present(self):
        # No `*` → exact match still applies; `Service` does NOT match `userService`.
        assert not matches_filters({"name": "userService"}, {"name": "Service"})


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

    def test_ladybug_map_literal(self):
        """LadybugDB returns {key: value} format instead of JSON."""
        result = _unmarshal_props("{path: cmd/main.go, language: go}")
        assert result == {"path": "cmd/main.go", "language": "go"}

    def test_ladybug_map_with_integers(self):
        result = _unmarshal_props("{start_line: 25, end_line: 38}")
        assert result == {"start_line": 25, "end_line": 38}

    def test_invalid_string_returns_none(self):
        assert _unmarshal_props("not json or map") is None


class TestParseLadybugMap:
    """Tests for parsing LadybugDB's {key: value} map literal format."""

    def test_simple(self):
        assert _parse_ladybug_map("{path: src/main.go}") == {"path": "src/main.go"}

    def test_multiple_keys(self):
        result = _parse_ladybug_map("{path: cmd/main.go, extension: .go, language: go}")
        assert result == {"path": "cmd/main.go", "extension": ".go", "language": "go"}

    def test_integer_values(self):
        result = _parse_ladybug_map("{start_line: 25, end_line: 38}")
        assert result == {"start_line": 25, "end_line": 38}

    def test_boolean_values(self):
        result = _parse_ladybug_map("{exported: True, deprecated: False}")
        assert result == {"exported": True, "deprecated": False}

    def test_empty_braces(self):
        assert _parse_ladybug_map("{}") is None

    def test_not_a_map(self):
        assert _parse_ladybug_map("hello") is None

    def test_summary_with_spaces(self):
        result = _parse_ladybug_map("{summary: Source code repository for project}")
        assert result == {"summary": "Source code repository for project"}

    def test_value_with_commas_in_nested_braces(self):
        """Commas inside nested structures should not split the pair."""
        result = _parse_ladybug_map("{signature: (name, email)}")
        assert result == {"signature": "(name, email)"}


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

    def test_invalid_string_returns_none(self):
        assert _parse_props("not json or map") is None

    def test_ladybug_map_literal(self):
        """LadybugDB's {key: value} format should be parsed correctly."""
        result = _parse_props("{path: cmd/main.go, language: go}")
        assert result == {"path": "cmd/main.go", "language": "go"}

    def test_ladybug_map_with_numbers(self):
        result = _parse_props("{start_line: 25, end_line: 38}")
        assert result == {"start_line": 25, "end_line": 38}


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

    def test_properties_roundtrip_db_format(self, store):
        """Properties survive write→read even if LadybugDB re-encodes them.

        LadybugDB may auto-convert JSON strings into its internal MAP format
        on storage, returning {key: value} (no quotes) on read. This test
        verifies the full roundtrip produces valid dicts regardless.
        """
        props = {"path": "cmd/server/main.go", "extension": ".go", "language": "go"}
        store.add_node("rt-1", "File", "main.go", props)
        node = store.get_node("rt-1")
        assert node["properties"] is not None
        assert isinstance(node["properties"], dict)
        assert node["properties"]["path"] == "cmd/server/main.go"
        assert node["properties"]["language"] == "go"

    def test_properties_roundtrip_with_integers(self, store):
        """Integer values survive the roundtrip."""
        props = {"startLine": 25, "endLine": 38, "language": "go"}
        store.add_node("rt-2", "Function", "main", props)
        node = store.get_node("rt-2")
        assert node["properties"] is not None
        assert node["properties"]["startLine"] == 25
        assert node["properties"]["endLine"] == 38

    def test_properties_roundtrip_with_booleans(self, store):
        """Boolean values survive the roundtrip."""
        props = {"exported": True, "deprecated": False}
        store.add_node("rt-3", "Function", "Foo", props)
        node = store.get_node("rt-3")
        assert node["properties"] is not None
        assert node["properties"]["exported"] is True
        assert node["properties"]["deprecated"] is False

    def test_properties_roundtrip_via_search(self, store):
        """Properties are correct when accessed via search_nodes (not just get_node)."""
        props = {"path": "pkg/db/store.go", "language": "go"}
        store.add_node("rt-search", "File", "store.go", props)
        results = store.search_nodes("store.go")
        matching = [n for n in results if n["id"] == "rt-search"]
        assert len(matching) == 1
        assert isinstance(matching[0]["properties"], dict)
        assert matching[0]["properties"]["path"] == "pkg/db/store.go"

    def test_properties_roundtrip_via_traverse(self, store):
        """Properties are correct on nodes reached via traversal."""
        store.add_node("rt-src", "Class", "Handler", {"exported": True})
        store.add_node("rt-tgt", "Function", "handle", {"startLine": 10})
        store.add_relationship("rt-rel", "DEFINES", "rt-src", "rt-tgt")
        results = store.traverse("rt-src", direction="outgoing", max_depth=1)
        assert len(results) == 1
        node_props = results[0]["node"]["properties"]
        assert isinstance(node_props, dict)
        assert node_props["startLine"] == 10


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


class TestGraphStoreMetadata:
    def test_save_and_get(self, store):
        store.save_metadata({"repoId": "owner/repo", "indexedAt": "2026-01-01T00:00:00Z"})
        entries = store.get_metadata()
        assert len(entries) == 1
        assert entries[0]["repoId"] == "owner/repo"
        assert entries[0]["indexedAt"] == "2026-01-01T00:00:00Z"

    def test_multi_repo(self, store):
        store.save_metadata({"repoId": "org/alpha", "commitSha": "aaa"})
        store.save_metadata({"repoId": "org/beta", "commitSha": "bbb"})
        entries = store.get_metadata()
        assert len(entries) == 2
        repo_ids = {e["repoId"] for e in entries}
        assert repo_ids == {"org/alpha", "org/beta"}

    def test_upsert_same_repo(self, store):
        store.save_metadata({"repoId": "org/repo", "commitSha": "111"})
        store.save_metadata({"repoId": "org/repo", "commitSha": "222"})
        entries = store.get_metadata()
        assert len(entries) == 1
        assert entries[0]["commitSha"] == "222"

    def test_empty_when_no_metadata(self, store):
        assert store.get_metadata() == []

    def test_excluded_from_stats(self, store):
        _seed(store)
        store.save_metadata({"repoId": "test/repo"})
        stats = store.get_stats()
        assert "IndexMetadata" not in stats["nodes_by_type"]
        # Node count should not include the metadata node
        assert stats["total_nodes"] == 5

    def test_excluded_from_search(self, store):
        store.save_metadata({"repoId": "test/repo", "commitSha": "abc123"})
        results = store.search_nodes("index")
        assert all(n["type"] != "IndexMetadata" for n in results)
        results = store.search_nodes("test/repo")
        assert all(n["type"] != "IndexMetadata" for n in results)


class TestGraphStoreFindFilesByBasename:
    def _seed_files(self, store: GraphStore) -> None:
        store.add_node(
            "repo/packages/auth/src/index.ts",
            "File",
            "index.ts",
            {"path": "packages/auth/src/index.ts"},
        )
        store.add_node(
            "repo/packages/billing/src/index.ts",
            "File",
            "index.ts",
            {"path": "packages/billing/src/index.ts"},
        )
        store.add_node("repo/index.ts", "File", "index.ts", {"path": "index.ts"})
        store.add_node("repo/src/utils.ts", "File", "utils.ts", {"path": "src/utils.ts"})
        # A non-File node sharing the basename must be ignored.
        store.add_node("class-utils", "Class", "utils.ts", {"path": "src/utils.ts"})

    def test_unique_match(self, store):
        self._seed_files(store)
        results = store.find_files_by_basename("utils.ts")
        assert len(results) == 1
        assert results[0]["id"] == "repo/src/utils.ts"

    def test_multiple_matches_returned(self, store):
        self._seed_files(store)
        results = store.find_files_by_basename("index.ts")
        ids = sorted(r["id"] for r in results)
        assert ids == [
            "repo/index.ts",
            "repo/packages/auth/src/index.ts",
            "repo/packages/billing/src/index.ts",
        ]

    def test_root_of_repo_match(self, store):
        """A File with ``path == basename`` (no parent dir) is included."""
        store.add_node("r/README.md", "File", "README.md", {"path": "README.md"})
        results = store.find_files_by_basename("README.md")
        assert len(results) == 1
        assert results[0]["properties"]["path"] == "README.md"

    def test_no_match_returns_empty(self, store):
        self._seed_files(store)
        assert store.find_files_by_basename("does_not_exist.py") == []

    def test_limit_caps_result_count(self, store):
        self._seed_files(store)
        results = store.find_files_by_basename("index.ts", limit=2)
        assert len(results) == 2

    def test_does_not_match_substring_basename(self, store):
        """``Buttonish.tsx`` must not match a search for ``Button.tsx``."""
        store.add_node("r/Buttonish.tsx", "File", "Buttonish.tsx", {"path": "src/Buttonish.tsx"})
        store.add_node("r/Button.tsx", "File", "Button.tsx", {"path": "src/Button.tsx"})
        results = store.find_files_by_basename("Button.tsx")
        assert len(results) == 1
        assert results[0]["id"] == "r/Button.tsx"


class TestGraphStoreContextManager:
    def test_context_manager(self, tmp_path):
        db_path = str(tmp_path / "ctxdb")
        with GraphStore(db_path) as s:
            s.add_node("cm-1", "File", "test.py")
            assert s.get_node("cm-1") is not None
        # After __exit__, re-opening should still see the data
        with GraphStore(db_path) as s2:
            assert s2.get_node("cm-1") is not None


class TestKnowledgeGraph:
    """Community, hyperedge, and semantic-edge round-trips."""

    def test_save_community_roundtrip(self, store):
        store.save_community("c1", "Auth Subsystem", 1, 0.82, 14, is_god=True)
        node = store.get_node("c1")
        assert node["type"] == "Community"
        assert node["name"] == "Auth Subsystem"
        assert node["properties"]["community_id"] == 1
        assert node["properties"]["cohesion"] == 0.82
        assert node["properties"]["members"] == 14
        assert node["properties"]["is_god"] is True

    def test_save_hyperedge_roundtrip(self, store):
        store.save_hyperedge("h1", "OAuth Handshake", "implement", "INFERRED", 0.75, source_file="auth.py")
        node = store.get_node("h1")
        assert node["type"] == "Hyperedge"
        assert node["properties"]["relation"] == "implement"
        assert node["properties"]["confidence"] == "INFERRED"
        assert node["properties"]["confidence_score"] == 0.75
        assert node["properties"]["source_file"] == "auth.py"

    def test_save_semantic_edge_persists_confidence(self, store):
        store.add_node("a", "Function", "login")
        store.add_node("b", "Function", "authenticate")
        store.save_semantic_edge(
            "se1",
            "a",
            "b",
            "rationale_for",
            "AMBIGUOUS",
            0.3,
            source_file="auth.py",
            source_location="auth.py:42",
        )
        rels = store.list_relationships_for_nodes({"a", "b"})
        assert len(rels) == 1
        rel = rels[0]
        assert rel["type"] == "SEMANTIC_EDGE"
        assert rel["properties"]["confidence"] == "AMBIGUOUS"
        assert rel["properties"]["confidence_score"] == 0.3
        assert rel["properties"]["source_location"] == "auth.py:42"

    def test_membership_query(self, store):
        store.add_node("fn1", "Function", "login")
        store.save_community("c1", "Auth", 1, 0.7, 5)
        store.save_membership("m1", "fn1", "c1")
        community = store.get_node_community("fn1")
        assert community is not None
        assert community["id"] == "c1"
        assert community["name"] == "Auth"
        assert community["community_id"] == 1

    def test_get_node_community_returns_none_for_unassigned(self, store):
        store.add_node("orphan", "Function", "orphan")
        assert store.get_node_community("orphan") is None

    def test_list_communities_ordered_by_community_id(self, store):
        store.save_community("c2", "Beta", 2, 0.6, 3)
        store.save_community("c1", "Alpha", 1, 0.7, 5)
        store.save_community("c3", "Gamma", 3, 0.5, 8)
        names = [c["name"] for c in store.list_communities()]
        assert names == ["Alpha", "Beta", "Gamma"]

    def test_participation_query(self, store):
        store.add_node("fn1", "Function", "step1")
        store.save_hyperedge("h1", "Login Flow", "participate_in", "EXTRACTED", 1.0)
        store.save_hyperedge("h2", "Audit Log", "participate_in", "INFERRED", 0.7)
        store.save_participation("p1", "fn1", "h1")
        store.save_participation("p2", "fn1", "h2")
        hyperedges = store.list_hyperedges_for_node("fn1")
        names = sorted(h["name"] for h in hyperedges)
        assert names == ["Audit Log", "Login Flow"]

    def test_list_god_nodes_sorted_by_degree(self, store):
        _seed(store)
        gods = store.list_god_nodes(limit=5)
        # svc-api has the most edges (3 outgoing)
        assert gods[0]["id"] == "svc-api"
        assert gods[0]["degree"] >= 3

    def test_list_god_nodes_excludes_types(self, store):
        _seed(store)
        gods = store.list_god_nodes(limit=10, exclude_types=("Service",))
        assert all(g["type"] != "Service" for g in gods)

    def test_cross_community_bridges(self, store):
        # Two communities, one bridge edge
        store.save_community("ca", "A", 1, 0.7, 2)
        store.save_community("cb", "B", 2, 0.7, 2)
        store.add_node("n1", "Function", "n1")
        store.add_node("n2", "Function", "n2")
        store.save_membership("m1", "n1", "ca")
        store.save_membership("m2", "n2", "cb")
        store.add_relationship("r1", "CALLS", "n1", "n2")
        bridges = store.list_cross_community_bridges()
        assert len(bridges) == 1
        b = bridges[0]
        assert b["source_id"] == "n1"
        assert b["target_id"] == "n2"
        assert b["source_community_id"] != b["target_community_id"]
        assert b["relation"] == "CALLS"

    def test_cross_community_bridges_excludes_same_community(self, store):
        store.save_community("ca", "A", 1, 0.7, 3)
        store.add_node("n1", "Function", "n1")
        store.add_node("n2", "Function", "n2")
        store.save_membership("m1", "n1", "ca")
        store.save_membership("m2", "n2", "ca")
        store.add_relationship("r1", "CALLS", "n1", "n2")
        assert store.list_cross_community_bridges() == []


class TestFtsSearchOrdering:
    """``_fts_search`` must return best-first — every caller truncates the list."""

    def test_results_sorted_by_score_descending(self, store):
        # Several nodes matching "isolation" to differing degrees: an exact-name
        # match, a gloss match, and weak incidental matches.
        store.add_node("e1", "Idea", "Cross-Origin Isolation", {"description": "isolation of origins"})
        store.add_node(
            "d1",
            "KnowledgeDoc",
            "browser-requirements.md",
            {"summary": "Cross-origin isolation requirements for the browser build", "path": "docs/browser.md"},
        )
        store.add_node("n1", "Function", "isolate", {"summary": "unrelated isolation helper"})
        store.add_node("n2", "Function", "spawn", {"summary": "mentions isolation once in passing"})
        store.add_node("n3", "Class", "Sandbox", {"summary": "isolation boundary for plugins"})

        results = store._fts_search("cross-origin isolation", 10)
        scores = [score for _, score in results]
        assert scores == sorted(scores, reverse=True), f"not best-first: {results}"

    def test_sorts_rows_the_connection_returns_out_of_order(self, store):
        """The real regression: ``top :=`` picks the top-N but doesn't order them.

        A small fixture can't reproduce the DB's internal row order (it happens
        to come back sorted), so this drives ``_fts_search`` with a connection
        whose rows are deliberately unsorted — the shape observed on a real
        25-doc index, where a KnowledgeDoc scoring 4.308 arrived last behind
        hits scoring 1.4 and was cut off by every caller's limit.
        """

        # A small custom class, not MagicMock — MagicMock can't intercept
        # __getattr__ on the result object (see agent/CLAUDE.md).
        class FakeResult:
            def __init__(self, rows):
                self._rows = list(rows)

            def has_next(self):
                return bool(self._rows)

            def get_next(self):
                return self._rows.pop(0)

        class FakeConn:
            def __init__(self, rows):
                self._rows = rows

            def execute(self, *_args, **_kwargs):
                return FakeResult(self._rows)

        unsorted_rows = [
            ["svc-opentrace", 4.605],
            ["idea-cross-origin", 3.864],
            ["idea-sab", 4.462],
            ["svc-uv", 1.498],
            ["doc-browser-reqs", 4.308],  # arrived last on the real index
        ]
        real_conn = store._conn
        store._conn = FakeConn(unsorted_rows)
        try:
            results = store._fts_search("cross-origin isolation", 10)
        finally:
            store._conn = real_conn  # so the fixture's close() still works
        scores = [score for _, score in results]
        assert scores == sorted(scores, reverse=True), f"not best-first: {results}"
        # And the consequence that actually bit: the doc survives a limit of 3.
        assert "doc-browser-reqs" in [nid for nid, _ in results[:3]]
