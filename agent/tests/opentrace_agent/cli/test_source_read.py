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

"""Tests for ``opentrace source-read`` CLI surface."""

from __future__ import annotations

from pathlib import Path

import click
import pytest
from click.testing import CliRunner

from opentrace_agent.cli.main import _parse_source_read_line_spec, app


class TestParseLineSpec:
    def test_empty_returns_none_pair(self) -> None:
        assert _parse_source_read_line_spec("") == (None, None)

    def test_single_number_is_single_line(self) -> None:
        assert _parse_source_read_line_spec("10") == (10, 10)

    def test_closed_range(self) -> None:
        assert _parse_source_read_line_spec("10-25") == (10, 25)

    def test_open_ended_range(self) -> None:
        # The key new case: "10-" means "from 10 to end of file".
        # Downstream _print_file_slice treats end_line=None as EOF.
        assert _parse_source_read_line_spec("10-") == (10, None)

    def test_open_ended_boundary_line_one(self) -> None:
        assert _parse_source_read_line_spec("1-") == (1, None)

    def test_non_numeric_start_raises(self) -> None:
        with pytest.raises(click.BadParameter):
            _parse_source_read_line_spec("abc")

    def test_non_numeric_end_raises(self) -> None:
        with pytest.raises(click.BadParameter):
            _parse_source_read_line_spec("10-xyz")

    def test_invalid_format_in_message(self) -> None:
        with pytest.raises(click.BadParameter) as excinfo:
            _parse_source_read_line_spec("not-a-range")
        # Useful error hint for the caller.
        assert "N-M" in str(excinfo.value)

    def test_zero_start_rejected(self) -> None:
        # Lines are 1-indexed; zero is never valid.
        with pytest.raises(click.BadParameter) as excinfo:
            _parse_source_read_line_spec("0")
        assert "start must be >= 1" in str(excinfo.value)

    def test_negative_start_rejected(self) -> None:
        # "-5" splits to ["", "5"]; start is "" → non-integer.
        with pytest.raises(click.BadParameter) as excinfo:
            _parse_source_read_line_spec("-5")
        assert "start is not an integer" in str(excinfo.value)

    def test_negative_end_rejected(self) -> None:
        # "10--5" splits to ["10", "-5"]; int parses, value then rejected.
        with pytest.raises(click.BadParameter) as excinfo:
            _parse_source_read_line_spec("10--5")
        assert "end must be >= 1" in str(excinfo.value)

    def test_reversed_range_rejected(self) -> None:
        # end < start is almost certainly a caller mistake, not intent.
        with pytest.raises(click.BadParameter) as excinfo:
            _parse_source_read_line_spec("10-5")
        assert "end (5) must be >= start (10)" in str(excinfo.value)

    def test_start_equals_end_accepted(self) -> None:
        # Boundary: a single-line closed range should pass.
        assert _parse_source_read_line_spec("10-10") == (10, 10)


class TestSourceReadLinesFlag:
    """Integration smoke tests via Click's CliRunner over a scratch file.

    These exercise the command end-to-end for --path + --lines combinations
    without needing a real indexed DB — `_resolve_db(must_exist=True)` is
    mocked by pointing at an existing (empty but real) DB file.
    """

    def _write_sample(self, path: Path) -> None:
        path.write_text("\n".join(f"line {i}" for i in range(1, 11)))

    def test_closed_range_slices_correctly(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        sample = tmp_path / "sample.py"
        self._write_sample(sample)

        # Bypass the DB resolution step by stubbing _read_source_by_path
        # to read directly from the absolute path we pass.
        from opentrace_agent.cli import main as cli_main

        captured: dict[str, object] = {}

        def fake_resolve_db(*_args, **_kwargs):
            return str(tmp_path / "fake.db")

        def fake_graphstore(*_args, **_kwargs):
            class _S:
                def close(self_inner): ...

            return _S()

        def fake_read_source_by_path(_store, file_path, start_line, end_line):
            captured["file_path"] = file_path
            captured["start_line"] = start_line
            captured["end_line"] = end_line

        monkeypatch.setattr(cli_main, "_resolve_db", fake_resolve_db)
        monkeypatch.setattr(cli_main, "_read_source_by_path", fake_read_source_by_path)
        # GraphStore gets imported inside source_read; patch the module-level
        # symbol on the store package.
        import opentrace_agent.store as store_mod

        monkeypatch.setattr(store_mod, "GraphStore", fake_graphstore)

        runner = CliRunner()
        result = runner.invoke(app, ["source-read", "--path", str(sample), "--lines", "3-5"])
        assert result.exit_code == 0, result.output
        assert captured == {"file_path": str(sample), "start_line": 3, "end_line": 5}

    def test_open_ended_range_passes_none_end(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        sample = tmp_path / "sample.py"
        self._write_sample(sample)

        from opentrace_agent.cli import main as cli_main

        captured: dict[str, object] = {}

        def fake_resolve_db(*_args, **_kwargs):
            return str(tmp_path / "fake.db")

        def fake_graphstore(*_args, **_kwargs):
            class _S:
                def close(self_inner): ...

            return _S()

        def fake_read_source_by_path(_store, file_path, start_line, end_line):
            captured["start_line"] = start_line
            captured["end_line"] = end_line

        monkeypatch.setattr(cli_main, "_resolve_db", fake_resolve_db)
        monkeypatch.setattr(cli_main, "_read_source_by_path", fake_read_source_by_path)
        import opentrace_agent.store as store_mod

        monkeypatch.setattr(store_mod, "GraphStore", fake_graphstore)

        runner = CliRunner()
        result = runner.invoke(app, ["source-read", "--path", str(sample), "--lines", "5-"])
        assert result.exit_code == 0, result.output
        assert captured == {"start_line": 5, "end_line": None}

    def test_open_ended_range_against_trailing_newline_file(self, tmp_path: Path) -> None:
        """An open-ended range against a file that ends in ``\\n`` must
        not emit a phantom trailing blank line, and the header must
        reflect the real last line number rather than ``len(lines)``."""
        from opentrace_agent.cli.main import _print_file_slice

        sample = tmp_path / "with_trailing_nl.py"
        # 10 real lines, written with a trailing newline.
        sample.write_text("\n".join(f"line {i}" for i in range(1, 11)) + "\n")

        runner = CliRunner()

        @click.command()
        def _drive():
            _print_file_slice(str(sample), start_line=5, end_line=None)

        result = runner.invoke(_drive)
        assert result.exit_code == 0, result.output

        # Header reports 5-10 (the real last line), not 5-11.
        assert f"// {sample}:5-10" in result.output

        # Body covers exactly 6 lines (5..10 inclusive). No phantom
        # trailing blank "11\t" row.
        body_lines = [line for line in result.output.splitlines() if line and line[0].isdigit()]
        numbers = [int(line.split("\t", 1)[0]) for line in body_lines]
        assert numbers == [5, 6, 7, 8, 9, 10]

    def test_bad_lines_spec_reports_clearly(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        from opentrace_agent.cli import main as cli_main

        def fake_resolve_db(*_args, **_kwargs):
            return str(tmp_path / "fake.db")

        def fake_graphstore(*_args, **_kwargs):
            class _S:
                def close(self_inner): ...

            return _S()

        monkeypatch.setattr(cli_main, "_resolve_db", fake_resolve_db)
        import opentrace_agent.store as store_mod

        monkeypatch.setattr(store_mod, "GraphStore", fake_graphstore)

        runner = CliRunner()
        result = runner.invoke(app, ["source-read", "--path", "whatever.py", "--lines", "garbage"])
        assert result.exit_code != 0
        assert "invalid --lines value" in result.output or "invalid --lines value" in (result.stderr or "")


class TestReadSourceByNodeRepoStripping:
    """Path extraction in ``_read_source_by_node`` must respect multi-segment repo IDs.

    The fallback "extract from node ID" branch fires when neither
    ``properties.path`` nor any outgoing DEFINES File neighbor yields
    a path. The node ID format is ``<repo>/<rel>::<symbol>`` and
    ``<repo>`` itself can contain ``/`` (``owner/repo`` style), so the
    repo portion is matched against the indexed repo IDs rather than
    truncated at the first slash.
    """

    def test_owner_repo_id_strips_full_prefix(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from opentrace_agent.cli.main import _read_source_by_node

        captured: dict[str, object] = {}

        class FakeStore:
            def get_node(self_inner, node_id):
                # No direct path on the symbol node; force the fallback branch.
                return {"id": node_id, "type": "Function", "name": "parse_widget", "properties": {}}

            def _get_neighbors(self_inner, _id, _direction):
                # No outgoing File neighbor either, so the branch must
                # derive the path from the node ID itself.
                return []

            def list_repository_ids(self_inner):
                return ["acme/widget"]

        def fake_read_source_by_path(_store, file_path, start_line, end_line):
            captured["file_path"] = file_path
            captured["start_line"] = start_line
            captured["end_line"] = end_line

        from opentrace_agent.cli import main as cli_main

        monkeypatch.setattr(cli_main, "_read_source_by_path", fake_read_source_by_path)

        _read_source_by_node(FakeStore(), "acme/widget/src/parser.py::parse_widget")

        assert captured["file_path"] == "src/parser.py"

    def test_single_segment_repo_id_still_works(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Single-segment repo IDs (``repo/...``) keep producing the same remainder."""
        from opentrace_agent.cli.main import _read_source_by_node

        captured: dict[str, object] = {}

        class FakeStore:
            def get_node(self_inner, node_id):
                return {"id": node_id, "type": "Function", "name": "f", "properties": {}}

            def _get_neighbors(self_inner, _id, _direction):
                return []

            def list_repository_ids(self_inner):
                return ["repo"]

        def fake_read_source_by_path(_store, file_path, start_line, end_line):
            captured["file_path"] = file_path

        from opentrace_agent.cli import main as cli_main

        monkeypatch.setattr(cli_main, "_read_source_by_path", fake_read_source_by_path)

        _read_source_by_node(FakeStore(), "repo/src/x.py::f")

        assert captured["file_path"] == "src/x.py"

    def test_unknown_repo_raises_no_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A node ID under no indexed repo and with no slash → ClickException."""
        from opentrace_agent.cli.main import _read_source_by_node

        class FakeStore:
            def get_node(self_inner, node_id):
                return {"id": node_id, "type": "Function", "name": "f", "properties": {}}

            def _get_neighbors(self_inner, _id, _direction):
                return []

            def list_repository_ids(self_inner):
                return ["other"]

        with pytest.raises(click.ClickException) as excinfo:
            _read_source_by_node(FakeStore(), "bare::Symbol")
        assert "no file path" in str(excinfo.value.message).lower()
