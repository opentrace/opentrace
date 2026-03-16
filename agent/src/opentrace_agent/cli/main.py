"""OpenTrace CLI — index local codebases and push to the API."""

from __future__ import annotations

import logging
import sys
import time
from pathlib import Path

import click

from opentrace_agent.cli.api_client import BatchImportClient


@click.group()
@click.version_option(package_name="opentrace-agent")
def app() -> None:
    """OpenTrace — map your codebase into a knowledge graph."""


@app.command()
@click.argument("path", type=click.Path(exists=True, file_okay=False, resolve_path=True))
@click.option(
    "--api-url",
    default="http://localhost:8080",
    show_default=True,
    help="OpenTrace API base URL.",
)
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(),
    help="Write directly to a local KuzuDB database (bypasses API).",
)
@click.option("--repo-id", default=None, help="Repository ID (defaults to directory name).")
@click.option("--batch-size", default=200, show_default=True, help="Items per upload batch.")
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def index(
    path: str,
    api_url: str,
    db_path: str | None,
    repo_id: str | None,
    batch_size: int,
    verbose: bool,
) -> None:
    """Index a local codebase and push the graph to OpenTrace."""
    _configure_logging(verbose)

    from opentrace_agent.pipeline import (
        PipelineInput,
        run_pipeline,
    )

    root = Path(path)
    if repo_id is None:
        repo_id = root.name

    store = _make_store(api_url=api_url, db_path=db_path, batch_size=batch_size)

    # Run pipeline
    click.echo(f"Indexing {root} ...")
    t0 = time.monotonic()

    inp = PipelineInput(path=str(root), repo_id=repo_id)

    for event in run_pipeline(inp, store=store):
        _print_event(event, verbose)

    # Ensure the store is properly closed (flushes remaining + closes DB)
    if hasattr(store, "close"):
        store.close()

    elapsed = time.monotonic() - t0

    click.echo(f"Done in {elapsed:.1f}s.")


def _make_store(*, api_url: str, db_path: str | None, batch_size: int) -> object:
    """Create the appropriate store adapter based on CLI options.

    --db takes priority over --api-url.
    """
    if db_path is not None:
        try:
            from opentrace_agent.store import KuzuStore
        except ImportError:
            click.echo(
                "Error: kuzu package not installed. Install with: pip install opentrace-agent[kuzu]",
                err=True,
            )
            sys.exit(1)

        from opentrace_agent.pipeline.adapters import KuzuStoreAdapter

        click.echo(f"Opening KuzuDB at {db_path} ...")
        kuzu_store = KuzuStore(db_path)
        return KuzuStoreAdapter(kuzu_store, batch_size=batch_size)

    # Default: API mode
    from opentrace_agent.pipeline.adapters import ApiStoreAdapter

    client = BatchImportClient(api_url)

    click.echo(f"Connecting to {api_url} ...")
    try:
        client.check_connectivity()
    except ConnectionError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)
    click.echo("Connected.")

    return ApiStoreAdapter(client, batch_size=batch_size)


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


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.WARNING
    logging.basicConfig(
        level=level,
        format="%(levelname)s %(name)s: %(message)s",
    )
