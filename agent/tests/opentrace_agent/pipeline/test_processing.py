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

"""Tests for the processing pipeline stage."""

from __future__ import annotations

from pathlib import Path

from opentrace_agent.pipeline.processing import processing
from opentrace_agent.pipeline.types import (
    EventKind,
    FileEntry,
    PipelineContext,
    ProcessingOutput,
    ScanResult,
    StageResult,
)


def _make_scan_result(tmp_path: Path) -> ScanResult:
    """Create a ScanResult with real source files."""
    py_file = tmp_path / "app.py"
    py_file.write_text(
        "class Server:\n"
        "    def handle(self):\n"
        "        self.validate()\n"
        "\n"
        "    def validate(self):\n"
        "        pass\n"
        "\n"
        "def main():\n"
        "    s = Server()\n"
    )

    helper_file = tmp_path / "utils.py"
    helper_file.write_text("def helper():\n    return 42\n")

    repo_id = "test/repo"
    file_entries = [
        FileEntry(
            file_id=f"{repo_id}/app.py",
            abs_path=str(py_file),
            path="app.py",
            extension=".py",
            language="python",
        ),
        FileEntry(
            file_id=f"{repo_id}/utils.py",
            abs_path=str(helper_file),
            path="utils.py",
            extension=".py",
            language="python",
        ),
    ]

    path_to_file_id = {
        "app.py": f"{repo_id}/app.py",
        "utils.py": f"{repo_id}/utils.py",
    }

    return ScanResult(
        repo_id=repo_id,
        root_path=str(tmp_path),
        file_entries=file_entries,
        known_paths=set(path_to_file_id.keys()),
        path_to_file_id=path_to_file_id,
    )


def test_processing_extracts_symbols(tmp_path: Path) -> None:
    scan = _make_scan_result(tmp_path)
    ctx = PipelineContext()
    out: StageResult[ProcessingOutput] = StageResult()

    list(processing(scan, ctx, out))
    proc = out.value
    assert proc is not None

    assert proc.classes_extracted >= 1  # Server
    assert proc.functions_extracted >= 3  # handle, validate, main + helper
    assert proc.files_processed == 2


def test_processing_populates_registries(tmp_path: Path) -> None:
    scan = _make_scan_result(tmp_path)
    ctx = PipelineContext()
    out: StageResult[ProcessingOutput] = StageResult()

    list(processing(scan, ctx, out))
    proc = out.value
    assert proc is not None

    regs = proc.registries
    assert "Server" in regs.class_registry
    assert "main" in regs.name_registry
    assert "helper" in regs.name_registry


def test_processing_collects_calls(tmp_path: Path) -> None:
    scan = _make_scan_result(tmp_path)
    ctx = PipelineContext()
    out: StageResult[ProcessingOutput] = StageResult()

    list(processing(scan, ctx, out))
    proc = out.value
    assert proc is not None

    # handle() calls self.validate() → should be in call_infos
    assert len(proc.call_infos) > 0
    caller_names = {ci.caller_name for ci in proc.call_infos}
    assert "handle" in caller_names


def test_processing_emits_nodes_in_events(tmp_path: Path) -> None:
    scan = _make_scan_result(tmp_path)
    ctx = PipelineContext()
    out: StageResult[ProcessingOutput] = StageResult()

    events = list(processing(scan, ctx, out))

    # Should have STAGE_START + per-file STAGE_PROGRESS + STAGE_STOP
    kinds = [e.kind for e in events]
    assert kinds[0] == EventKind.STAGE_START
    assert kinds[-1] == EventKind.STAGE_STOP
    assert EventKind.STAGE_PROGRESS in kinds

    # Progress events carry nodes
    progress_events = [e for e in events if e.kind == EventKind.STAGE_PROGRESS]
    all_nodes = []
    for pe in progress_events:
        if pe.nodes:
            all_nodes.extend(pe.nodes)

    node_types = {n.type for n in all_nodes}
    assert "Class" in node_types
    assert "Function" in node_types


def test_processing_handles_unreadable_file(tmp_path: Path) -> None:
    """Files that can't be read produce errors but don't crash."""
    scan = ScanResult(
        repo_id="test/repo",
        root_path=str(tmp_path),
        file_entries=[
            FileEntry(
                file_id="test/repo/missing.py",
                abs_path=str(tmp_path / "nonexistent.py"),
                path="missing.py",
                extension=".py",
                language="python",
            ),
        ],
        known_paths={"missing.py"},
        path_to_file_id={"missing.py": "test/repo/missing.py"},
    )
    ctx = PipelineContext()
    out: StageResult[ProcessingOutput] = StageResult()

    list(processing(scan, ctx, out))
    proc = out.value
    assert proc is not None
    assert len(proc.errors) == 1
    assert proc.files_processed == 0


def test_processing_extracts_variables(tmp_path: Path) -> None:
    """Variable nodes are emitted for parameters and locals."""
    scan = _make_scan_result(tmp_path)
    ctx = PipelineContext()
    out: StageResult[ProcessingOutput] = StageResult()

    events = list(processing(scan, ctx, out))
    proc = out.value
    assert proc is not None

    assert proc.variables_extracted > 0

    # Variable nodes should appear in progress events
    all_nodes = []
    for e in events:
        if e.nodes:
            all_nodes.extend(e.nodes)
    var_nodes = [n for n in all_nodes if n.type == "Variable"]
    assert len(var_nodes) > 0


def test_processing_populates_variable_registry(tmp_path: Path) -> None:
    """Variable registry is populated during processing."""
    scan = _make_scan_result(tmp_path)
    ctx = PipelineContext()
    out: StageResult[ProcessingOutput] = StageResult()

    list(processing(scan, ctx, out))
    proc = out.value
    assert proc is not None

    # At least some scopes should have variables registered
    assert len(proc.registries.variable_registry) > 0


def test_processing_collects_derivation_infos(tmp_path: Path) -> None:
    """Derivation infos are collected for variables with derivations."""
    scan = _make_scan_result(tmp_path)
    ctx = PipelineContext()
    out: StageResult[ProcessingOutput] = StageResult()

    list(processing(scan, ctx, out))
    proc = out.value
    assert proc is not None

    # main() has `s = Server()` which should produce a derivation
    assert len(proc.derivation_infos) > 0


def test_processing_go_file(tmp_path: Path) -> None:
    """Go files are processed correctly."""
    go_file = tmp_path / "main.go"
    go_file.write_text('package main\n\nfunc main() {\n    fmt.Println("hello")\n}\n')

    scan = ScanResult(
        repo_id="test/repo",
        root_path=str(tmp_path),
        file_entries=[
            FileEntry(
                file_id="test/repo/main.go",
                abs_path=str(go_file),
                path="main.go",
                extension=".go",
                language="go",
            ),
        ],
        known_paths={"main.go"},
        path_to_file_id={"main.go": "test/repo/main.go"},
    )
    ctx = PipelineContext()
    out: StageResult[ProcessingOutput] = StageResult()

    list(processing(scan, ctx, out))
    proc = out.value
    assert proc is not None
    assert proc.functions_extracted >= 1
