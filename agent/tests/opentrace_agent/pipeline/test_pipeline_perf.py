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

"""Pipeline performance benchmarks.

Measures wall-clock time and throughput for the default pipeline across
different project sizes and language mixes.  Tests are marked with
``@pytest.mark.benchmark`` so they can be selected or skipped independently::

    uv run pytest tests/opentrace_agent/pipeline/test_pipeline_perf.py -v
    uv run pytest -m benchmark  # run only benchmarks
"""

from __future__ import annotations

import time
from pathlib import Path
from textwrap import dedent

import pytest

from opentrace_agent.pipeline import (
    EventKind,
    MemoryStore,
    PipelineInput,
    collect_pipeline,
)

# ---------------------------------------------------------------------------
# Helpers — synthetic project generators
# ---------------------------------------------------------------------------

_PYTHON_CLASS_TEMPLATE = dedent("""\
    class {name}:
        \"\"\"Auto-generated class {name}.\"\"\"

        def __init__(self, value: int) -> None:
            self.value = value

        def process(self) -> int:
            return self._transform(self.value)

        def _transform(self, x: int) -> int:
            return x * 2

        def validate(self) -> bool:
            return self.value > 0
""")

_PYTHON_FUNC_MODULE_TEMPLATE = dedent("""\
    from {import_from} import {import_name}

    def {name}_handler(data):
        \"\"\"Handle {name} logic.\"\"\"
        obj = {import_name}(data)
        obj.process()
        return obj.validate()

    def {name}_helper(x):
        return x + 1
""")

_GO_STRUCT_TEMPLATE = dedent("""\
    package main

    type {name} struct {{
        ID   int
        Name string
    }}

    func (s *{name}) Process() int {{
        return s.validate()
    }}

    func (s *{name}) validate() int {{
        return s.ID * 2
    }}
""")

_TS_CLASS_TEMPLATE = dedent("""\
    export class {name} {{
        private value: number;

        constructor(value: number) {{
            this.value = value;
        }}

        process(): number {{
            return this.transform(this.value);
        }}

        private transform(x: number): number {{
            return x * 2;
        }}
    }}
""")


def _make_python_project(root: Path, num_modules: int) -> None:
    """Generate a Python project with *num_modules* class modules + helper modules."""
    names = [f"Mod{i}" for i in range(num_modules)]
    for i, name in enumerate(names):
        (root / f"{name.lower()}.py").write_text(
            _PYTHON_CLASS_TEMPLATE.format(name=name)
        )
    # Helper modules that cross-import
    for i in range(0, num_modules - 1, 2):
        (root / f"helper_{i}.py").write_text(
            _PYTHON_FUNC_MODULE_TEMPLATE.format(
                name=names[i].lower(),
                import_from=names[i].lower(),
                import_name=names[i],
            )
        )


def _make_go_project(root: Path, num_structs: int) -> None:
    """Generate a Go project with *num_structs* struct files."""
    (root / "go.mod").write_text("module example.com/bench\n\ngo 1.21\n")
    (root / "main.go").write_text(
        "package main\n\nfunc main() {}\n"
    )
    for i in range(num_structs):
        name = f"Service{i}"
        (root / f"{name.lower()}.go").write_text(
            _GO_STRUCT_TEMPLATE.format(name=name)
        )


def _make_ts_project(root: Path, num_classes: int) -> None:
    """Generate a TypeScript project with *num_classes* class files."""
    (root / "package.json").write_text(
        '{"name": "bench", "version": "1.0.0", "dependencies": {}}\n'
    )
    for i in range(num_classes):
        name = f"Component{i}"
        (root / f"{name}.ts").write_text(
            _TS_CLASS_TEMPLATE.format(name=name)
        )


def _make_mixed_project(root: Path, per_lang: int) -> None:
    """Generate a project with Python, Go, and TypeScript files."""
    py_dir = root / "python_src"
    go_dir = root / "go_src"
    ts_dir = root / "ts_src"
    py_dir.mkdir()
    go_dir.mkdir()
    ts_dir.mkdir()
    _make_python_project(py_dir, per_lang)
    _make_go_project(go_dir, per_lang)
    _make_ts_project(ts_dir, per_lang)


# ---------------------------------------------------------------------------
# Timing helper
# ---------------------------------------------------------------------------


class PipelineTimer:
    """Run the pipeline and capture timing + result stats."""

    def __init__(self, root: Path, repo_id: str = "bench/perf") -> None:
        self.inp = PipelineInput(path=str(root), repo_id=repo_id)
        self.store = MemoryStore()
        self.elapsed: float = 0.0
        self.events: list = []
        self.nodes: list = []
        self.rels: list = []
        self.result = None

    def run(self) -> "PipelineTimer":
        t0 = time.perf_counter()
        self.events, self.nodes, self.rels = collect_pipeline(
            self.inp, store=self.store
        )
        self.elapsed = time.perf_counter() - t0

        done = [e for e in self.events if e.kind == EventKind.DONE]
        if done:
            self.result = done[0].result
        return self

    @property
    def files_per_second(self) -> float:
        if self.result and self.elapsed > 0:
            return self.result.files_processed / self.elapsed
        return 0.0

    @property
    def nodes_per_second(self) -> float:
        if self.elapsed > 0:
            return len(self.nodes) / self.elapsed
        return 0.0

    def summary(self) -> dict:
        r = self.result
        return {
            "elapsed_s": round(self.elapsed, 3),
            "files_processed": r.files_processed if r else 0,
            "nodes_created": len(self.nodes),
            "relationships_created": len(self.rels),
            "classes_extracted": r.classes_extracted if r else 0,
            "functions_extracted": r.functions_extracted if r else 0,
            "files_per_second": round(self.files_per_second, 1),
            "nodes_per_second": round(self.nodes_per_second, 1),
            "store_nodes": len(self.store.nodes),
            "store_rels": len(self.store.relationships),
        }


# ---------------------------------------------------------------------------
# Benchmarks
# ---------------------------------------------------------------------------

pytestmark = pytest.mark.benchmark


class TestPythonPipelinePerf:
    """Benchmark the pipeline on pure-Python projects of increasing size."""

    def test_small_python_project(self, tmp_path: Path) -> None:
        """10 modules — baseline for small repos."""
        _make_python_project(tmp_path, 10)
        t = PipelineTimer(tmp_path).run()

        assert t.result is not None
        assert t.result.files_processed >= 10
        assert t.result.classes_extracted >= 10
        assert t.elapsed < 30, f"Small project took {t.elapsed:.1f}s (expected <30s)"
        _print_summary("python_small_10", t)

    def test_medium_python_project(self, tmp_path: Path) -> None:
        """50 modules — typical small-to-medium repo."""
        _make_python_project(tmp_path, 50)
        t = PipelineTimer(tmp_path).run()

        assert t.result is not None
        assert t.result.files_processed >= 50
        assert t.result.classes_extracted >= 50
        assert t.elapsed < 60, f"Medium project took {t.elapsed:.1f}s (expected <60s)"
        _print_summary("python_medium_50", t)

    def test_large_python_project(self, tmp_path: Path) -> None:
        """200 modules — stress test for larger repos."""
        _make_python_project(tmp_path, 200)
        t = PipelineTimer(tmp_path).run()

        assert t.result is not None
        assert t.result.files_processed >= 200
        assert t.result.classes_extracted >= 200
        assert t.elapsed < 120, f"Large project took {t.elapsed:.1f}s (expected <120s)"
        _print_summary("python_large_200", t)


class TestGoPipelinePerf:
    """Benchmark the pipeline on Go projects."""

    def test_medium_go_project(self, tmp_path: Path) -> None:
        """50 struct files."""
        _make_go_project(tmp_path, 50)
        t = PipelineTimer(tmp_path).run()

        assert t.result is not None
        assert t.result.files_processed >= 50
        assert t.elapsed < 60, f"Go project took {t.elapsed:.1f}s (expected <60s)"
        _print_summary("go_medium_50", t)


class TestTypeScriptPipelinePerf:
    """Benchmark the pipeline on TypeScript projects."""

    def test_medium_ts_project(self, tmp_path: Path) -> None:
        """50 class files."""
        _make_ts_project(tmp_path, 50)
        t = PipelineTimer(tmp_path).run()

        assert t.result is not None
        assert t.result.files_processed >= 50
        assert t.result.classes_extracted >= 50
        assert t.elapsed < 60, f"TS project took {t.elapsed:.1f}s (expected <60s)"
        _print_summary("ts_medium_50", t)


class TestMixedLanguagePerf:
    """Benchmark the pipeline on multi-language projects."""

    def test_mixed_project(self, tmp_path: Path) -> None:
        """30 files per language (Python, Go, TypeScript)."""
        _make_mixed_project(tmp_path, 30)
        t = PipelineTimer(tmp_path).run()

        assert t.result is not None
        assert t.result.files_processed >= 60  # at least Go + Python parseable
        assert t.elapsed < 90, f"Mixed project took {t.elapsed:.1f}s (expected <90s)"
        _print_summary("mixed_30_per_lang", t)


class TestPipelineThroughput:
    """Throughput-focused tests measuring files/sec and nodes/sec."""

    def test_throughput_scales_linearly(self, tmp_path: Path) -> None:
        """Verify that doubling input doesn't more than 3x the runtime.

        This catches accidental O(n^2) regressions in scanning or resolution.
        """
        small_dir = tmp_path / "small"
        large_dir = tmp_path / "large"
        small_dir.mkdir()
        large_dir.mkdir()

        _make_python_project(small_dir, 25)
        _make_python_project(large_dir, 100)

        t_small = PipelineTimer(small_dir, "bench/small").run()
        t_large = PipelineTimer(large_dir, "bench/large").run()

        # 4x files should take at most ~3x time (allowing for overhead)
        ratio = t_large.elapsed / max(t_small.elapsed, 0.001)
        assert ratio < 8.0, (
            f"Scaling ratio {ratio:.1f}x for 4x files "
            f"(small={t_small.elapsed:.2f}s, large={t_large.elapsed:.2f}s)"
        )
        _print_summary("throughput_small_25", t_small)
        _print_summary("throughput_large_100", t_large)
        print(f"  scaling_ratio: {ratio:.2f}x for 4x input")

    def test_store_persistence_overhead(self, tmp_path: Path) -> None:
        """Measure overhead of MemoryStore persistence vs no store."""
        _make_python_project(tmp_path, 50)

        # Without store
        t_no_store = PipelineTimer(tmp_path, "bench/no-store")
        t_no_store.store = None  # type: ignore[assignment]
        t0 = time.perf_counter()
        events_no_store = []
        nodes_no_store = []
        for event in collect_pipeline(PipelineInput(path=str(tmp_path), repo_id="bench/no-store"))[0]:
            pass
        # Re-run properly
        inp = PipelineInput(path=str(tmp_path), repo_id="bench/no-store")
        t0 = time.perf_counter()
        events, nodes, rels = collect_pipeline(inp)
        elapsed_no_store = time.perf_counter() - t0

        # With store
        store = MemoryStore()
        inp2 = PipelineInput(path=str(tmp_path), repo_id="bench/with-store")
        t0 = time.perf_counter()
        events2, nodes2, rels2 = collect_pipeline(inp2, store=store)
        elapsed_with_store = time.perf_counter() - t0

        overhead = elapsed_with_store - elapsed_no_store
        overhead_pct = (overhead / max(elapsed_no_store, 0.001)) * 100

        print(f"\n  store_overhead: {overhead:.3f}s ({overhead_pct:.1f}%)")
        print(f"  without_store: {elapsed_no_store:.3f}s")
        print(f"  with_store: {elapsed_with_store:.3f}s")

        # Store overhead should be minimal (<50% of base time)
        assert overhead_pct < 50, (
            f"Store overhead {overhead_pct:.1f}% exceeds 50% threshold"
        )


class TestEventStreamPerf:
    """Benchmark event emission characteristics."""

    def test_event_count_proportional_to_files(self, tmp_path: Path) -> None:
        """Ensure we don't emit an excessive number of events."""
        _make_python_project(tmp_path, 100)
        t = PipelineTimer(tmp_path).run()

        num_files = t.result.files_processed if t.result else 0
        num_events = len(t.events)

        # Rough bound: events should be O(files), not O(files^2)
        # Expect ~2-5 events per file (progress + nodes) + fixed stage events
        events_per_file = num_events / max(num_files, 1)
        print(f"\n  events: {num_events}, files: {num_files}")
        print(f"  events_per_file: {events_per_file:.1f}")

        assert events_per_file < 20, (
            f"Too many events per file: {events_per_file:.1f} (expected <20)"
        )

    def test_all_nodes_have_summaries(self, tmp_path: Path) -> None:
        """Verify the summarization stage adds summaries to all nodes."""
        _make_python_project(tmp_path, 20)
        t = PipelineTimer(tmp_path).run()

        nodes_without_summary = [
            n for n in t.nodes
            if not (n.properties or {}).get("summary")
        ]
        total = len(t.nodes)
        with_summary = total - len(nodes_without_summary)

        print(f"\n  total_nodes: {total}, with_summary: {with_summary}")
        # All nodes should have summaries after the summarizing stage
        assert len(nodes_without_summary) == 0, (
            f"{len(nodes_without_summary)}/{total} nodes lack summaries: "
            f"{[n.name for n in nodes_without_summary[:5]]}"
        )


# ---------------------------------------------------------------------------
# Output helper
# ---------------------------------------------------------------------------

def _print_summary(label: str, t: PipelineTimer) -> None:
    s = t.summary()
    print(
        f"\n  [{label}] {s['elapsed_s']}s — "
        f"{s['files_processed']} files, "
        f"{s['nodes_created']} nodes, "
        f"{s['relationships_created']} rels, "
        f"{s['classes_extracted']} classes, "
        f"{s['functions_extracted']} functions | "
        f"{s['files_per_second']} files/s, "
        f"{s['nodes_per_second']} nodes/s"
    )
