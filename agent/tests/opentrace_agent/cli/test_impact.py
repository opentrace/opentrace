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

"""Tests for the ``opentraceai impact`` subcommand."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from opentrace_agent.cli.impact import (
    _in_line_range,
    _symbol_label,
    run_impact,
)

# -- formatting helpers ------------------------------------------------------


def test_symbol_label_with_lines():
    node = {"type": "Function", "name": "do_stuff", "properties": {"start_line": 10, "end_line": 25}}
    assert _symbol_label(node) == "Function: do_stuff L10-25"


def test_symbol_label_without_lines():
    node = {"type": "Class", "name": "MyClass", "properties": {}}
    assert _symbol_label(node) == "Class: MyClass"


# -- line range filter -------------------------------------------------------


def test_in_line_range_no_filter():
    node = {"properties": {"start_line": 10, "end_line": 20}}
    assert _in_line_range(node, None) is True


def test_in_line_range_overlap():
    node = {"properties": {"start_line": 10, "end_line": 20}}
    assert _in_line_range(node, [(15, 25)]) is True


def test_in_line_range_no_overlap():
    node = {"properties": {"start_line": 10, "end_line": 20}}
    assert _in_line_range(node, [(25, 30)]) is False


def test_in_line_range_no_line_info():
    node = {"properties": {}}
    assert _in_line_range(node, [(10, 20)]) is True


# -- run_impact --------------------------------------------------------------


def test_run_impact_none_db(capsys):
    """Should no-op when db_path is None."""
    run_impact("src/main.py", None)
    assert capsys.readouterr().out == ""


def test_run_impact_db_open_fails(tmp_path, capsys):
    """Should silently no-op when the store can't be opened."""
    with patch("opentrace_agent.store.GraphStore", side_effect=RuntimeError("locked")):
        run_impact("src/main.py", str(tmp_path / "fake.db"))
    assert capsys.readouterr().out == ""


def test_run_impact_no_file_match(tmp_path, capsys):
    """Should produce no output when file is not in the graph."""
    mock_store = MagicMock()
    mock_store.search_nodes.return_value = []

    with patch("opentrace_agent.store.GraphStore", return_value=mock_store):
        run_impact("nonexistent.py", str(tmp_path / "fake.db"))

    assert capsys.readouterr().out == ""
    mock_store.close.assert_called_once()


def test_run_impact_with_symbols_and_callers(tmp_path, capsys):
    """Should show symbols and their callers."""
    file_node = {
        "id": "f1",
        "type": "File",
        "name": "api.py",
        "properties": {"path": "src/api.py"},
    }
    func_node = {
        "id": "fn1",
        "type": "Function",
        "name": "handle_request",
        "properties": {"start_line": 10, "end_line": 25},
    }
    defined_in_rel = {
        "id": "r1",
        "type": "DEFINED_IN",
        "source_id": "fn1",
        "target_id": "f1",
        "properties": {},
    }
    caller_node = {
        "id": "c1",
        "type": "Function",
        "name": "main",
        "properties": {"path": "src/main.py"},
    }
    calls_rel = {
        "id": "r2",
        "type": "CALLS",
        "source_id": "c1",
        "target_id": "fn1",
        "properties": {},
    }

    mock_store = MagicMock()
    mock_store.search_nodes.return_value = [file_node]
    # _get_neighbors returns Function defined in file
    mock_store._get_neighbors.return_value = [(func_node, defined_in_rel)]
    # traverse returns callers
    mock_store.traverse.return_value = [{"node": caller_node, "relationship": calls_rel, "depth": 1}]

    with patch("opentrace_agent.store.GraphStore", return_value=mock_store):
        run_impact("src/api.py", str(tmp_path / "fake.db"))

    out = capsys.readouterr().out
    assert "[OpenTrace] Impact analysis" in out
    assert "handle_request" in out
    assert "<--CALLS--" in out
    assert "main" in out
    assert "dependent(s) may be affected" in out
    mock_store.close.assert_called_once()


def test_run_impact_no_callers(tmp_path, capsys):
    """Should report no dependents when traverse returns empty."""
    file_node = {
        "id": "f1",
        "type": "File",
        "name": "utils.py",
        "properties": {"path": "src/utils.py"},
    }
    func_node = {
        "id": "fn1",
        "type": "Function",
        "name": "helper",
        "properties": {"start_line": 1, "end_line": 5},
    }
    defined_in_rel = {
        "id": "r1",
        "type": "DEFINED_IN",
        "source_id": "fn1",
        "target_id": "f1",
        "properties": {},
    }

    mock_store = MagicMock()
    mock_store.search_nodes.return_value = [file_node]
    mock_store._get_neighbors.return_value = [(func_node, defined_in_rel)]
    mock_store.traverse.return_value = []

    with patch("opentrace_agent.store.GraphStore", return_value=mock_store):
        run_impact("src/utils.py", str(tmp_path / "fake.db"))

    out = capsys.readouterr().out
    assert "No known dependents" in out
    mock_store.close.assert_called_once()


def test_run_impact_with_line_filter(tmp_path, capsys):
    """Should filter symbols by line range."""
    file_node = {
        "id": "f1",
        "type": "File",
        "name": "big.py",
        "properties": {"path": "src/big.py"},
    }
    func_in_range = {
        "id": "fn1",
        "type": "Function",
        "name": "targeted",
        "properties": {"start_line": 10, "end_line": 20},
    }
    func_out_of_range = {
        "id": "fn2",
        "type": "Function",
        "name": "untouched",
        "properties": {"start_line": 100, "end_line": 110},
    }
    rel1 = {"id": "r1", "type": "DEFINED_IN", "source_id": "fn1", "target_id": "f1", "properties": {}}
    rel2 = {"id": "r2", "type": "DEFINED_IN", "source_id": "fn2", "target_id": "f1", "properties": {}}

    mock_store = MagicMock()
    mock_store.search_nodes.return_value = [file_node]
    mock_store._get_neighbors.return_value = [
        (func_in_range, rel1),
        (func_out_of_range, rel2),
    ]
    mock_store.traverse.return_value = []

    with patch("opentrace_agent.store.GraphStore", return_value=mock_store):
        run_impact("src/big.py", str(tmp_path / "fake.db"), line_ranges=[(5, 15)])

    out = capsys.readouterr().out
    assert "targeted" in out
    assert "untouched" not in out
    mock_store.close.assert_called_once()
