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

"""Tests for the ``opentraceai augment`` subcommand and supporting logic."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from opentrace_agent.cli.augment import (
    _format_node,
    _format_rel,
    run_augment,
)

# -- formatting helpers ------------------------------------------------------


def test_format_node_with_path():
    node = {"type": "Function", "name": "do_stuff", "properties": {"path": "src/main.py"}}
    assert _format_node(node) == "  Function: do_stuff  (src/main.py)"


def test_format_node_without_path():
    node = {"type": "Service", "name": "api-gateway", "properties": {}}
    assert _format_node(node) == "  Service: api-gateway"


def test_format_node_no_properties():
    node = {"type": "Class", "name": "Foo", "properties": None}
    assert _format_node(node) == "  Class: Foo"


def test_format_rel_outgoing():
    rel = {"type": "CALLS", "source_id": "a"}
    neighbor = {"name": "bar", "type": "Function"}
    assert _format_rel(rel, neighbor, "out") == "    --CALLS--> bar (Function)"


def test_format_rel_incoming():
    rel = {"type": "IMPORTS", "source_id": "b"}
    neighbor = {"name": "baz", "type": "Module"}
    assert _format_rel(rel, neighbor, "in") == "    <--IMPORTS-- baz (Module)"


# -- run_augment -------------------------------------------------------------


def test_run_augment_none_db(capsys):
    """Should no-op when db_path is None."""
    run_augment("foo", None)
    assert capsys.readouterr().out == ""


def test_run_augment_no_matches(tmp_path, capsys):
    """Should produce no output when search returns nothing."""
    mock_store = MagicMock()
    mock_store.search_nodes.return_value = []

    with patch("opentrace_agent.store.KuzuStore", return_value=mock_store):
        run_augment("nonexistent", str(tmp_path / "fake.db"))

    assert capsys.readouterr().out == ""
    mock_store.close.assert_called_once()


def test_run_augment_with_matches(tmp_path, capsys):
    """Should print formatted output for matching nodes."""
    node = {"id": "n1", "type": "Function", "name": "handle_request", "properties": {"path": "src/api.py"}}
    neighbor = {"id": "n2", "type": "Module", "name": "auth", "properties": {}}
    rel = {"id": "r1", "type": "IMPORTS", "source_id": "n1", "target_id": "n2", "properties": {}}

    mock_store = MagicMock()
    mock_store.search_nodes.return_value = [node]
    mock_store._get_neighbors.return_value = [(neighbor, rel)]

    with patch("opentrace_agent.store.KuzuStore", return_value=mock_store):
        run_augment("handle_request", str(tmp_path / "fake.db"))

    out = capsys.readouterr().out
    assert "[OpenTrace] Graph context" in out
    assert "handle_request" in out
    assert "--IMPORTS-->" in out
    assert "auth (Module)" in out
    mock_store.close.assert_called_once()


def test_run_augment_db_open_fails(tmp_path, capsys):
    """Should silently no-op when the store can't be opened."""
    with patch("opentrace_agent.store.KuzuStore", side_effect=RuntimeError("locked")):
        run_augment("anything", str(tmp_path / "fake.db"))

    assert capsys.readouterr().out == ""


def test_run_augment_caps_relationships(tmp_path, capsys):
    """Should cap displayed relationships at _MAX_RELS_PER_NODE."""
    node = {"id": "n1", "type": "Class", "name": "BigClass", "properties": {}}
    # 8 CALLS relationships — only 5 should be shown
    neighbors = [
        (
            {"id": f"n{i}", "type": "Function", "name": f"fn_{i}", "properties": {}},
            {"id": f"r{i}", "type": "CALLS", "source_id": "n1", "target_id": f"n{i}", "properties": {}},
        )
        for i in range(8)
    ]

    mock_store = MagicMock()
    mock_store.search_nodes.return_value = [node]
    mock_store._get_neighbors.return_value = neighbors

    with patch("opentrace_agent.store.KuzuStore", return_value=mock_store):
        run_augment("BigClass", str(tmp_path / "fake.db"))

    out = capsys.readouterr().out
    assert "--CALLS-->" in out
    assert "... and" in out
    mock_store.close.assert_called_once()
