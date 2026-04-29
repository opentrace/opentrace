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

from opentrace_agent.store.graph_store import _unmarshal_props


# Cap on the FTS scan window when --repo is set. Compensates for the
# global FTS ranking dropping results from other repos before the
# WHERE filter applies. 10× the user's limit, capped to keep the scan
# bounded even for absurd --limit values.
_FTS_OVERFETCH_MULT = 10
_FTS_OVERFETCH_CAP = 500


def _props_to_dict(raw: Any) -> dict[str, Any]:
    """Coerce a node's ``properties`` column to a dict.

    Kuzu may return JSON or its MAP literal format
    (``{key: value, ...}`` with no quotes) depending on the read path;
    ``_unmarshal_props`` handles both. The dict branch is for callers
    that have already parsed the column upstream.
    """
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        return _unmarshal_props(raw) or {}
    return {}


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
        raise click.ClickException(
            f"No repo with id {repo_id!r}. Available: {', '.join(candidates)}"
        )
    raise click.ClickException(
        f"No repo with id {repo_id!r} (no Repository nodes are indexed)."
    )


def _run_fts_search(
    store: Any,
    query: str,
    repo_id: str | None,
    node_types: list[str] | None,
    limit: int,
) -> list[dict[str, Any]]:
    """Execute the FTS-with-filter query as a single round trip."""
    top = limit if not repo_id else min(limit * _FTS_OVERFETCH_MULT, _FTS_OVERFETCH_CAP)

    where_clauses: list[str] = []
    params: dict[str, Any] = {"query": query, "top": top, "limit": limit}
    if repo_id:
        where_clauses.append("node.id STARTS WITH $repo_prefix")
        params["repo_prefix"] = f"{repo_id}/"
    if node_types:
        where_clauses.append("node.type IN $node_types")
        params["node_types"] = list(node_types)

    cypher = (
        "CALL QUERY_FTS_INDEX('Node', 'node_fts', $query, top := $top) "
        "WITH node, score "
    )
    if where_clauses:
        cypher += "WHERE " + " AND ".join(where_clauses) + " "
    cypher += (
        "RETURN node.id, node.name, node.type, node.properties, score "
        "ORDER BY score DESC LIMIT $limit"
    )

    result = store._conn.execute(cypher, parameters=params)
    rows: list[dict[str, Any]] = []
    while result.has_next():
        row = result.get_next()
        rows.append(
            {
                "id": str(row[0]),
                "name": str(row[1]),
                "type": str(row[2]),
                "properties": _props_to_dict(row[3]),
                "score": float(row[4]),
            }
        )
    return rows


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
        results = _run_fts_search(
            store, query, resolved_repo, node_types, limit + 1
        )
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
