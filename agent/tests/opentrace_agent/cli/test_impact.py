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

import json
from unittest.mock import MagicMock, patch

import click
import pytest

from opentrace_agent.cli.impact import (
    _find_defined_symbols,
    _in_line_range,
    _resolve_file_node,
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
    mock_store.list_nodes.return_value = []
    mock_store.search_nodes.return_value = []
    mock_store.get_metadata.return_value = []

    with patch("opentrace_agent.store.GraphStore", return_value=mock_store):
        run_impact("nonexistent.py", str(tmp_path / "fake.db"))

    assert capsys.readouterr().out == ""
    mock_store.close.assert_called_once()


def test_run_impact_with_symbols_and_callers(tmp_path, capsys):
    """Should show symbols and their callers via File -DEFINES-> Symbol."""
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
    defines_rel = {
        "id": "r1",
        "type": "DEFINES",
        "source_id": "f1",
        "target_id": "fn1",
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
    mock_store.list_nodes.return_value = [file_node]
    mock_store.get_metadata.return_value = []
    # _get_neighbors returns Function via DEFINES (outgoing from file)
    mock_store._get_neighbors.return_value = [(func_node, defines_rel)]
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
    # _get_neighbors must be called with "outgoing", not "incoming"
    mock_store._get_neighbors.assert_called_with("f1", "outgoing")
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
    defines_rel = {
        "id": "r1",
        "type": "DEFINES",
        "source_id": "f1",
        "target_id": "fn1",
        "properties": {},
    }

    mock_store = MagicMock()
    mock_store.list_nodes.return_value = [file_node]
    mock_store.get_metadata.return_value = []
    mock_store._get_neighbors.return_value = [(func_node, defines_rel)]
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
    rel1 = {"id": "r1", "type": "DEFINES", "source_id": "f1", "target_id": "fn1", "properties": {}}
    rel2 = {"id": "r2", "type": "DEFINES", "source_id": "f1", "target_id": "fn2", "properties": {}}

    mock_store = MagicMock()
    mock_store.list_nodes.return_value = [file_node]
    mock_store.get_metadata.return_value = []
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


# -- _resolve_file_node (C2) -------------------------------------------------


class TestResolveFileNode:
    def _file(self, path: str, id_: str = "f") -> dict:
        return {"id": id_, "type": "File", "name": path.rsplit("/", 1)[-1], "properties": {"path": path}}

    def test_exact_relative_match(self) -> None:
        target = self._file("src/api.py")
        store = MagicMock()
        store.list_nodes.return_value = [target]
        assert _resolve_file_node(store, "src/api.py") is target
        # Fetch one row beyond the message cap so we can detect when
        # there are more conflicts than we'll display.
        store.list_nodes.assert_called_with(
            "File", filters={"path": "src/api.py"}, limit=11
        )

    def test_absolute_path_stripped_via_metadata(self) -> None:
        target = self._file("src/api.py")
        store = MagicMock()
        store.get_metadata.return_value = [{"repoPath": "/home/user/repo"}]
        # Exact match succeeds for the relative-stripped form only.
        store.list_nodes.side_effect = [
            [target],  # first call with "src/api.py"
        ]
        result = _resolve_file_node(store, "/home/user/repo/src/api.py")
        assert result is target

    def test_basename_fallback_unique(self) -> None:
        target = self._file("packages/ui/src/Button.tsx")
        store = MagicMock()
        store.list_nodes.return_value = []  # no exact match
        store.search_nodes.return_value = [target]
        assert _resolve_file_node(store, "Button.tsx") is target

    def test_basename_fallback_filters_to_endswith(self) -> None:
        real = self._file("packages/ui/src/Button.tsx", id_="real")
        noise = {"id": "noise", "type": "File", "name": "Button.tsx", "properties": {"path": "irrelevant/Buttonish.tsx"}}
        store = MagicMock()
        store.list_nodes.return_value = []
        store.search_nodes.return_value = [noise, real]
        # Only `real` ends in "/Button.tsx"; noise is filtered out.
        assert _resolve_file_node(store, "Button.tsx") is real

    def test_ambiguous_exact_match_raises(self) -> None:
        # Same relative path indexed in two different repos: the path
        # alone can't disambiguate them, so the error must surface the
        # node IDs (which include the repo prefix) so users can tell
        # the duplicates apart.
        a = self._file("src/api.py", id_="repo-a/src/api.py")
        b = self._file("src/api.py", id_="repo-b/src/api.py")
        store = MagicMock()
        store.list_nodes.return_value = [a, b]
        with pytest.raises(click.ClickException) as excinfo:
            _resolve_file_node(store, "src/api.py")
        msg = str(excinfo.value.message)
        assert "Ambiguous" in msg
        # Node IDs must appear in the message — otherwise two identical
        # paths would render indistinguishably.
        assert "repo-a/src/api.py" in msg
        assert "repo-b/src/api.py" in msg
        # No graph-internal jargon in the user-facing message.
        assert "File nodes" not in msg

    def test_ambiguous_exact_match_truncates_long_conflict_list(self) -> None:
        # When more files share the same relative path than the message
        # is willing to print, the IDs in the message must be capped at
        # _MAX_AMBIGUOUS_CANDIDATES (= 10) — same shape as the basename
        # branch — so a 50-repo monorepo doesn't dump a useless wall of
        # text into the user's terminal.
        from opentrace_agent.cli.impact import _MAX_AMBIGUOUS_CANDIDATES

        conflicts = [
            self._file("src/api.py", id_=f"repo-{i:02d}/src/api.py")
            for i in range(_MAX_AMBIGUOUS_CANDIDATES + 5)
        ]
        store = MagicMock()
        store.list_nodes.return_value = conflicts

        with pytest.raises(click.ClickException) as excinfo:
            _resolve_file_node(store, "src/api.py")
        msg = str(excinfo.value.message)

        # Only the first _MAX_AMBIGUOUS_CANDIDATES IDs (sorted) appear.
        assert "repo-00/src/api.py" in msg
        assert f"repo-{_MAX_AMBIGUOUS_CANDIDATES - 1:02d}/src/api.py" in msg
        # IDs beyond the cap must not be in the message.
        assert f"repo-{_MAX_AMBIGUOUS_CANDIDATES:02d}/src/api.py" not in msg
        assert f"repo-{_MAX_AMBIGUOUS_CANDIDATES + 4:02d}/src/api.py" not in msg

    def test_ambiguous_basename_raises(self) -> None:
        a = self._file("pkg/a/utils.py", id_="proj/pkg/a/utils.py")
        b = self._file("pkg/b/utils.py", id_="proj/pkg/b/utils.py")
        store = MagicMock()
        store.list_nodes.return_value = []
        store.search_nodes.return_value = [a, b]
        with pytest.raises(click.ClickException) as excinfo:
            _resolve_file_node(store, "utils.py")
        msg = str(excinfo.value.message)
        assert "Ambiguous" in msg
        assert "utils.py" in msg
        assert "proj/pkg/a/utils.py" in msg
        assert "proj/pkg/b/utils.py" in msg
        assert "File nodes" not in msg

    def test_no_match_returns_none(self) -> None:
        store = MagicMock()
        store.list_nodes.return_value = []
        store.search_nodes.return_value = []
        assert _resolve_file_node(store, "does/not/exist.py") is None


# -- _find_defined_symbols direction (C1) ------------------------------------


class TestFindDefinedSymbols:
    def test_walks_outgoing_from_file(self) -> None:
        """C1 regression: must walk outgoing (File -DEFINES-> Symbol), not incoming."""
        file_node = {"id": "f1", "type": "File", "name": "x.py", "properties": {"path": "src/x.py"}}
        func = {"id": "fn1", "type": "Function", "name": "f", "properties": {}}
        defines = {"id": "r", "type": "DEFINES", "source_id": "f1", "target_id": "fn1", "properties": {}}
        store = MagicMock()
        store._get_neighbors.return_value = [(func, defines)]

        symbols = _find_defined_symbols(store, file_node, None)
        assert symbols == [func]
        store._get_neighbors.assert_called_once_with("f1", "outgoing")

    def test_filters_non_symbol_neighbors(self) -> None:
        file_node = {"id": "f1", "type": "File", "name": "x.py", "properties": {}}
        # Directory neighbors should not count as symbols.
        directory = {"id": "d1", "type": "Directory", "name": "src", "properties": {}}
        func = {"id": "fn1", "type": "Function", "name": "f", "properties": {}}
        store = MagicMock()
        store._get_neighbors.return_value = [
            (directory, {"type": "CONTAINS"}),
            (func, {"type": "DEFINES"}),
        ]
        symbols = _find_defined_symbols(store, file_node, None)
        assert symbols == [func]

    def test_ignores_non_defines_edges_to_symbol_nodes(self) -> None:
        """Defensive: a hypothetical future edge type targeting a
        Function/Class node (say, File -REFERENCES-> Function) must not
        leak into the 'symbols defined in this file' set. The filter
        gates on rel.type == 'DEFINES', not just on the target node
        type, so such an addition would need explicit opt-in rather
        than silently inflating impact reports.
        """
        file_node = {"id": "f1", "type": "File", "name": "x.py", "properties": {}}
        referenced_func = {"id": "fn_ref", "type": "Function", "name": "elsewhere", "properties": {}}
        defined_func = {"id": "fn_def", "type": "Function", "name": "here", "properties": {}}
        store = MagicMock()
        store._get_neighbors.return_value = [
            (referenced_func, {"type": "REFERENCES"}),
            (defined_func, {"type": "DEFINES"}),
        ]
        symbols = _find_defined_symbols(store, file_node, None)
        assert symbols == [defined_func]


# -- JSON output (C2: requestedFile) -----------------------------------------


class TestJsonOutput:
    def test_json_includes_requested_file(self, tmp_path, capsys) -> None:
        file_node = {"id": "f1", "type": "File", "name": "api.py", "properties": {"path": "src/api.py"}}
        func = {"id": "fn1", "type": "Function", "name": "handle", "properties": {"start_line": 10, "end_line": 20}}
        defines = {"id": "r", "type": "DEFINES", "source_id": "f1", "target_id": "fn1", "properties": {}}
        caller = {"id": "c1", "type": "Function", "name": "main", "properties": {"path": "src/main.py"}}
        calls = {"id": "r2", "type": "CALLS", "source_id": "c1", "target_id": "fn1", "properties": {}}

        store = MagicMock()
        store.list_nodes.return_value = [file_node]
        store.get_metadata.return_value = []
        store._get_neighbors.return_value = [(func, defines)]
        store.traverse.return_value = [{"node": caller, "relationship": calls, "depth": 1}]

        with patch("opentrace_agent.store.GraphStore", return_value=store):
            run_impact("src/api.py", str(tmp_path / "fake.db"), output_json=True)

        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["requestedFile"] == "src/api.py"
        assert data["file"] == "src/api.py"
        assert data["total_dependents"] == 1
        assert data["symbols"][0]["name"] == "handle"
        assert data["symbols"][0]["dependents"][0]["name"] == "main"

    def test_json_requested_file_preserved_on_no_match(self, tmp_path, capsys) -> None:
        """When the file can't be resolved, still echo the input as requestedFile."""
        store = MagicMock()
        store.list_nodes.return_value = []
        store.search_nodes.return_value = []
        store.get_metadata.return_value = []

        with patch("opentrace_agent.store.GraphStore", return_value=store):
            run_impact("never/indexed.py", str(tmp_path / "fake.db"), output_json=True)

        data = json.loads(capsys.readouterr().out.strip())
        assert data == {
            "requestedFile": "never/indexed.py",
            "file": None,
            "symbols": [],
            "total_dependents": 0,
        }

    def test_json_requested_file_differs_from_resolved_on_absolute_input(
        self, tmp_path, capsys
    ) -> None:
        """Absolute input resolves to a repo-relative stored path; both surfaced."""
        file_node = {"id": "f1", "type": "File", "name": "a.py", "properties": {"path": "src/a.py"}}
        store = MagicMock()
        store.get_metadata.return_value = [{"repoPath": "/repo"}]
        # First list_nodes call is for the stripped relative path.
        store.list_nodes.return_value = [file_node]
        store._get_neighbors.return_value = []

        with patch("opentrace_agent.store.GraphStore", return_value=store):
            run_impact("/repo/src/a.py", str(tmp_path / "fake.db"), output_json=True)

        data = json.loads(capsys.readouterr().out.strip())
        assert data["requestedFile"] == "/repo/src/a.py"
        assert data["file"] == "src/a.py"


# -- ClickException propagation ---------------------------------------------


def test_ambiguity_click_exception_propagates(tmp_path) -> None:
    """User-input errors must escape the generic best-effort handler."""
    a = {"id": "a", "type": "File", "name": "utils.py", "properties": {"path": "pkg/a/utils.py"}}
    b = {"id": "b", "type": "File", "name": "utils.py", "properties": {"path": "pkg/b/utils.py"}}
    store = MagicMock()
    store.list_nodes.return_value = []
    store.search_nodes.return_value = [a, b]
    store.get_metadata.return_value = []

    with patch("opentrace_agent.store.GraphStore", return_value=store):
        with pytest.raises(click.ClickException) as excinfo:
            run_impact("utils.py", str(tmp_path / "fake.db"))
    assert "Ambiguous" in str(excinfo.value.message)
    store.close.assert_called_once()
