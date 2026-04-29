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

"""Tests for ``opentrace get-node`` subcommand.

The command bundles ``store.get_node(id)`` and
``store.traverse(id, direction='both', max_depth=1)`` into a single
envelope. These tests exercise both output modes plus the ergonomics
that distinguish the CLI surface from raw store calls — direction
classification, error on missing node, and graceful handling when
``traverse`` raises after ``get_node`` succeeded.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from opentrace_agent.cli.main import app


def _invoke(store: MagicMock, tmp_path, *args: str):
    """Invoke ``opentrace get-node`` with a patched GraphStore."""
    with (
        patch("opentrace_agent.store.GraphStore", return_value=store),
        patch(
            "opentrace_agent.cli.main._resolve_db",
            return_value=str(tmp_path / "fake.db"),
        ),
    ):
        return CliRunner().invoke(app, ["get-node", *args])


def _node(id_: str, type_: str = "Function", name: str | None = None, **props):
    return {"id": id_, "type": type_, "name": name or id_, "properties": dict(props)}


def _rel(rel_type: str, source: str, target: str, *, rel_id: str | None = None):
    return {
        "id": rel_id or f"r:{source}:{rel_type}:{target}",
        "type": rel_type,
        "source_id": source,
        "target_id": target,
        "properties": {},
    }


class TestGetNodeJson:
    def test_node_plus_neighbors_envelope(self, tmp_path) -> None:
        """JSON output bundles node + classified neighbors."""
        store = MagicMock()
        target_id = "repo/foo.py::bar"
        store.get_node.return_value = _node(target_id, name="bar", path="foo.py", start_line=10, end_line=20)
        store.traverse.return_value = [
            {
                "node": _node("repo/foo.py::baz", name="baz"),
                "relationship": _rel("CALLS", target_id, "repo/foo.py::baz"),
                "depth": 1,
            },
            {
                "node": _node("repo/qux.py::caller", name="caller"),
                "relationship": _rel("CALLS", "repo/qux.py::caller", target_id),
                "depth": 1,
            },
        ]

        result = _invoke(store, tmp_path, target_id, "--json")
        assert result.exit_code == 0, result.output

        payload = json.loads(result.output)
        assert payload["node"]["id"] == target_id
        assert payload["node"]["name"] == "bar"
        assert payload["node"]["properties"]["path"] == "foo.py"

        directions = [n["relationship"]["direction"] for n in payload["neighbors"]]
        assert directions == ["outgoing", "incoming"]

        # store.traverse called with the documented arguments.
        store.traverse.assert_called_once_with(target_id, direction="both", max_depth=1)

    def test_properties_always_dict_even_when_store_returns_none(self, tmp_path) -> None:
        """Consumers should be able to .get(...) on properties unconditionally."""
        store = MagicMock()
        node = _node("solo")
        node["properties"] = None  # store may return None for empty props
        store.get_node.return_value = node
        store.traverse.return_value = []

        result = _invoke(store, tmp_path, "solo", "--json")
        assert result.exit_code == 0, result.output

        payload = json.loads(result.output)
        assert payload["node"]["properties"] == {}
        assert payload["neighbors"] == []

    def test_traverse_raising_value_error_yields_empty_neighbors(self, tmp_path) -> None:
        """If traverse fails after get_node succeeded, surface zero neighbors
        rather than failing the whole command."""
        store = MagicMock()
        store.get_node.return_value = _node("solo")
        store.traverse.side_effect = ValueError("node vanished")

        result = _invoke(store, tmp_path, "solo", "--json")
        assert result.exit_code == 0, result.output

        payload = json.loads(result.output)
        assert payload["node"]["id"] == "solo"
        assert payload["neighbors"] == []


class TestGetNodeText:
    def test_text_output_includes_node_header_and_relationships(self, tmp_path) -> None:
        store = MagicMock()
        store.get_node.return_value = _node(
            "repo/foo.py::bar",
            type_="Function",
            name="bar",
            path="foo.py",
            start_line=10,
            end_line=20,
            signature="(x: int) -> int",
            language="python",
        )
        store.traverse.return_value = [
            {
                "node": _node("repo/foo.py::baz", name="baz"),
                "relationship": _rel("CALLS", "repo/foo.py::bar", "repo/foo.py::baz"),
                "depth": 1,
            },
            {
                "node": _node("repo/qux.py::caller", name="caller"),
                "relationship": _rel("CALLS", "repo/qux.py::caller", "repo/foo.py::bar"),
                "depth": 1,
            },
        ]

        result = _invoke(store, tmp_path, "repo/foo.py::bar")
        assert result.exit_code == 0, result.output

        out = result.output
        assert "[Function] bar" in out
        assert "ID: repo/foo.py::bar" in out
        assert "File: foo.py" in out
        assert "Lines: 10-20" in out
        assert "Signature: (x: int) -> int" in out
        assert "Language: python" in out
        assert "Outgoing relationships (1):" in out
        assert "--CALLS--> [Function] baz" in out
        assert "Incoming relationships (1):" in out
        assert "<--CALLS-- [Function] caller" in out

    def test_text_output_no_relationships(self, tmp_path) -> None:
        store = MagicMock()
        store.get_node.return_value = _node("isolated")
        store.traverse.return_value = []

        result = _invoke(store, tmp_path, "isolated")
        assert result.exit_code == 0, result.output
        assert "No relationships found." in result.output

    def test_text_output_truncates_long_neighbor_lists(self, tmp_path) -> None:
        store = MagicMock()
        store.get_node.return_value = _node("hub")
        store.traverse.return_value = [
            {
                "node": _node(f"target-{i}", name=f"target_{i}"),
                "relationship": _rel("CALLS", "hub", f"target-{i}"),
                "depth": 1,
            }
            for i in range(25)
        ]

        result = _invoke(store, tmp_path, "hub")
        assert result.exit_code == 0, result.output
        assert "Outgoing relationships (25):" in result.output
        assert "... and 5 more" in result.output


class TestGetNodeMissing:
    def test_missing_node_exits_nonzero_with_message(self, tmp_path) -> None:
        store = MagicMock()
        store.get_node.return_value = None

        result = _invoke(store, tmp_path, "ghost", "--json")
        assert result.exit_code != 0
        assert "Node not found: ghost" in result.output
        # traverse should not run for a node that doesn't exist.
        store.traverse.assert_not_called()
