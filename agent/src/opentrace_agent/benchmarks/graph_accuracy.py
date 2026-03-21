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

"""Graph accuracy benchmark — verifies OpenTrace indexing correctness.

Indexes codebases, runs queries via MCP tools, and checks results against
ground-truth task definitions. Measures symbol extraction recall, call graph
accuracy, and search quality.

Task format (JSON):
    {
        "id": "find_database_class",
        "category": "symbol_discovery",
        "description": "Search should find the Database class",
        "tool": "search_graph",
        "tool_args": {"query": "Database", "nodeTypes": "Class"},
        "assertions": [
            {"type": "min_count", "value": 1},
            {"type": "result_contains_name", "value": "Database"}
        ]
    }

Assertion types:
    - min_count: result list has >= value items
    - max_count: result list has <= value items
    - exact_count: result list has exactly value items
    - result_contains_name: at least one result has name == value
    - result_contains_type: at least one result has type == value
    - all_have_type: every result has type == value
    - has_key: top-level result dict contains key == value
    - key_gte: result[key] >= value  (for stats checks)
    - neighbor_has_name: get_node neighbors include a node named value
    - traversal_reaches: traverse results include a node named value
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class TaskResult:
    """Result of running a single benchmark task."""

    task_id: str
    category: str
    passed: bool
    duration_ms: float
    failures: list[str] = field(default_factory=list)
    error: str | None = None


@dataclass
class BenchmarkReport:
    """Aggregate report for all tasks in a benchmark suite."""

    suite_name: str
    total: int
    passed: int
    failed: int
    errors: int
    duration_ms: float
    results: list[TaskResult]
    by_category: dict[str, dict[str, int]] = field(default_factory=dict)

    @property
    def pass_rate(self) -> float:
        return self.passed / self.total if self.total > 0 else 0.0

    def summary(self, *, verbose: bool = False) -> str:
        lines = [
            f"Benchmark: {self.suite_name}",
            f"  Total: {self.total}  Passed: {self.passed}  Failed: {self.failed}  Errors: {self.errors}",
            f"  Pass rate: {self.pass_rate:.1%}  Duration: {self.duration_ms:.0f}ms",
        ]
        if self.by_category:
            lines.append("  By category:")
            for cat, counts in sorted(self.by_category.items()):
                lines.append(f"    {cat}: {counts['passed']}/{counts['total']}")
        if verbose:
            lines.append("")
            lines.append("  Tasks:")
            for r in self.results:
                icon = "PASS" if r.passed else ("ERROR" if r.error else "FAIL")
                lines.append(f"    [{icon:>5}] {r.task_id} ({r.category}, {r.duration_ms:.0f}ms)")
                if not r.passed:
                    detail = r.error or "; ".join(r.failures)
                    lines.append(f"           {detail}")
        else:
            for r in self.results:
                if not r.passed:
                    status = "ERROR" if r.error else "FAIL"
                    detail = r.error or "; ".join(r.failures)
                    lines.append(f"  [{status}] {r.task_id}: {detail}")
        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        return {
            "suite_name": self.suite_name,
            "total": self.total,
            "passed": self.passed,
            "failed": self.failed,
            "errors": self.errors,
            "pass_rate": self.pass_rate,
            "duration_ms": self.duration_ms,
            "by_category": self.by_category,
            "results": [
                {
                    "task_id": r.task_id,
                    "category": r.category,
                    "passed": r.passed,
                    "duration_ms": r.duration_ms,
                    "failures": r.failures,
                    "error": r.error,
                }
                for r in self.results
            ],
        }


class GraphAccuracyBenchmark:
    """Run graph accuracy benchmarks against an indexed codebase.

    Usage::

        from opentrace_agent.store import GraphStore
        from opentrace_agent.benchmarks import GraphAccuracyBenchmark

        store = GraphStore("path/to/index.db", read_only=True)
        bench = GraphAccuracyBenchmark(store)
        report = bench.run_suite("path/to/tasks.json")
        print(report.summary())
    """

    def __init__(self, store: Any) -> None:
        from opentrace_agent.cli.mcp_server import create_mcp_server

        self._store = store
        self._server = create_mcp_server(store)
        # Access internal tool registry — no public API exists for calling
        # tools directly outside the MCP protocol. Pinned to fastmcp internals.
        self._tools = self._server._tool_manager._tools

    def _call_tool(self, tool_name: str, **kwargs: Any) -> Any:
        """Call an MCP tool and parse JSON response."""
        tool = self._tools[tool_name]
        raw = tool.fn(**kwargs)
        if "\n...[truncated" in raw:
            raw = raw[: raw.index("\n...[truncated")]
        return json.loads(raw)

    def run_task(self, task: dict[str, Any]) -> TaskResult:
        """Run a single benchmark task and return the result."""
        task_id = task["id"]
        category = task.get("category", "general")
        t0 = time.monotonic()

        try:
            result = self._call_tool(task["tool"], **task.get("tool_args", {}))
        except Exception as e:
            return TaskResult(
                task_id=task_id,
                category=category,
                passed=False,
                duration_ms=(time.monotonic() - t0) * 1000,
                error=f"{type(e).__name__}: {e}",
            )

        failures = []
        for assertion in task.get("assertions", []):
            failure = self._check_assertion(result, assertion)
            if failure:
                failures.append(failure)

        elapsed = (time.monotonic() - t0) * 1000
        return TaskResult(
            task_id=task_id,
            category=category,
            passed=len(failures) == 0,
            duration_ms=elapsed,
            failures=failures,
        )

    def run_suite(self, tasks_path: str | Path) -> BenchmarkReport:
        """Load tasks from a JSON file and run them all."""
        tasks_path = Path(tasks_path)
        data = json.loads(tasks_path.read_text())
        suite_name = data.get("suite_name", tasks_path.stem)
        tasks = data["tasks"]

        t0 = time.monotonic()
        results = [self.run_task(task) for task in tasks]
        elapsed = (time.monotonic() - t0) * 1000

        passed = sum(1 for r in results if r.passed)
        errors = sum(1 for r in results if r.error)
        failed = len(results) - passed - errors

        by_category: dict[str, dict[str, int]] = {}
        for r in results:
            cat = by_category.setdefault(r.category, {"total": 0, "passed": 0, "failed": 0, "errors": 0})
            cat["total"] += 1
            if r.passed:
                cat["passed"] += 1
            elif r.error:
                cat["errors"] += 1
            else:
                cat["failed"] += 1

        return BenchmarkReport(
            suite_name=suite_name,
            total=len(results),
            passed=passed,
            failed=failed,
            errors=errors,
            duration_ms=elapsed,
            results=results,
            by_category=by_category,
        )

    def run_all_builtin(self) -> list[BenchmarkReport]:
        """Run all built-in task suites shipped with OpenTrace."""
        tasks_dir = Path(__file__).parent / "tasks"
        reports = []
        for task_file in sorted(tasks_dir.glob("*.json")):
            logger.info("Running suite: %s", task_file.name)
            reports.append(self.run_suite(task_file))
        return reports

    # ------------------------------------------------------------------
    # Assertion checks
    # ------------------------------------------------------------------

    def _check_assertion(self, result: Any, assertion: dict[str, Any]) -> str | None:
        """Check a single assertion against tool output. Returns failure message or None."""
        atype = assertion["type"]
        value = assertion.get("value")

        if atype == "min_count":
            if not isinstance(result, list) or len(result) < value:
                actual = len(result) if isinstance(result, list) else type(result).__name__
                return f"min_count: expected >= {value}, got {actual}"

        elif atype == "max_count":
            if not isinstance(result, list) or len(result) > value:
                actual = len(result) if isinstance(result, list) else type(result).__name__
                return f"max_count: expected <= {value}, got {actual}"

        elif atype == "exact_count":
            if not isinstance(result, list) or len(result) != value:
                actual = len(result) if isinstance(result, list) else type(result).__name__
                return f"exact_count: expected {value}, got {actual}"

        elif atype == "result_contains_name":
            if isinstance(result, list):
                names = {r.get("name") for r in result if isinstance(r, dict)}
                if value not in names:
                    return f"result_contains_name: '{value}' not in {sorted(n for n in names if n is not None)}"
            elif isinstance(result, dict) and "node" in result:
                if result["node"].get("name") != value:
                    return f"result_contains_name: node name is '{result['node'].get('name')}', expected '{value}'"
            else:
                return f"result_contains_name: unexpected result type {type(result).__name__}"

        elif atype == "result_contains_type":
            if not isinstance(result, list):
                return f"result_contains_type: expected list, got {type(result).__name__}"
            types = {r.get("type") for r in result if isinstance(r, dict)}
            if value not in types:
                return f"result_contains_type: '{value}' not in {sorted(t for t in types if t is not None)}"

        elif atype == "all_have_type":
            if not isinstance(result, list):
                return f"all_have_type: expected list, got {type(result).__name__}"
            for r in result:
                if isinstance(r, dict) and r.get("type") != value:
                    return f"all_have_type: found type '{r.get('type')}', expected all '{value}'"

        elif atype == "has_key":
            if not isinstance(result, dict) or value not in result:
                return f"has_key: '{value}' not in result keys"

        elif atype == "key_gte":
            key = assertion["key"]
            if not isinstance(result, dict):
                return f"key_gte: expected dict, got {type(result).__name__}"
            actual = result.get(key)
            if actual is None or actual < value:
                return f"key_gte: result['{key}'] = {actual}, expected >= {value}"

        elif atype == "neighbor_has_name":
            if not isinstance(result, dict) or "neighbors" not in result:
                return "neighbor_has_name: expected dict with 'neighbors'"
            neighbor_names = {n.get("node", {}).get("name") for n in result.get("neighbors", []) if isinstance(n, dict)}
            if value not in neighbor_names:
                clean = sorted(n for n in neighbor_names if n is not None)
                return f"neighbor_has_name: '{value}' not in neighbor names {clean}"

        elif atype == "traversal_reaches":
            if not isinstance(result, list):
                return f"traversal_reaches: expected list, got {type(result).__name__}"
            reached_names = set()
            for entry in result:
                if isinstance(entry, dict):
                    node = entry.get("node", {})
                    if isinstance(node, dict):
                        reached_names.add(node.get("name"))
            if value not in reached_names:
                clean = sorted(n for n in reached_names if n is not None)
                return f"traversal_reaches: '{value}' not reachable, found {clean}"

        else:
            return f"Unknown assertion type: {atype}"

        return None


@dataclass
class IndexStats:
    """Stats about what was indexed, attached to the report for verbose output."""

    total_nodes: int = 0
    total_edges: int = 0
    nodes_by_type: dict[str, int] = field(default_factory=dict)
    files_processed: int = 0
    classes_extracted: int = 0
    functions_extracted: int = 0

    def summary(self) -> str:
        parts = [f"{count} {ntype}" for ntype, count in sorted(self.nodes_by_type.items(), key=lambda x: -x[1])]
        return (
            f"  Indexed: {self.total_nodes} nodes, {self.total_edges} edges "
            f"({self.files_processed} files, {self.classes_extracted} classes, "
            f"{self.functions_extracted} functions)\n"
            f"  Types: {', '.join(parts)}"
        )


def index_and_benchmark(
    codebase_path: str,
    tasks_path: str,
    *,
    repo_id: str | None = None,
    db_path: str | None = None,
) -> tuple[BenchmarkReport, IndexStats]:
    """Convenience: index a codebase and run a benchmark suite against it.

    If *db_path* is None, creates a temporary database.
    Returns ``(report, index_stats)``.
    """
    import tempfile

    from opentrace_agent.pipeline import PipelineInput, collect_pipeline
    from opentrace_agent.pipeline.adapters import GraphStoreAdapter
    from opentrace_agent.store import GraphStore

    root = Path(codebase_path)
    if repo_id is None:
        repo_id = root.name

    if db_path is None:
        tmp = tempfile.mkdtemp(prefix="opentrace_bench_")
        db_path = str(Path(tmp) / "bench.db")

    store = GraphStore(db_path)
    adapter = GraphStoreAdapter(store, batch_size=500)

    inp = PipelineInput(path=str(root), repo_id=repo_id)
    events, all_nodes, all_rels = collect_pipeline(inp, store=adapter)
    adapter.flush()

    # Gather index stats
    stats_data = store.get_stats()
    idx_stats = IndexStats(
        total_nodes=stats_data.get("total_nodes", 0),
        total_edges=stats_data.get("total_edges", 0),
        nodes_by_type=stats_data.get("nodes_by_type", {}),
    )
    # Pull counts from the pipeline result if available
    for ev in events:
        result = getattr(ev, "result", None)
        if result is not None:
            idx_stats.files_processed = getattr(result, "files_processed", 0)
            idx_stats.classes_extracted = getattr(result, "classes_extracted", 0)
            idx_stats.functions_extracted = getattr(result, "functions_extracted", 0)

    try:
        bench = GraphAccuracyBenchmark(store)
        report = bench.run_suite(tasks_path)
    finally:
        store.close()
    return report, idx_stats
