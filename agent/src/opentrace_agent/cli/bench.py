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

"""OpenTrace benchmark CLI — graph accuracy and SWE-bench evaluation.

Separate entry point so benchmark tooling doesn't clutter the production
``opentraceai`` CLI. Install and run as::

    opentraceai-bench accuracy tests/fixtures/level1 tasks/level1_smoke.json
    opentraceai-bench swe-bench instances.json --backend claude-code
"""

from __future__ import annotations

import logging

import click

from opentrace_agent.cli.main import _resolve_db


def _configure_logging(verbose: bool) -> None:
    level = logging.WARNING
    logging.basicConfig(
        level=level,
        format="%(levelname)s %(name)s: %(message)s",
    )


def _print_report(report: object, output_format: str, json_mod: object, *, verbose: bool = False) -> None:
    if output_format == "json":
        click.echo(json_mod.dumps(report.to_dict(), indent=2))  # type: ignore[union-attr]
    else:
        click.echo(report.summary(verbose=verbose))  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# CLI group
# ---------------------------------------------------------------------------


@click.group()
@click.version_option(package_name="opentraceai")
def app() -> None:
    """OpenTrace benchmarks — graph accuracy and SWE-bench evaluation."""


# ---------------------------------------------------------------------------
# accuracy (formerly `opentraceai benchmark`)
# ---------------------------------------------------------------------------


@app.command()
@click.argument("tasks_path", required=False, default=None, type=click.Path(exists=True))
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Database path (auto-discovered if omitted). If set, runs tasks against an existing index.",
)
@click.option(
    "--codebase",
    default=None,
    type=click.Path(exists=True, file_okay=False),
    help="Path to codebase to index before benchmarking.",
)
@click.option("--repo-id", default=None, help="Repository ID for indexing.")
@click.option(
    "--output",
    "output_format",
    type=click.Choice(["text", "json"]),
    default="text",
    show_default=True,
    help="Output format.",
)
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def accuracy(
    tasks_path: str | None,
    db_path: str | None,
    codebase: str | None,
    repo_id: str | None,
    output_format: str,
    verbose: bool,
) -> None:
    """Run graph accuracy benchmarks.

    If TASKS_PATH is given, runs that specific task suite. Otherwise runs all
    built-in task suites against the current index.

    Use --codebase to index a directory first, or --db to point at an existing
    index database.
    """
    import json as json_mod

    _configure_logging(verbose)

    from opentrace_agent.benchmarks.graph_accuracy import (
        GraphAccuracyBenchmark,
        index_and_benchmark,
    )
    from opentrace_agent.store import GraphStore

    if codebase and not tasks_path:
        click.echo(
            "--codebase requires TASKS_PATH. Usage: opentraceai-bench accuracy --codebase PATH tasks.json",
            err=True,
        )
        raise SystemExit(1)

    if codebase and tasks_path:
        report, idx_stats = index_and_benchmark(codebase, tasks_path, repo_id=repo_id, db_path=db_path)
        if verbose:
            click.echo(idx_stats.summary())
            click.echo()
        _print_report(report, output_format, json_mod, verbose=verbose)
        return

    resolved_db = _resolve_db(db_path, must_exist=True)
    store = GraphStore(resolved_db, read_only=True)

    if verbose:
        stats_data = store.get_stats()
        nodes_by_type = stats_data.get("nodes_by_type", {})
        parts = [f"{c} {t}" for t, c in sorted(nodes_by_type.items(), key=lambda x: -x[1])]
        click.echo(
            f"  Database: {stats_data['total_nodes']} nodes, {stats_data['total_edges']} edges ({', '.join(parts)})"
        )
        click.echo()

    bench = GraphAccuracyBenchmark(store)

    try:
        if tasks_path:
            report = bench.run_suite(tasks_path)
            _print_report(report, output_format, json_mod, verbose=verbose)
        else:
            reports = bench.run_all_builtin()
            if not reports:
                click.echo("No built-in task suites found.", err=True)
                raise SystemExit(1)
            for report in reports:
                _print_report(report, output_format, json_mod, verbose=verbose)
                click.echo()
    finally:
        store.close()


# ---------------------------------------------------------------------------
# swe-bench
# ---------------------------------------------------------------------------


@app.command("swe-bench")
@click.argument("instances_path", type=click.Path(exists=True))
@click.option("--model", default="claude-sonnet-4-20250514", show_default=True, help="Claude model to use.")
@click.option("--work-dir", default=None, type=click.Path(), help="Working directory for repos and indexes.")
@click.option("--no-opentrace", is_flag=True, help="Run without OpenTrace (baseline).")
@click.option("--compare", is_flag=True, help="Run both with and without OpenTrace and compare.")
@click.option("--limit", default=None, type=int, help="Max instances to run.")
@click.option(
    "--backend",
    type=click.Choice(["api", "claude-code"]),
    default="api",
    show_default=True,
    help="Agent backend: 'api' uses Anthropic API directly, 'claude-code' shells out to the claude CLI.",
)
@click.option("-j", "--workers", default=1, show_default=True, help="Number of instances to run in parallel.")
@click.option("-v", "--verbose", is_flag=True, help="Show live progress and per-instance results.")
def swe_bench(
    instances_path: str,
    model: str,
    work_dir: str | None,
    no_opentrace: bool,
    compare: bool,
    limit: int | None,
    backend: str,
    workers: int,
    verbose: bool,
) -> None:
    """Run SWE-bench evaluation with a Claude agent.

    \b
    Backends:
      api         — calls Anthropic API directly (requires opentraceai[swe-bench], ANTHROPIC_API_KEY)
      claude-code — shells out to `claude` CLI (recommended, requires claude on PATH)

    INSTANCES_PATH is a JSON file with SWE-bench instances.
    """
    _configure_logging(verbose)

    from opentrace_agent.benchmarks.agent import run_swe_bench_cli

    run_swe_bench_cli(
        instances_path,
        model=model,
        work_dir=work_dir,
        use_opentrace=not no_opentrace,
        limit=limit,
        compare=compare,
        backend=backend,
        workers=workers,
        verbose=verbose,
    )
