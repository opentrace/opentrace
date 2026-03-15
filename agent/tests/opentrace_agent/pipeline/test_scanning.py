"""Tests for the scanning pipeline stage."""

from __future__ import annotations

import os
from pathlib import Path

from opentrace_agent.pipeline.scanning import scanning
from opentrace_agent.pipeline.types import (
    EventKind,
    Phase,
    PipelineContext,
    PipelineInput,
    ScanResult,
    StageResult,
)


def _make_project(tmp_path: Path) -> Path:
    """Create a small project with known structure."""
    (tmp_path / "main.py").write_text("def main():\n    pass\n")
    (tmp_path / "utils.py").write_text("def helper():\n    return 42\n")
    sub = tmp_path / "pkg"
    sub.mkdir()
    (sub / "mod.py").write_text("class Foo:\n    pass\n")
    (sub / "data.json").write_text("{}")
    return tmp_path


def test_scanning_produces_structural_nodes(tmp_path: Path) -> None:
    root = _make_project(tmp_path)
    inp = PipelineInput(path=str(root), repo_id="test/repo")
    ctx = PipelineContext()
    out: StageResult[ScanResult] = StageResult()

    events = list(scanning(inp, ctx, out))

    assert out.value is not None
    scan = out.value
    assert scan.repo_id == "test/repo"

    # Should have: 1 repo + 1 dir (pkg) + 4 files (main.py, utils.py, pkg/mod.py, pkg/data.json)
    node_types = {n.type for n in scan.structural_nodes}
    assert "Repository" in node_types
    assert "File" in node_types
    assert "Directory" in node_types

    # Check file entries are parseable files only (.py, not .json)
    parseable_paths = {fe.path for fe in scan.file_entries}
    assert "main.py" in parseable_paths
    assert "utils.py" in parseable_paths
    assert "pkg/mod.py" in parseable_paths
    # data.json is NOT parseable (no extractor for it)
    assert "pkg/data.json" not in parseable_paths


def test_scanning_builds_path_maps(tmp_path: Path) -> None:
    root = _make_project(tmp_path)
    inp = PipelineInput(path=str(root), repo_id="test/repo")
    ctx = PipelineContext()
    out: StageResult[ScanResult] = StageResult()

    list(scanning(inp, ctx, out))
    scan = out.value
    assert scan is not None

    assert "main.py" in scan.known_paths
    assert "utils.py" in scan.known_paths
    assert scan.path_to_file_id["main.py"] == "test/repo/main.py"


def test_scanning_events(tmp_path: Path) -> None:
    root = _make_project(tmp_path)
    inp = PipelineInput(path=str(root), repo_id="test/repo")
    ctx = PipelineContext()
    out: StageResult[ScanResult] = StageResult()

    events = list(scanning(inp, ctx, out))

    assert len(events) == 2  # STAGE_START + STAGE_STOP
    assert events[0].kind == EventKind.STAGE_START
    assert events[0].phase == Phase.SCANNING
    assert events[1].kind == EventKind.STAGE_STOP
    assert events[1].nodes is not None
    assert len(events[1].nodes) > 0


def test_scanning_cancellation(tmp_path: Path) -> None:
    root = _make_project(tmp_path)
    inp = PipelineInput(path=str(root), repo_id="test/repo")
    ctx = PipelineContext(cancelled=True)
    out: StageResult[ScanResult] = StageResult()

    events = list(scanning(inp, ctx, out))

    # Only STAGE_START then exits
    assert events[0].kind == EventKind.STAGE_START
    assert out.value is None


def test_scanning_no_path() -> None:
    inp = PipelineInput()
    ctx = PipelineContext()
    out: StageResult[ScanResult] = StageResult()

    events = list(scanning(inp, ctx, out))

    assert any(e.kind == EventKind.ERROR for e in events)
    assert out.value is None


def test_scanning_excludes_dirs(tmp_path: Path) -> None:
    """Excluded directories (node_modules, .git, etc.) are skipped."""
    (tmp_path / "main.py").write_text("x = 1\n")
    nm = tmp_path / "node_modules"
    nm.mkdir()
    (nm / "lib.py").write_text("y = 2\n")

    inp = PipelineInput(path=str(tmp_path), repo_id="test/repo")
    ctx = PipelineContext()
    out: StageResult[ScanResult] = StageResult()

    list(scanning(inp, ctx, out))
    scan = out.value
    assert scan is not None

    all_paths = {fe.path for fe in scan.file_entries}
    assert "main.py" in all_paths
    assert "node_modules/lib.py" not in all_paths
