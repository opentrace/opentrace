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

"""OpenTrace CLI — index local codebases into a LadybugDB knowledge graph."""

from __future__ import annotations

import logging
import time
from pathlib import Path

import click


@click.group()
@click.version_option(package_name="opentraceai")
def app() -> None:
    """OpenTrace — map codebases into a knowledge graph."""


@app.command()
@click.argument("path", default=".", type=click.Path(exists=True, file_okay=False, resolve_path=True))
@click.option(
    "--db",
    "db_path",
    default="./otindex.db",
    show_default=True,
    type=click.Path(),
    help="LadybugDB database path.",
)
@click.option("--repo-id", default=None, help="Repository ID (defaults to directory name).")
@click.option("--batch-size", default=200, show_default=True, help="Items per batch.")
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def index(
    path: str,
    db_path: str,
    repo_id: str | None,
    batch_size: int,
    verbose: bool,
) -> None:
    """Index a local codebase into a LadybugDB knowledge graph."""
    _configure_logging(verbose)

    from opentrace_agent.pipeline import PipelineInput, run_pipeline
    from opentrace_agent.pipeline.adapters import KuzuStoreAdapter
    from opentrace_agent.store import KuzuStore

    root = Path(path)
    if repo_id is None:
        repo_id = root.name

    click.echo(f"Opening LadybugDB at {db_path} ...")
    kuzu_store = KuzuStore(db_path)
    store = KuzuStoreAdapter(kuzu_store, batch_size=batch_size)

    click.echo(f"Indexing {root} ...")
    t0 = time.monotonic()

    inp = PipelineInput(path=str(root), repo_id=repo_id)

    for event in run_pipeline(inp, store=store):
        _print_event(event, verbose)

    store.close()

    elapsed = time.monotonic() - t0
    click.echo(f"Done in {elapsed:.1f}s.")


def _print_event(event: object, verbose: bool) -> None:
    """Print pipeline events to the terminal."""
    from opentrace_agent.pipeline import EventKind

    kind = getattr(event, "kind", None)
    message = getattr(event, "message", "")
    result = getattr(event, "result", None)

    if kind == EventKind.STAGE_START:
        click.echo(f"  {message}")
    elif kind == EventKind.STAGE_PROGRESS and verbose:
        detail = getattr(event, "detail", None)
        if detail:
            click.echo(f"    [{detail.current}/{detail.total}] {message}")
    elif kind == EventKind.STAGE_STOP:
        click.echo(f"  {message}")
    elif kind == EventKind.DONE and result:
        click.echo(
            f"  {result.nodes_created} nodes, "
            f"{result.relationships_created} relationships, "
            f"{result.files_processed} files, "
            f"{result.classes_extracted} classes, "
            f"{result.functions_extracted} functions"
        )
    elif kind == EventKind.ERROR:
        errors = getattr(event, "errors", [])
        click.echo(f"  Error: {message}", err=True)
        for err in errors or []:
            click.echo(f"    {err}", err=True)


@app.command("mcp")
@click.option(
    "--db",
    "db_path",
    required=True,
    type=click.Path(exists=True),
    help="LadybugDB database path.",
)
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def mcp_cmd(db_path: str, verbose: bool) -> None:
    """Start a stdio MCP server exposing graph query tools."""
    _configure_logging(verbose)

    from opentrace_agent.cli.mcp_server import create_mcp_server
    from opentrace_agent.store import KuzuStore

    store = KuzuStore(db_path)
    try:
        server = create_mcp_server(store)
        server.run(transport="stdio")
    finally:
        store.close()


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.WARNING
    logging.basicConfig(
        level=level,
        format="%(levelname)s %(name)s: %(message)s",
    )
