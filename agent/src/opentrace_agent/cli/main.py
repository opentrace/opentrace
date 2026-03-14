"""OpenTrace CLI — index local codebases and serve as MCP."""

from __future__ import annotations

import logging
import sys
import time
from pathlib import Path

import click

from opentrace_agent.cli.converter import tree_to_batch
from opentrace_agent.sources.code.local_loader import LocalCodeLoader


@click.group()
@click.version_option(package_name="opentrace-agent")
def app() -> None:
    """OpenTrace — map your codebase into a knowledge graph."""


@app.command()
@click.argument(
    "path", type=click.Path(exists=True, file_okay=False, resolve_path=True)
)
@click.option(
    "--api-url",
    default="http://localhost:8080",
    show_default=True,
    help="OpenTrace API base URL (used when --db is not set).",
)
@click.option(
    "--db",
    "db_path",
    default=None,
    type=click.Path(resolve_path=True),
    help="Path to a local KuzuDB directory. When set, indexes directly into the "
    "local database instead of uploading to the API.",
)
@click.option(
    "--repo-id", default=None, help="Repository ID (defaults to directory name)."
)
@click.option(
    "--batch-size", default=200, show_default=True, help="Items per upload batch."
)
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

    root = Path(path)
    if repo_id is None:
        repo_id = root.name

    # 1. Index locally (tree-sitter)
    click.echo(f"Indexing {root} ...")
    t0 = time.monotonic()
    loader = LocalCodeLoader()
    tree = loader.load(root, repo_id=repo_id)
    index_time = time.monotonic() - t0
    click.echo(f"Indexed in {index_time:.1f}s: {tree.counters}")

    # 2. Convert tree to batch dicts
    nodes, rels = tree_to_batch(tree)
    click.echo(f"Converted {len(nodes)} nodes, {len(rels)} relationships.")

    # 3. Store — local KuzuDB or remote API
    if db_path is not None:
        _import_to_kuzu(db_path, nodes, rels, verbose)
    else:
        _import_to_api(api_url, nodes, rels, batch_size, verbose)


def _import_to_kuzu(
    db_path: str,
    nodes: list[dict],
    rels: list[dict],
    verbose: bool,
) -> None:
    """Import nodes/rels into a local KuzuDB database."""
    from opentrace_agent.store.kuzu_store import KuzuStore

    click.echo(f"Writing to local KuzuDB at {db_path} ...")
    t0 = time.monotonic()

    with KuzuStore(db_path) as store:
        result = store.import_batch(nodes, rels)

    elapsed = time.monotonic() - t0
    click.echo(
        f"Done in {elapsed:.1f}s — "
        f"{result['nodes_created']} nodes, "
        f"{result['relationships_created']} relationships created."
    )
    if result.get("errors", 0) > 0:
        click.echo(
            f"  ({result['errors']} errors — check logs for details)", err=True
        )


def _import_to_api(
    api_url: str,
    nodes: list[dict],
    rels: list[dict],
    batch_size: int,
    verbose: bool,
) -> None:
    """Upload nodes/rels to the OpenTrace REST API."""
    from opentrace_agent.cli.api_client import BatchImportClient

    client = BatchImportClient(api_url)

    click.echo(f"Connecting to {api_url} ...")
    try:
        client.check_connectivity()
    except ConnectionError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)
    click.echo("Connected.")

    click.echo("Uploading ...")
    t0 = time.monotonic()
    result = client.import_all(
        nodes,
        rels,
        batch_size=batch_size,
        on_progress=lambda msg: click.echo(f"  {msg}") if verbose else None,
    )
    upload_time = time.monotonic() - t0

    click.echo(
        f"Done in {upload_time:.1f}s — "
        f"{result['nodes_created']} nodes, "
        f"{result['relationships_created']} relationships created."
    )
    if result.get("errors", 0) > 0:
        click.echo(
            f"  ({result['errors']} errors — check logs for details)", err=True
        )


@app.command()
@click.option(
    "--db",
    "db_path",
    required=True,
    type=click.Path(exists=True, resolve_path=True),
    help="Path to a KuzuDB directory created by 'opentrace index --db'.",
)
@click.option(
    "--transport",
    type=click.Choice(["stdio", "http"]),
    default="stdio",
    show_default=True,
    help="MCP transport.",
)
@click.option(
    "--host",
    default="127.0.0.1",
    show_default=True,
    help="Bind address for HTTP transport.",
)
@click.option(
    "--port",
    default=8000,
    show_default=True,
    help="Port for HTTP transport.",
)
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def serve(
    db_path: str, transport: str, host: str, port: int, verbose: bool
) -> None:
    """Serve a local KuzuDB as an MCP server."""
    _configure_logging(verbose)

    from opentrace_agent.serve.server import create_mcp_server
    from opentrace_agent.store.kuzu_store import KuzuStore

    store = KuzuStore(db_path)
    stats = store.get_stats()
    click.echo(
        f"Loaded graph: {stats['total_nodes']} nodes, "
        f"{stats['total_edges']} edges"
    )

    mcp = create_mcp_server(store)

    if transport == "stdio":
        click.echo("Starting MCP server (stdio) ...")
        mcp.run(transport="stdio")
    else:
        click.echo(f"Starting MCP server (http) on {host}:{port} ...")
        mcp.run(transport="streamable-http", host=host, port=port)


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.WARNING
    logging.basicConfig(
        level=level,
        format="%(levelname)s %(name)s: %(message)s",
    )
