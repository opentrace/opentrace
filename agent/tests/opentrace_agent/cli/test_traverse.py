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

"""Tests for ``opentrace traverse`` subcommand."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from opentrace_agent.cli.main import app


def _invoke(store: MagicMock, tmp_path, *args: str):
    with patch("opentrace_agent.store.GraphStore", return_value=store), patch(
        "opentrace_agent.cli.main._resolve_db",
        return_value=str(tmp_path / "fake.db"),
    ):
        return CliRunner().invoke(app, ["traverse", *args])


def _node(id_: str, type_: str = "Function", name: str | None = None, **props):
    return {"id": id_, "type": type_, "name": name or id_, "properties": dict(props)}


def _rel(rel_type: str, source: str, target: str):
    return {
        "id": f"r:{source}:{rel_type}:{target}",
        "type": rel_type,
        "source_id": source,
        "target_id": target,
        "properties": {},
    }


class TestTraverseJson:
    def test_default_outgoing_depth_two(self, tmp_path) -> None:
        store = MagicMock()
        store.traverse.return_value = [
            {
                "node": _node("b"),
                "relationship": _rel("CALLS", "a", "b"),
                "depth": 1,
            },
            {
                "node": _node("c"),
                "relationship": _rel("CALLS", "b", "c"),
                "depth": 2,
            },
        ]

        result = _invoke(store, tmp_path, "a", "--json")
        assert result.exit_code == 0, result.output

        payload = json.loads(result.output)
        assert payload["start"] == "a"
        assert payload["direction"] == "outgoing"
        assert payload["depth"] == 2
        assert payload["relType"] is None
        assert payload["totalResults"] == 2

        # Real depth is preserved (no "depth=1 lie").
        depths = [r["depth"] for r in payload["results"]]
        assert depths == [1, 2]

        # Relationship is passed through with source/target — no
        # contrived "direction" classification (which only makes sense
        # at depth=1).
        rel = payload["results"][1]["relationship"]
        assert rel["source_id"] == "b"
        assert rel["target_id"] == "c"
        assert "direction" not in rel

        store.traverse.assert_called_once_with(
            "a", direction="outgoing", max_depth=2, relationship_type=None
        )

    def test_custom_direction_depth_and_rel_type(self, tmp_path) -> None:
        store = MagicMock()
        store.traverse.return_value = []

        result = _invoke(
            store,
            tmp_path,
            "a",
            "--direction",
            "incoming",
            "--depth",
            "5",
            "--rel-type",
            "CALLS",
            "--json",
        )
        assert result.exit_code == 0, result.output

        payload = json.loads(result.output)
        assert payload["direction"] == "incoming"
        assert payload["depth"] == 5
        assert payload["relType"] == "CALLS"

        store.traverse.assert_called_once_with(
            "a", direction="incoming", max_depth=5, relationship_type="CALLS"
        )

    def test_rel_type_filter_returned_results(self, tmp_path) -> None:
        """``--rel-type`` is forwarded to the store and the filtered rows
        round-trip into the JSON envelope."""
        store = MagicMock()
        store.traverse.return_value = [
            {
                "node": _node("b"),
                "relationship": _rel("CALLS", "a", "b"),
                "depth": 1,
            },
        ]

        result = _invoke(
            store,
            tmp_path,
            "a",
            "--rel-type",
            "CALLS",
            "--json",
        )
        assert result.exit_code == 0, result.output

        payload = json.loads(result.output)
        assert payload["relType"] == "CALLS"
        assert payload["totalResults"] == 1
        assert payload["results"][0]["relationship"]["type"] == "CALLS"

        store.traverse.assert_called_once_with(
            "a", direction="outgoing", max_depth=2, relationship_type="CALLS"
        )

    def test_depth_clamped_to_maximum(self, tmp_path) -> None:
        """Depth is clamped to match the MCP ``traverse_graph`` cap, and
        the user is warned on stderr so they don't think they got the
        depth they asked for."""
        store = MagicMock()
        store.traverse.return_value = []

        result = _invoke(store, tmp_path, "a", "--depth", "999", "--json")
        assert result.exit_code == 0, result.output

        # Warning lands on stderr, mentions both the requested and
        # effective depth.
        assert "999" in result.stderr
        assert "10" in result.stderr
        assert "Warning" in result.stderr

        # JSON envelope reflects the clamped depth, not the requested one.
        # Parse stdout only — stderr is captured separately by CliRunner.
        payload = json.loads(result.stdout)
        assert payload["depth"] == 10

        store.traverse.assert_called_once_with(
            "a", direction="outgoing", max_depth=10, relationship_type=None
        )

    def test_depth_at_cap_does_not_warn(self, tmp_path) -> None:
        """``--depth 10`` (the cap exactly) is fine; no warning."""
        store = MagicMock()
        store.traverse.return_value = []

        result = _invoke(store, tmp_path, "a", "--depth", "10")
        assert result.exit_code == 0, result.output
        assert "Warning" not in (result.stderr or "")

    def test_invalid_direction_rejected_by_click(self, tmp_path) -> None:
        store = MagicMock()
        result = _invoke(store, tmp_path, "a", "--direction", "sideways")
        assert result.exit_code != 0
        # click's choice validator handles this — store.traverse never runs.
        store.traverse.assert_not_called()


class TestTraverseText:
    def test_groups_by_depth(self, tmp_path) -> None:
        store = MagicMock()
        store.traverse.return_value = [
            {
                "node": _node("b", name="b_func"),
                "relationship": _rel("CALLS", "a", "b"),
                "depth": 1,
            },
            {
                "node": _node("c", name="c_func"),
                "relationship": _rel("CALLS", "b", "c"),
                "depth": 2,
            },
        ]

        result = _invoke(store, tmp_path, "a")
        assert result.exit_code == 0, result.output

        out = result.output
        assert "Traversal outgoing from a" in out
        assert "max depth 2" in out
        assert "Depth 1 (1):" in out
        assert "Depth 2 (1):" in out
        # Outgoing rows render the discovered node as the arrow's target,
        # with the source node id on the left so readers can trace the
        # edge orientation regardless of depth.
        assert "(a) --CALLS--> [Function] b_func (b)" in out
        assert "(b) --CALLS--> [Function] c_func (c)" in out

    def test_incoming_arrows_keep_source_target_orientation(self, tmp_path) -> None:
        """For ``--direction incoming`` the discovered node is the source
        of the relationship; the row should render with the discovered
        node on the left of the arrow and the start node on the right."""
        store = MagicMock()
        store.traverse.return_value = [
            {
                "node": _node("caller_id", name="caller"),
                "relationship": _rel("CALLS", "caller_id", "a"),
                "depth": 1,
            },
        ]

        result = _invoke(store, tmp_path, "a", "--direction", "incoming")
        assert result.exit_code == 0, result.output

        out = result.output
        assert "Traversal incoming from a" in out
        assert "[Function] caller (caller_id) --CALLS--> (a)" in out
        # The old "always --TYPE--> after the arrow" rendering would have
        # suggested an outgoing edge from the start node — guard against
        # that regression.
        assert "--CALLS--> [Function] caller" not in out

    def test_empty_results(self, tmp_path) -> None:
        store = MagicMock()
        store.traverse.return_value = []

        result = _invoke(store, tmp_path, "isolated")
        assert result.exit_code == 0, result.output
        assert "no neighbors reached" in result.output


class TestTraverseMissing:
    def test_missing_start_node_exits_nonzero(self, tmp_path) -> None:
        store = MagicMock()
        store.traverse.side_effect = ValueError("node not found: ghost")

        result = _invoke(store, tmp_path, "ghost", "--json")
        assert result.exit_code != 0
        assert "node not found: ghost" in result.output
