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

FIXTURES_ROOT = Path(__file__).resolve().parents[2] / "fixtures"
LEVEL1 = FIXTURES_ROOT / "level1"
LEVEL2 = FIXTURES_ROOT / "level2"
LEVEL3 = FIXTURES_ROOT / "level3"
TASKS_DIR = Path(__file__).resolve().parents[3] / "src" / "opentrace_agent" / "benchmarks" / "tasks"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _index_fixture(tmp_path_factory, name, fixture_path, repo_id):
    """Index a fixture project and return a GraphStore."""
    db_path = str(tmp_path_factory.mktemp(f"bench_{name}") / "test.db")
    store = GraphStore(db_path)
    adapter = GraphStoreAdapter(store, batch_size=500)
    inp = PipelineInput(path=str(fixture_path), repo_id=repo_id)
    for _event in collect_pipeline(inp, store=adapter)[0]:
        pass
    adapter.flush()
    return store


@pytest.fixture(scope="module")
def level1_store(tmp_path_factory):
    """Index the Level 1 fixture project."""
    store = _index_fixture(tmp_path_factory, "l1", LEVEL1, "test/level1")
    yield store
    store.close()


@pytest.fixture(scope="module")
def level2_store(tmp_path_factory):
    """Index the Level 2 fixture project."""
    store = _index_fixture(tmp_path_factory, "l2", LEVEL2, "test/level2")
    yield store
    store.close()


@pytest.fixture(scope="module")
def level3_store(tmp_path_factory):
    """Index the Level 3 fixture project."""
    store = _index_fixture(tmp_path_factory, "l3", LEVEL3, "test/level3")
    yield store
    store.close()


# ---------------------------------------------------------------------------
# Assertion engine tests
# ---------------------------------------------------------------------------


class TestAssertionEngine:
    """Test individual assertion types against known data."""

    def test_min_count_pass(self, level1_store):
        bench = GraphAccuracyBenchmark(level1_store)
        result = bench.run_task(
            {
                "id": "test_min_count",
                "tool": "list_nodes",
                "tool_args": {"type": "File"},
                "assertions": [{"type": "min_count", "value": 1}],
            }
        )
        assert result.passed

    def test_min_count_fail(self, level1_store):
        bench = GraphAccuracyBenchmark(level1_store)
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

    def test_exact_count(self, level1_store):
        bench = GraphAccuracyBenchmark(level1_store)
        result = bench.run_task(
            {
                "id": "test_exact_count",
                "tool": "keyword_search",
                "tool_args": {"query": "zzz_nonexistent_zzz"},
                "assertions": [{"type": "exact_count", "value": 0}],
            }
        )
        assert result.passed

    def test_result_contains_name(self, level1_store):
        bench = GraphAccuracyBenchmark(level1_store)
        result = bench.run_task(
            {
                "id": "test_contains_name",
                "tool": "keyword_search",
                "tool_args": {"query": "Calculator", "nodeTypes": "Class"},
                "assertions": [{"type": "result_contains_name", "value": "Calculator"}],
            }
        )
        assert result.passed

    def test_all_have_type(self, level1_store):
        bench = GraphAccuracyBenchmark(level1_store)
        result = bench.run_task(
            {
                "id": "test_all_have_type",
                "tool": "keyword_search",
                "tool_args": {"query": "app", "nodeTypes": "File"},
                "assertions": [{"type": "all_have_type", "value": "File"}],
            }
        )
        assert result.passed

    def test_has_key(self, level1_store):
        bench = GraphAccuracyBenchmark(level1_store)
        result = bench.run_task(
            {
                "id": "test_has_key",
                "tool": "get_stats",
                "tool_args": {},
                "assertions": [{"type": "has_key", "value": "total_nodes"}],
            }
        )
        assert result.passed

    def test_key_gte(self, level1_store):
        bench = GraphAccuracyBenchmark(level1_store)
        result = bench.run_task(
            {
                "id": "test_key_gte",
                "tool": "get_stats",
                "tool_args": {},
                "assertions": [{"type": "key_gte", "key": "total_nodes", "value": 1}],
            }
        )
        assert result.passed

    def test_tool_error_captured(self, level1_store):
        bench = GraphAccuracyBenchmark(level1_store)
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

    def test_level1_suite(self, level1_store):
        bench = GraphAccuracyBenchmark(level1_store)
        report = bench.run_suite(TASKS_DIR / "level1_smoke.json")

        assert isinstance(report, BenchmarkReport)
        assert report.total > 0
        assert report.suite_name == "Level 1 — Smoke"
        assert report.pass_rate >= 0.5, f"Pass rate too low: {report.summary()}"

    def test_level2_suite(self, level2_store):
        bench = GraphAccuracyBenchmark(level2_store)
        report = bench.run_suite(TASKS_DIR / "level2_multifile.json")

        assert isinstance(report, BenchmarkReport)
        assert report.total > 0
        assert report.suite_name == "Level 2 — Multi-file"
        assert report.pass_rate >= 0.5, f"Pass rate too low: {report.summary()}"

    def test_level3_suite(self, level3_store):
        bench = GraphAccuracyBenchmark(level3_store)
        report = bench.run_suite(TASKS_DIR / "level3_polyglot.json")

        assert isinstance(report, BenchmarkReport)
        assert report.total > 0
        assert report.suite_name == "Level 3 — Polyglot"
        assert report.pass_rate >= 0.5, f"Pass rate too low: {report.summary()}"

    def test_report_has_categories(self, level1_store):
        bench = GraphAccuracyBenchmark(level1_store)
        report = bench.run_suite(TASKS_DIR / "level1_smoke.json")

        assert "symbol_discovery" in report.by_category
        assert "structure" in report.by_category
        for cat_stats in report.by_category.values():
            assert "total" in cat_stats
            assert "passed" in cat_stats

    def test_report_summary_text(self, level1_store):
        bench = GraphAccuracyBenchmark(level1_store)
        report = bench.run_suite(TASKS_DIR / "level1_smoke.json")
        summary = report.summary()

        assert "Level 1" in summary
        assert "Pass rate" in summary
        assert "Total" in summary

    def test_report_to_dict(self, level1_store):
        bench = GraphAccuracyBenchmark(level1_store)
        report = bench.run_suite(TASKS_DIR / "level1_smoke.json")
        d = report.to_dict()

        assert isinstance(d, dict)
        assert "total" in d
        assert "pass_rate" in d
        assert "results" in d
        assert isinstance(d["results"], list)

    def test_run_all_builtin(self, level1_store):
        """run_all_builtin should find and run the shipped task suites."""
        bench = GraphAccuracyBenchmark(level1_store)
        reports = bench.run_all_builtin()
        # At least our three task files should be found
        assert len(reports) >= 3


# ---------------------------------------------------------------------------
# index_and_benchmark convenience function
# ---------------------------------------------------------------------------


class TestIndexAndBenchmark:
    def test_indexes_and_runs(self, tmp_path):
        report, idx_stats = index_and_benchmark(
            str(LEVEL1),
            str(TASKS_DIR / "level1_smoke.json"),
            repo_id="test/level1",
            db_path=str(tmp_path / "bench.db"),
        )
        assert report.total > 0
        assert report.pass_rate >= 0.5
        assert idx_stats.total_nodes > 0
        assert idx_stats.total_edges > 0


# ---------------------------------------------------------------------------
# Custom task file
# ---------------------------------------------------------------------------


class TestCustomTasks:
    def test_custom_task_file(self, level1_store, tmp_path):
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

        bench = GraphAccuracyBenchmark(level1_store)
        report = bench.run_suite(task_file)
        assert report.total == 2
        assert report.passed == 2
        assert report.suite_name == "Custom Suite"
