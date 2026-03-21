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

"""Tests for the SWE-bench harness (unit tests, no network required)."""

from __future__ import annotations

import json

import pytest

from opentrace_agent.benchmarks.swe_bench import (
    SWEBenchHarness,
    SWEBenchInstance,
    SWEBenchReport,
    SWEBenchResult,
    compare_reports,
)


class TestSWEBenchInstance:
    def test_from_dict_minimal(self):
        data = {
            "instance_id": "django__django-12345",
            "repo": "django/django",
            "base_commit": "abc123",
            "problem_statement": "Fix the bug in models.py",
        }
        inst = SWEBenchInstance.from_dict(data)
        assert inst.instance_id == "django__django-12345"
        assert inst.repo == "django/django"
        assert inst.base_commit == "abc123"
        assert inst.problem_statement == "Fix the bug in models.py"
        assert inst.hints_text == ""
        assert inst.patch == ""

    def test_from_dict_full(self):
        data = {
            "instance_id": "test-1",
            "repo": "owner/repo",
            "base_commit": "deadbeef",
            "problem_statement": "Something is broken",
            "hints_text": "Check the tests",
            "patch": "--- a/file.py\n+++ b/file.py\n",
            "test_patch": "--- a/test.py\n+++ b/test.py\n",
            "version": "1.0",
        }
        inst = SWEBenchInstance.from_dict(data)
        assert inst.hints_text == "Check the tests"
        assert inst.patch.startswith("---")
        assert inst.version == "1.0"


class TestSWEBenchHarness:
    def test_load_instances_list_format(self, tmp_path):
        """Load instances from a plain list of dicts."""
        instances = [
            {
                "instance_id": "test-1",
                "repo": "owner/repo",
                "base_commit": "abc",
                "problem_statement": "Fix bug",
            },
            {
                "instance_id": "test-2",
                "repo": "owner/repo2",
                "base_commit": "def",
                "problem_statement": "Add feature",
            },
        ]
        path = tmp_path / "instances.json"
        path.write_text(json.dumps(instances))

        harness = SWEBenchHarness(work_dir=tmp_path / "work")
        loaded = harness.load_instances(path)
        assert len(loaded) == 2
        assert loaded[0].instance_id == "test-1"
        assert loaded[1].instance_id == "test-2"

    def test_load_instances_wrapped_format(self, tmp_path):
        """Load instances from a dict with 'instances' key."""
        data = {
            "instances": [
                {
                    "instance_id": "test-1",
                    "repo": "owner/repo",
                    "base_commit": "abc",
                    "problem_statement": "Fix bug",
                }
            ]
        }
        path = tmp_path / "instances.json"
        path.write_text(json.dumps(data))

        harness = SWEBenchHarness(work_dir=tmp_path / "work")
        loaded = harness.load_instances(path)
        assert len(loaded) == 1

    def test_work_dir_created(self, tmp_path):
        work = tmp_path / "new_work_dir"
        SWEBenchHarness(work_dir=work)
        assert work.exists()


class TestSWEBenchResult:
    def test_default_values(self):
        result = SWEBenchResult(instance_id="test-1", use_opentrace=True)
        assert result.generated_patch == ""
        assert not result.success
        assert result.error is None
        assert result.duration_s == 0.0


class TestSWEBenchReport:
    def _make_report(self, resolved_count: int, total: int, use_opentrace: bool) -> SWEBenchReport:
        results = []
        for i in range(total):
            results.append(
                SWEBenchResult(
                    instance_id=f"test-{i}",
                    use_opentrace=use_opentrace,
                    success=i < resolved_count,
                    duration_s=10.0,
                    index_duration_s=2.0 if use_opentrace else 0.0,
                )
            )
        return SWEBenchReport(
            total=total,
            use_opentrace=use_opentrace,
            results=results,
            duration_s=total * 10.0,
        )

    def test_resolve_rate(self):
        report = self._make_report(3, 10, True)
        assert report.resolve_rate == pytest.approx(0.3)

    def test_resolve_rate_empty(self):
        report = SWEBenchReport(total=0, use_opentrace=True, results=[], duration_s=0)
        assert report.resolve_rate == 0.0

    def test_summary(self):
        report = self._make_report(5, 10, True)
        text = report.summary()
        assert "WITH OpenTrace" in text
        assert "50.0%" in text

    def test_to_dict(self):
        report = self._make_report(3, 5, False)
        d = report.to_dict()
        assert d["total"] == 5
        assert d["resolved"] == 3
        assert len(d["results"]) == 5


class TestCompareReports:
    def test_comparison_output(self):
        with_ot = SWEBenchReport(
            total=10,
            use_opentrace=True,
            results=[
                SWEBenchResult(
                    instance_id=f"test-{i}",
                    use_opentrace=True,
                    success=i < 7,
                    duration_s=10.0,
                    index_duration_s=2.0,
                )
                for i in range(10)
            ],
            duration_s=100.0,
        )
        without_ot = SWEBenchReport(
            total=10,
            use_opentrace=False,
            results=[
                SWEBenchResult(instance_id=f"test-{i}", use_opentrace=False, success=i < 4, duration_s=10.0)
                for i in range(10)
            ],
            duration_s=100.0,
        )
        text = compare_reports(with_ot, without_ot)
        assert "OpenTrace Impact" in text
        assert "+3" in text  # 7 - 4 = +3 delta
        assert "Resolved ONLY with OpenTrace" in text
