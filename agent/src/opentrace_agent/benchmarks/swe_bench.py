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

"""SWE-bench harness — measure how OpenTrace helps AI agents solve coding tasks.

Workflow:
    1. Load SWE-bench instances (from JSON or HuggingFace dataset)
    2. For each instance:
       a. Clone the repo at the correct commit
       b. Index it with OpenTrace
       c. Start MCP server as a subprocess
       d. Run an AI agent with/without OpenTrace tools
       e. Collect the generated patch
    3. Evaluate patches against gold standard

This module handles steps 1-3 and provides hooks for step 4 (agent execution)
and step 5 (evaluation).

Example::

    harness = SWEBenchHarness(work_dir="/tmp/swe_bench")
    results = harness.run(
        instances_path="swe-bench-lite.json",
        agent_fn=my_agent_function,
        use_opentrace=True,
    )
"""

from __future__ import annotations

import json
import logging
import shutil
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)


@dataclass
class SWEBenchInstance:
    """A single SWE-bench task instance."""

    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    hints_text: str = ""
    patch: str = ""  # gold patch for evaluation
    test_patch: str = ""
    version: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SWEBenchInstance:
        return cls(
            instance_id=data["instance_id"],
            repo=data["repo"],
            base_commit=data["base_commit"],
            problem_statement=data["problem_statement"],
            hints_text=data.get("hints_text", ""),
            patch=data.get("patch", ""),
            test_patch=data.get("test_patch", ""),
            version=data.get("version", ""),
        )


@dataclass
class SWEBenchResult:
    """Result of running a single SWE-bench instance."""

    instance_id: str
    use_opentrace: bool
    generated_patch: str = ""
    success: bool = False
    error: str | None = None
    duration_s: float = 0.0
    index_duration_s: float = 0.0
    agent_duration_s: float = 0.0
    tool_calls: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SWEBenchReport:
    """Aggregate results from a SWE-bench evaluation run."""

    total: int
    use_opentrace: bool
    results: list[SWEBenchResult]
    duration_s: float

    @property
    def resolved(self) -> int:
        return sum(1 for r in self.results if r.success)

    @property
    def resolve_rate(self) -> float:
        return self.resolved / self.total if self.total > 0 else 0.0

    @property
    def errors(self) -> int:
        return sum(1 for r in self.results if r.error)

    def summary(self) -> str:
        label = "WITH OpenTrace" if self.use_opentrace else "WITHOUT OpenTrace"
        lines = [
            f"SWE-bench Results ({label})",
            f"  Total: {self.total}  Resolved: {self.resolved}  Errors: {self.errors}",
            f"  Resolve rate: {self.resolve_rate:.1%}",
            f"  Total duration: {self.duration_s:.1f}s",
        ]
        if self.results:
            avg_duration = sum(r.duration_s for r in self.results) / len(self.results)
            lines.append(f"  Avg instance duration: {avg_duration:.1f}s")
            if self.use_opentrace:
                avg_index = sum(r.index_duration_s for r in self.results) / len(self.results)
                lines.append(f"  Avg index duration: {avg_index:.1f}s")
        for r in self.results:
            if r.error:
                lines.append(f"  [ERROR] {r.instance_id}: {r.error}")
        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "resolved": self.resolved,
            "resolve_rate": self.resolve_rate,
            "errors": self.errors,
            "use_opentrace": self.use_opentrace,
            "duration_s": self.duration_s,
            "results": [
                {
                    "instance_id": r.instance_id,
                    "success": r.success,
                    "error": r.error,
                    "duration_s": r.duration_s,
                    "index_duration_s": r.index_duration_s,
                    "agent_duration_s": r.agent_duration_s,
                    "tool_calls": r.tool_calls,
                }
                for r in self.results
            ],
        }


# ---------------------------------------------------------------------------
# Agent function type
# ---------------------------------------------------------------------------

# The agent function receives the problem statement, repo path, and optionally
# an MCP server endpoint. It returns a unified diff patch string.
AgentFn = Callable[
    [str, Path, dict[str, Any] | None],  # (problem_statement, repo_path, mcp_config)
    str,  # generated patch
]


class SWEBenchHarness:
    """Orchestrates SWE-bench evaluation with and without OpenTrace.

    Parameters
    ----------
    work_dir : str or Path
        Directory for cloned repos and index databases.
    opentraceai_cmd : str
        CLI command for the OpenTrace agent (default: ``opentraceai``).
    clone_timeout : int
        Timeout in seconds for git clone (default: 120).
    index_timeout : int
        Timeout in seconds for indexing (default: 300).
    """

    def __init__(
        self,
        work_dir: str | Path | None = None,
        opentraceai_cmd: str = "opentraceai",
        clone_timeout: int = 120,
        index_timeout: int = 300,
    ) -> None:
        if work_dir is None:
            work_dir = Path(tempfile.mkdtemp(prefix="swe_bench_"))
        self.work_dir = Path(work_dir)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.opentraceai_cmd = opentraceai_cmd
        self.clone_timeout = clone_timeout
        self.index_timeout = index_timeout

    def load_instances(self, path: str | Path) -> list[SWEBenchInstance]:
        """Load SWE-bench instances from a JSON file.

        Supports both the standard SWE-bench format (list of dicts) and
        the HuggingFace datasets format (list of dicts with instance_id keys).
        """
        data = json.loads(Path(path).read_text())
        if isinstance(data, dict) and "instances" in data:
            data = data["instances"]
        return [SWEBenchInstance.from_dict(d) for d in data]

    def clone_repo(self, instance: SWEBenchInstance) -> Path:
        """Clone the repository at the correct base commit."""
        repo_dir = self.work_dir / "repos" / instance.instance_id
        if repo_dir.exists():
            shutil.rmtree(repo_dir)
        repo_dir.parent.mkdir(parents=True, exist_ok=True)

        repo_url = f"https://github.com/{instance.repo}.git"
        logger.info("Cloning %s @ %s", instance.repo, instance.base_commit[:8])

        subprocess.run(
            ["git", "clone", "--quiet", repo_url, str(repo_dir)],
            check=True,
            timeout=self.clone_timeout,
            capture_output=True,
        )
        subprocess.run(
            ["git", "checkout", "--quiet", instance.base_commit],
            check=True,
            cwd=repo_dir,
            capture_output=True,
        )
        return repo_dir

    def index_repo(self, repo_dir: Path, instance: SWEBenchInstance) -> Path:
        """Index a cloned repo with OpenTrace. Returns the database path."""
        db_dir = self.work_dir / "dbs" / instance.instance_id
        db_dir.mkdir(parents=True, exist_ok=True)
        db_path = db_dir / "index.db"

        logger.info("Indexing %s", instance.instance_id)
        subprocess.run(
            [
                self.opentraceai_cmd,
                "index",
                str(repo_dir),
                "--db",
                str(db_path),
                "--repo-id",
                instance.repo,
            ],
            check=True,
            timeout=self.index_timeout,
            capture_output=True,
        )
        return db_path

    def start_mcp_server(self, db_path: Path) -> subprocess.Popen:
        """Start an MCP server subprocess for the indexed database."""
        proc = subprocess.Popen(
            [self.opentraceai_cmd, "mcp", "--db", str(db_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        # Give the server a moment to initialize
        time.sleep(0.5)
        if proc.poll() is not None:
            stderr = proc.stderr.read().decode() if proc.stderr else ""
            raise RuntimeError(f"MCP server failed to start: {stderr}")
        return proc

    def stop_mcp_server(self, proc: subprocess.Popen) -> None:
        """Gracefully stop an MCP server subprocess."""
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    def run_instance(
        self,
        instance: SWEBenchInstance,
        agent_fn: AgentFn,
        *,
        use_opentrace: bool = True,
    ) -> SWEBenchResult:
        """Run a single SWE-bench instance.

        Parameters
        ----------
        instance : SWEBenchInstance
            The task to solve.
        agent_fn : AgentFn
            Function that generates a patch. Receives (problem_statement, repo_path, mcp_config).
            mcp_config is None when use_opentrace=False.
        use_opentrace : bool
            Whether to index and provide MCP tools.
        """
        t0 = time.monotonic()
        result = SWEBenchResult(instance_id=instance.instance_id, use_opentrace=use_opentrace)

        try:
            # Clone
            repo_dir = self.clone_repo(instance)

            # Index (if using OpenTrace)
            mcp_config = None
            mcp_proc = None
            if use_opentrace:
                t_index = time.monotonic()
                db_path = self.index_repo(repo_dir, instance)
                result.index_duration_s = time.monotonic() - t_index

                mcp_proc = self.start_mcp_server(db_path)
                mcp_config = {
                    "server_type": "stdio",
                    "command": self.opentraceai_cmd,
                    "args": ["mcp", "--db", str(db_path)],
                    "pid": mcp_proc.pid,
                    "db_path": str(db_path),
                }

            # Run the agent
            t_agent = time.monotonic()
            try:
                patch = agent_fn(instance.problem_statement, repo_dir, mcp_config)
                result.generated_patch = patch
                result.success = bool(patch and patch.strip())
            finally:
                result.agent_duration_s = time.monotonic() - t_agent
                if mcp_proc:
                    self.stop_mcp_server(mcp_proc)

        except Exception as e:
            result.error = f"{type(e).__name__}: {e}"
            logger.error("Error on %s: %s", instance.instance_id, e)

        result.duration_s = time.monotonic() - t0
        return result

    def run(
        self,
        instances_path: str | Path,
        agent_fn: AgentFn,
        *,
        use_opentrace: bool = True,
        limit: int | None = None,
    ) -> SWEBenchReport:
        """Run the full SWE-bench evaluation.

        Parameters
        ----------
        instances_path : str or Path
            Path to SWE-bench instances JSON file.
        agent_fn : AgentFn
            The agent function to test.
        use_opentrace : bool
            Whether to provide OpenTrace tools.
        limit : int or None
            Max instances to run (for quick testing).
        """
        instances = self.load_instances(instances_path)
        if limit:
            instances = instances[:limit]

        t0 = time.monotonic()
        results = []
        for i, instance in enumerate(instances):
            logger.info(
                "[%d/%d] Running %s (opentrace=%s)",
                i + 1,
                len(instances),
                instance.instance_id,
                use_opentrace,
            )
            result = self.run_instance(instance, agent_fn, use_opentrace=use_opentrace)
            results.append(result)

        return SWEBenchReport(
            total=len(results),
            use_opentrace=use_opentrace,
            results=results,
            duration_s=time.monotonic() - t0,
        )

    def run_comparison(
        self,
        instances_path: str | Path,
        agent_fn: AgentFn,
        *,
        limit: int | None = None,
    ) -> tuple[SWEBenchReport, SWEBenchReport]:
        """Run SWE-bench both with and without OpenTrace for comparison.

        Returns (report_with_opentrace, report_without_opentrace).
        """
        report_with = self.run(instances_path, agent_fn, use_opentrace=True, limit=limit)
        report_without = self.run(instances_path, agent_fn, use_opentrace=False, limit=limit)
        return report_with, report_without


def compare_reports(with_ot: SWEBenchReport, without_ot: SWEBenchReport) -> str:
    """Generate a comparison summary between two SWE-bench runs."""
    lines = [
        "SWE-bench Comparison: OpenTrace Impact",
        "=" * 45,
        "",
        f"{'Metric':<25} {'With OT':>10} {'Without OT':>12} {'Delta':>8}",
        "-" * 55,
        f"{'Instances':<25} {with_ot.total:>10} {without_ot.total:>12}",
        f"{'Resolved':<25} {with_ot.resolved:>10} {without_ot.resolved:>12}"
        f" {with_ot.resolved - without_ot.resolved:>+8}",
        f"{'Resolve rate':<25} {with_ot.resolve_rate:>9.1%} {without_ot.resolve_rate:>11.1%}"
        f" {(with_ot.resolve_rate - without_ot.resolve_rate):>+7.1%}",
        f"{'Errors':<25} {with_ot.errors:>10} {without_ot.errors:>12}",
        f"{'Total duration (s)':<25} {with_ot.duration_s:>10.1f} {without_ot.duration_s:>12.1f}",
    ]
    if with_ot.results:
        avg_dur_with = sum(r.duration_s for r in with_ot.results) / len(with_ot.results)
        avg_dur_without = sum(r.duration_s for r in without_ot.results) / len(without_ot.results)
        lines.append(f"{'Avg duration (s)':<25} {avg_dur_with:>10.1f} {avg_dur_without:>12.1f}")

        avg_index = sum(r.index_duration_s for r in with_ot.results) / len(with_ot.results)
        lines.append(f"{'Avg index time (s)':<25} {avg_index:>10.1f} {'N/A':>12}")

    # Per-instance comparison
    with_map = {r.instance_id: r for r in with_ot.results}
    without_map = {r.instance_id: r for r in without_ot.results}
    shared = set(with_map) & set(without_map)
    if shared:
        only_with = [iid for iid in shared if with_map[iid].success and not without_map[iid].success]
        only_without = [iid for iid in shared if not with_map[iid].success and without_map[iid].success]
        if only_with:
            lines.append(f"\nResolved ONLY with OpenTrace ({len(only_with)}):")
            for iid in only_with:
                lines.append(f"  + {iid}")
        if only_without:
            lines.append(f"\nResolved ONLY without OpenTrace ({len(only_without)}):")
            for iid in only_without:
                lines.append(f"  - {iid}")

    return "\n".join(lines)
