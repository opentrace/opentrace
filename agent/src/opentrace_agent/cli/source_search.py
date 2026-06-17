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

"""``opentraceai source-search`` — full-text search across the indexed graph.

Runs Kuzu's FTS over the unified ``Node`` table and, when ``--repo`` is
set, applies a post-FTS Cypher predicate (``node.id STARTS WITH
'<repo_id>/'``) to scope results to one repository. Filtering pre-FTS is
not possible — Kuzu's ``QUERY_FTS_INDEX`` accepts a table name string,
not a node variable, and produces a globally-ranked top-K.

Because FTS ranks across all indexed repos, the global top-N can have
few or no entries from any one repo. With ``--repo`` we therefore
over-fetch the FTS scan window (``top := 10 × limit``, capped at 500)
so the post-filter has more candidates to draw from.

The indexed search text (built by ``store.graph_store.build_search_text``)
combines a node's name, *type*, summary, and path — so ``source-search
Function`` matches every Function node. Use ``--types`` for node-kind
filtering rather than putting the type in the query.
"""

from __future__ import annotations

import json
from typing import Any

import click


def _load_repo_ids(store: Any) -> list[str]:
    """Return all Repository node ids, longest first.

    Used to attribute each result row back to its owning repo when
    ``--repo`` is not set: a node id like ``acme/widget/src/foo.py``
    can't be split on ``/`` blindly because repo ids themselves may
    contain ``/`` (e.g. ``owner/repo``). Sorting longest-first lets
    the prefix scan pick the most specific match.
    """
    return sorted(store.list_repository_ids(), key=len, reverse=True)


def _attribute_repo(node_id: str, repo_ids: list[str]) -> str:
    """Find the Repository node id that owns *node_id*.

    Children of repository ``R`` have ids ``R/...``; the Repository
    node itself has id ``R``. Returns the longest matching repo id,
    or the leading path segment as a last-resort fallback for orphan
    nodes whose owning repo is no longer indexed.
    """
    for r in repo_ids:
        if node_id == r or node_id.startswith(r + "/"):
            return r
    return node_id.split("/", 1)[0] if "/" in node_id else node_id


def strip_repo_prefix(path_like: str, repo_ids: list[str]) -> str:
    """Strip the longest matching repo id from *path_like*; return the trailing remainder.

    Mirrors :func:`_attribute_repo` but returns the slash-separated
    remainder. For ``"acme/widget/src/foo.py"`` against
    ``["acme/widget"]`` returns ``"src/foo.py"``. When *path_like*
    equals a repo id (no remainder), returns ``""``. When no repo
    id matches, falls back to splitting on the first ``"/"`` —
    same orphan-node shape as :func:`_attribute_repo`.

    *repo_ids* must be sorted longest-first so a multi-segment id
    like ``"acme/widget"`` wins over a single-segment match like
    ``"acme"`` when both are indexed; :func:`_load_repo_ids`
    produces the right ordering.
    """
    for r in repo_ids:
        if path_like == r:
            return ""
        if path_like.startswith(r + "/"):
            return path_like[len(r) + 1 :]
    return path_like.split("/", 1)[1] if "/" in path_like else ""


def _resolve_repo(store: Any, repo_id: str | None) -> str | None:
    """Verify *repo_id* exists as a Repository node id; raise on miss.

    Returns ``None`` when *repo_id* is None (the unfiltered search).
    Raises ``click.ClickException`` with a candidate list when the
    input doesn't match — surfacing the typo to the caller is more
    helpful than silently returning zero results.

    Matches by canonical id only — the ``id`` field surfaced by the
    ``repos`` command, never the node ``name``.
    """
    if not repo_id:
        return None

    if store.repository_exists(repo_id):
        return repo_id

    candidates = store.list_repository_ids()
    if candidates:
        raise click.ClickException(f"No repo with id {repo_id!r}. Available: {', '.join(candidates)}")
    raise click.ClickException(f"No repo with id {repo_id!r} (no Repository nodes are indexed).")


def _run_fts_search(
    store: Any,
    query: str,
    repo_id: str | None,
    node_types: list[str] | None,
    limit: int,
) -> list[dict[str, Any]]:
    """Execute the FTS-with-filter query as a single round trip.

    Thin adapter over :meth:`GraphStore.fts_search` — the FTS Cypher and
    its repo/type predicates live in the store layer (the single source
    of truth shared with the ``fts_search`` MCP tool). This wrapper keeps
    the positional call signature ``run_source_search`` already uses.

    The store follows the ``get_node`` convention of returning ``None``
    for empty properties; the source-search emitters expect a dict, so
    normalize ``None`` → ``{}`` here to preserve that contract.
    """
    results = store.fts_search(query, node_types=node_types, repo_id=repo_id, limit=limit)
    for node in results:
        if node.get("properties") is None:
            node["properties"] = {}
    return results


def run_source_search(
    query: str,
    db_path: str | None,
    *,
    repo: str | None = None,
    node_types: list[str] | None = None,
    limit: int = 20,
    output_json: bool = False,
) -> None:
    """Entry point for the source-search subcommand.

    *db_path* must be a resolved path to an existing index. *repo* is
    a canonical repo id (the ``id`` field from the ``repos`` command
    output); pass ``None`` to search across all indexed repos.
    *node_types* optionally restricts results to specific node types
    (``Function``, ``Class``, ...). *output_json* emits a structured
    object instead of formatted text.
    """
    from opentrace_agent.store import GraphStore

    store = GraphStore(db_path, read_only=True)
    try:
        resolved_repo = _resolve_repo(store, repo)
        # Over-fetch one row beyond `limit` so we can distinguish
        # "exactly `limit` matches in the graph" from "more existed,
        # truncated here". The +1 row is then trimmed before output.
        results = _run_fts_search(store, query, resolved_repo, node_types, limit + 1)
        truncated = len(results) > limit
        if truncated:
            results = results[:limit]

        repo_ids = [resolved_repo] if resolved_repo else _load_repo_ids(store)

        if output_json:
            _emit_json(query, resolved_repo, results, truncated, limit)
        else:
            _emit_text(query, resolved_repo, results, repo_ids)
    finally:
        store.close()


def _emit_json(
    query: str,
    repo_id: str | None,
    results: list[dict[str, Any]],
    truncated: bool,
    limit: int,
) -> None:
    """Emit structured JSON for programmatic consumers."""
    payload = {
        "query": query,
        "repo": repo_id,
        "totalResults": len(results),
        "truncated": truncated,
        "limit": limit,
        "results": results,
    }
    click.echo(json.dumps(payload, indent=2, default=str))


def _emit_text(
    query: str,
    repo_id: str | None,
    results: list[dict[str, Any]],
    repo_ids: list[str],
) -> None:
    """Emit human-readable text output (default mode)."""
    repo_part = f" in repo {repo_id!r}" if repo_id else ""

    if not results:
        click.echo(
            f"No results found for {query!r}{repo_part}. "
            f"Try different keywords or check indexed repos with `opentrace repos`."
        )
        return

    lines: list[str] = [
        f"Found {len(results)} result(s) for {query!r}{repo_part}:",
        "",
    ]
    for node in results:
        props = node["properties"]
        block: list[str] = [f"[{node['type']}] {node['name']}"]
        block.append(f"  Repo: {_attribute_repo(node['id'], repo_ids)}")
        path = props.get("path")
        if path:
            block.append(f"  File: {path}")
        start = props.get("start_line")
        end = props.get("end_line")
        if start is not None:
            end_part = f"-{end}" if end is not None and end != start else ""
            block.append(f"  Lines: {start}{end_part}")
        if props.get("signature"):
            block.append(f"  Signature: {props['signature']}")
        if props.get("summary"):
            block.append(f"  Summary: {props['summary']}")
        block.append(f"  Node ID: {node['id']}")
        lines.append("\n".join(block))
        lines.append("")

    lines.append("Use `opentrace source-read --node-id <id>` to read the source.")
    click.echo("\n".join(lines).rstrip())
