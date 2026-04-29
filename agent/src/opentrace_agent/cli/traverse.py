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

"""``opentrace traverse`` — BFS walk from a starting node.

Thin wrapper around ``GraphStore.traverse`` exposing the same shape the
MCP server's ``traverse_graph`` tool returns. Each result row keeps the
relationship's ``source_id``/``target_id`` so multi-hop callers can
reconstruct paths, and the real per-row depth is preserved so callers
can distinguish a direct neighbor from a transitive one.

For depth=1 plus both directions, prefer ``opentrace get-node`` —
that's the more ergonomic surface and adds direction classification.
"""

from __future__ import annotations

import json
from typing import Any

import click


_VALID_DIRECTIONS = ("outgoing", "incoming", "both")

# Match the MCP ``traverse_graph`` tool's clamp — guards against
# unbounded BFS on a large index when a caller forgets to set --depth.
_MAX_DEPTH = 10


def _node_to_dict(node: dict[str, Any]) -> dict[str, Any]:
    """Normalize a store-shaped node dict for JSON output."""
    return {
        "id": str(node.get("id", "")),
        "name": str(node.get("name", "")),
        "type": str(node.get("type", "")),
        "properties": node.get("properties") or {},
    }


def _rel_to_dict(rel: dict[str, Any]) -> dict[str, Any]:
    """Normalize a store-shaped relationship dict for JSON output.

    Direction is *not* derived here. For depth > 1 the relationship
    connects intermediate nodes, not the requested start node, so a
    "direction" field would be misleading. Consumers that care can
    compare ``source_id``/``target_id`` against whichever node they're
    interested in.
    """
    return {
        "id": str(rel.get("id", "")),
        "type": str(rel.get("type", "")),
        "source_id": str(rel.get("source_id", "")),
        "target_id": str(rel.get("target_id", "")),
        "properties": rel.get("properties") or {},
    }


def run_traverse(
    node_id: str,
    db_path: str,
    *,
    direction: str = "outgoing",
    depth: int = 2,
    rel_type: str | None = None,
    output_json: bool = False,
) -> None:
    """Entry point for the traverse subcommand.

    Raises ``click.ClickException`` for invalid direction (the click
    ``Choice`` type catches this on the CLI path; the explicit check is
    here for direct callers, since ``store.traverse`` silently returns
    no rows for an unknown direction) or when the start node id is not
    in the graph. ``depth`` is clamped to ``_MAX_DEPTH``; the JSON
    envelope and text header reflect the clamped value.
    """
    if direction not in _VALID_DIRECTIONS:
        raise click.ClickException(
            f"Invalid direction {direction!r}. Must be one of: {', '.join(_VALID_DIRECTIONS)}."
        )

    if depth > _MAX_DEPTH:
        click.echo(
            f"Warning: --depth {depth} exceeds the cap of {_MAX_DEPTH}; "
            f"clamping to {_MAX_DEPTH}.",
            err=True,
        )
        depth = _MAX_DEPTH

    from opentrace_agent.store import GraphStore

    store = GraphStore(db_path, read_only=True)
    try:
        try:
            raw = store.traverse(
                node_id,
                direction=direction,
                max_depth=depth,
                relationship_type=rel_type,
            )
        except ValueError as e:
            # store.traverse validates start-node existence and raises
            # ValueError("node not found: ...") — surface as a click
            # error so exit code is 1 with no traceback.
            raise click.ClickException(str(e)) from e

        results = [
            {
                "node": _node_to_dict(entry.get("node") or {}),
                "relationship": _rel_to_dict(entry.get("relationship") or {}),
                "depth": int(entry.get("depth", 1)),
            }
            for entry in raw
        ]

        if output_json:
            click.echo(
                json.dumps(
                    {
                        "start": node_id,
                        "direction": direction,
                        "depth": depth,
                        "relType": rel_type,
                        "totalResults": len(results),
                        "results": results,
                    },
                    indent=2,
                    default=str,
                )
            )
        else:
            _emit_text(node_id, direction, depth, rel_type, results)
    finally:
        store.close()


def _emit_text(
    node_id: str,
    direction: str,
    depth: int,
    rel_type: str | None,
    results: list[dict[str, Any]],
) -> None:
    """Render a grouped-by-depth text view (default mode)."""
    rel_part = f" along {rel_type}" if rel_type else ""
    header = (
        f"Traversal {direction}{rel_part} from {node_id} (max depth {depth}): "
        f"{len(results)} result(s)"
    )

    if not results:
        click.echo(header + "\n(no neighbors reached)")
        return

    by_depth: dict[int, list[dict[str, Any]]] = {}
    for entry in results:
        by_depth.setdefault(entry["depth"], []).append(entry)

    lines = [header]
    for d in sorted(by_depth):
        lines.append("")
        lines.append(f"Depth {d} ({len(by_depth[d])}):")
        for entry in by_depth[d]:
            lines.append("  " + _format_row(entry))

    click.echo("\n".join(lines))


def _format_row(entry: dict[str, Any]) -> str:
    """Render one traversal row as ``(source) --TYPE--> (target)``.

    The result node is shown as ``[Type] name (id)`` on whichever side
    of the arrow it occupies, and the other endpoint is shown as a bare
    ``(id)``. This stays correct regardless of ``--direction`` and at
    any depth, where rendering only the new node would lose the arrow
    orientation.
    """
    node = entry["node"]
    rel = entry["relationship"]
    rel_type = rel.get("type", "")
    label = f"[{node['type']}] {node['name']} ({node['id']})"

    # Self-loops fall through to the second branch ("node is target")
    # and render as ``(id) --TYPE--> [Type] name (id)``.
    if rel.get("source_id") == node["id"] and rel.get("target_id") != node["id"]:
        return f"{label} --{rel_type}--> ({rel.get('target_id', '')})"
    return f"({rel.get('source_id', '')}) --{rel_type}--> {label}"
