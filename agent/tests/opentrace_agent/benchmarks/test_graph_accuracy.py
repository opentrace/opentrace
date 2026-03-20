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

"""Tests for the graph accuracy benchmark framework."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from opentrace_agent.pipeline import PipelineInput, collect_pipeline
from opentrace_agent.pipeline.adapters import GraphStoreAdapter

pytest.importorskip("real_ladybug")

from opentrace_agent.benchmarks.graph_accuracy import (  # noqa: E402
    BenchmarkReport,
    GraphAccuracyBenchmark,
    index_and_benchmark,
)
from opentrace_agent.store import GraphStore  # noqa: E402

FIXTURES_ROOT = Path(__file__).resolve().parents[4] / "tests" / "fixtures"
PYTHON_PROJECT = FIXTURES_ROOT / "python" / "project"
GO_PROJECT = FIXTURES_ROOT / "go" / "project"
TASKS_DIR = Path(__file__).resolve().parents[3] / "src" / "opentrace_agent" / "benchmarks" / "tasks"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def python_store(tmp_path_factory):
    """Index the Python fixture project."""
    db_path = str(tmp_path_factory.mktemp("bench_py") / "test.db")
    store = GraphStore(db_path)
    adapter = GraphStoreAdapter(store, batch_size=500)
    inp = PipelineInput(path=str(PYTHON_PROJECT), repo_id="test/py-project")
    for _event in collect_pipeline(inp, store=adapter)[0]:
        pass
    adapter.flush()
    yield store
    store.close()


@pytest.fixture(scope="module")
def go_store(tmp_path_factory):
    """Index the Go fixture project."""
    db_path = str(tmp_path_factory.mktemp("bench_go") / "test.db")
    store = GraphStore(db_path)
    adapter = GraphStoreAdapter(store, batch_size=500)
    inp = PipelineInput(path=str(GO_PROJECT), repo_id="test/go-project")
    for _event in collect_pipeline(inp, store=adapter)[0]:
        pass
    adapter.flush()
    yield store
    store.close()


# ---------------------------------------------------------------------------
# Assertion engine tests
# ---------------------------------------------------------------------------


class TestAssertionEngine:
    """Test individual assertion types against known data."""

    def test_min_count_pass(self, python_store):
        bench = GraphAccuracyBenchmark(python_store)
        result = bench.run_task(
            {
                "id": "test_min_count",
                "tool": "list_nodes",
                "tool_args": {"type": "File"},
                "assertions": [{"type": "min_count", "value": 1}],
            }
        )
        assert result.passed

    def test_min_count_fail(self, python_store):
        bench = GraphAccuracyBenchmark(python_store)
        result = bench.run_task(
            {
                "id": "test_min_count_fail",
                "tool": "list_nodes",
                "tool_args": {"type": "File"},
                "assertions": [{"type": "min_count", "value": 9999}],
            }
        )
        assert not result.passed
        assert any("min_count" in f for f in result.failures)

    def test_exact_count(self, python_store):
        bench = GraphAccuracyBenchmark(python_store)
        result = bench.run_task(
            {
                "id": "test_exact_count",
                "tool": "search_graph",
                "tool_args": {"query": "zzz_nonexistent_zzz"},
                "assertions": [{"type": "exact_count", "value": 0}],
            }
        )
        assert result.passed

    def test_result_contains_name(self, python_store):
        bench = GraphAccuracyBenchmark(python_store)
        result = bench.run_task(
            {
                "id": "test_contains_name",
                "tool": "search_graph",
                "tool_args": {"query": "Database", "nodeTypes": "Class"},
                "assertions": [{"type": "result_contains_name", "value": "Database"}],
            }
        )
        assert result.passed

    def test_all_have_type(self, python_store):
        bench = GraphAccuracyBenchmark(python_store)
        result = bench.run_task(
            {
                "id": "test_all_have_type",
                "tool": "search_graph",
                "tool_args": {"query": "main", "nodeTypes": "File"},
                "assertions": [{"type": "all_have_type", "value": "File"}],
            }
        )
        assert result.passed

    def test_has_key(self, python_store):
        bench = GraphAccuracyBenchmark(python_store)
        result = bench.run_task(
            {
                "id": "test_has_key",
                "tool": "get_stats",
                "tool_args": {},
                "assertions": [{"type": "has_key", "value": "total_nodes"}],
            }
        )
        assert result.passed

    def test_key_gte(self, python_store):
        bench = GraphAccuracyBenchmark(python_store)
        result = bench.run_task(
            {
                "id": "test_key_gte",
                "tool": "get_stats",
                "tool_args": {},
                "assertions": [{"type": "key_gte", "key": "total_nodes", "value": 1}],
            }
        )
        assert result.passed

    def test_tool_error_captured(self, python_store):
        bench = GraphAccuracyBenchmark(python_store)
        result = bench.run_task(
            {
                "id": "test_error",
                "tool": "nonexistent_tool",
                "tool_args": {},
                "assertions": [],
            }
        )
        assert not result.passed
        assert result.error is not None


# ---------------------------------------------------------------------------
# Suite runner tests
# ---------------------------------------------------------------------------


class TestSuiteRunner:
    """Test running full task suites."""

    def test_python_suite(self, python_store):
        bench = GraphAccuracyBenchmark(python_store)
        report = bench.run_suite(TASKS_DIR / "python_project.json")

        assert isinstance(report, BenchmarkReport)
        assert report.total > 0
        assert report.suite_name == "Python Project — Graph Accuracy"
        # Most tasks should pass against the fixture
        assert report.pass_rate >= 0.5, f"Pass rate too low: {report.summary()}"

    def test_go_suite(self, go_store):
        bench = GraphAccuracyBenchmark(go_store)
        report = bench.run_suite(TASKS_DIR / "go_project.json")

        assert isinstance(report, BenchmarkReport)
        assert report.total > 0
        assert report.pass_rate >= 0.5, f"Pass rate too low: {report.summary()}"

    def test_report_has_categories(self, python_store):
        bench = GraphAccuracyBenchmark(python_store)
        report = bench.run_suite(TASKS_DIR / "python_project.json")

        assert "symbol_discovery" in report.by_category
        assert "structure" in report.by_category
        for cat_stats in report.by_category.values():
            assert "total" in cat_stats
            assert "passed" in cat_stats

    def test_report_summary_text(self, python_store):
        bench = GraphAccuracyBenchmark(python_store)
        report = bench.run_suite(TASKS_DIR / "python_project.json")
        summary = report.summary()

        assert "Python Project" in summary
        assert "Pass rate" in summary
        assert "Total" in summary

    def test_report_to_dict(self, python_store):
        bench = GraphAccuracyBenchmark(python_store)
        report = bench.run_suite(TASKS_DIR / "python_project.json")
        d = report.to_dict()

        assert isinstance(d, dict)
        assert "total" in d
        assert "pass_rate" in d
        assert "results" in d
        assert isinstance(d["results"], list)

    def test_run_all_builtin(self, python_store):
        """run_all_builtin should find and run the shipped task suites."""
        bench = GraphAccuracyBenchmark(python_store)
        reports = bench.run_all_builtin()
        # At least our two task files should be found
        assert len(reports) >= 2


# ---------------------------------------------------------------------------
# index_and_benchmark convenience function
# ---------------------------------------------------------------------------


class TestIndexAndBenchmark:
    def test_indexes_and_runs(self, tmp_path):
        report = index_and_benchmark(
            str(PYTHON_PROJECT),
            str(TASKS_DIR / "python_project.json"),
            repo_id="test/py-project",
            db_path=str(tmp_path / "bench.db"),
        )
        assert report.total > 0
        assert report.pass_rate >= 0.5


# ---------------------------------------------------------------------------
# Custom task file
# ---------------------------------------------------------------------------


class TestCustomTasks:
    def test_custom_task_file(self, python_store, tmp_path):
        """A user-defined task file should work."""
        tasks = {
            "suite_name": "Custom Suite",
            "tasks": [
                {
                    "id": "custom_1",
                    "category": "custom",
                    "tool": "get_stats",
                    "tool_args": {},
                    "assertions": [{"type": "has_key", "value": "total_nodes"}],
                },
                {
                    "id": "custom_2",
                    "category": "custom",
                    "tool": "list_nodes",
                    "tool_args": {"type": "File"},
                    "assertions": [{"type": "min_count", "value": 1}],
                },
            ],
        }
        task_file = tmp_path / "custom_tasks.json"
        task_file.write_text(json.dumps(tasks))

        bench = GraphAccuracyBenchmark(python_store)
        report = bench.run_suite(task_file)
        assert report.total == 2
        assert report.passed == 2
        assert report.suite_name == "Custom Suite"
