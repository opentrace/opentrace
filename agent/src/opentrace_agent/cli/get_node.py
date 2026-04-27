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

"""``opentrace get-node`` — fetch a single node and its 1-hop neighbors.

One-shot CLI surface for the same envelope the MCP server's ``get_node``
tool returns: the node itself plus every immediate neighbor (in either
direction) along with the connecting relationship. Plugins that don't
embed an MCP client can call this without authoring Cypher.

The relationship payload includes a derived ``direction`` field
(``"incoming"`` or ``"outgoing"``) so callers don't have to compare
``source_id``/``target_id`` against the requested node id themselves.
"""

from __future__ import annotations

import json
from typing import Any

import click


_NEIGHBOR_TEXT_LIMIT = 20


def _node_to_dict(node: dict[str, Any]) -> dict[str, Any]:
    """Normalize a store-shaped node dict for JSON output.

    Coerces ``id``/``name``/``type`` to strings (the store row parser
    already does this, but explicit here keeps the JSON contract obvious)
    and ensures ``properties`` is always a dict — never ``None`` —
    so consumers can do ``node["properties"].get(...)`` unconditionally.
    """
    return {
        "id": str(node.get("id", "")),
        "name": str(node.get("name", "")),
        "type": str(node.get("type", "")),
        "properties": node.get("properties") or {},
    }


def _classify_neighbor(node_id: str, entry: dict[str, Any]) -> dict[str, Any]:
    """Convert a store.traverse entry into the get-node neighbor shape.

    ``store.traverse`` returns ``{node, relationship, depth}``; the
    relationship carries ``source_id``/``target_id``, which lets us
    derive direction relative to the requested node. We surface
    ``direction`` as a first-class field so JSON consumers don't
    re-implement that comparison.
    """
    rel = entry.get("relationship") or {}
    direction = "outgoing" if rel.get("source_id") == node_id else "incoming"
    return {
        "node": _node_to_dict(entry.get("node") or {}),
        "relationship": {
            "id": str(rel.get("id", "")),
            "type": str(rel.get("type", "")),
            "direction": direction,
            "properties": rel.get("properties") or {},
        },
    }


def run_get_node(node_id: str, db_path: str, *, output_json: bool = False) -> None:
    """Entry point for the get-node subcommand.

    Raises ``click.ClickException`` when the node id is not in the
    graph — exit code 1 with a one-line stderr message, no traceback.
    """
    from opentrace_agent.store import GraphStore

    store = GraphStore(db_path, read_only=True)
    try:
        node = store.get_node(node_id)
        if node is None:
            raise click.ClickException(f"Node not found: {node_id}")

        try:
            raw = store.traverse(node_id, direction="both", max_depth=1)
        except ValueError:
            # store.traverse re-checks node existence and raises if it
            # vanished between the get_node above and the traversal —
            # treat as "no neighbors" rather than failing the whole call.
            raw = []

        neighbors = [_classify_neighbor(node_id, entry) for entry in raw]

        if output_json:
            click.echo(
                json.dumps(
                    {"node": _node_to_dict(node), "neighbors": neighbors},
                    indent=2,
                    default=str,
                )
            )
        else:
            _emit_text(node, neighbors)
    finally:
        store.close()


def _emit_text(node: dict[str, Any], neighbors: list[dict[str, Any]]) -> None:
    """Render the LLM-friendly text view (default mode)."""
    props = node.get("properties") or {}

    lines: list[str] = [
        f"[{node['type']}] {node['name']}",
        f"  ID: {node['id']}",
    ]
    if props.get("path"):
        lines.append(f"  File: {props['path']}")
    start = props.get("start_line")
    end = props.get("end_line")
    if start is not None:
        end_part = f"-{end}" if end is not None and end != start else ""
        lines.append(f"  Lines: {start}{end_part}")
    if props.get("signature"):
        lines.append(f"  Signature: {props['signature']}")
    if props.get("language"):
        lines.append(f"  Language: {props['language']}")
    if props.get("docs"):
        lines.append(f"  Docs: {str(props['docs'])[:300]}")
    if props.get("summary"):
        lines.append(f"  Summary: {props['summary']}")

    outgoing = [n for n in neighbors if n["relationship"]["direction"] == "outgoing"]
    incoming = [n for n in neighbors if n["relationship"]["direction"] == "incoming"]

    if outgoing:
        lines.extend(["", f"Outgoing relationships ({len(outgoing)}):"])
        for n in outgoing[:_NEIGHBOR_TEXT_LIMIT]:
            rel_type = n["relationship"]["type"]
            lines.append(f"  --{rel_type}--> [{n['node']['type']}] {n['node']['name']}")
        if len(outgoing) > _NEIGHBOR_TEXT_LIMIT:
            lines.append(f"  ... and {len(outgoing) - _NEIGHBOR_TEXT_LIMIT} more")

    if incoming:
        lines.extend(["", f"Incoming relationships ({len(incoming)}):"])
        for n in incoming[:_NEIGHBOR_TEXT_LIMIT]:
            rel_type = n["relationship"]["type"]
            lines.append(f"  <--{rel_type}-- [{n['node']['type']}] {n['node']['name']}")
        if len(incoming) > _NEIGHBOR_TEXT_LIMIT:
            lines.append(f"  ... and {len(incoming) - _NEIGHBOR_TEXT_LIMIT} more")

    if not neighbors:
        lines.extend(["", "No relationships found."])

    click.echo("\n".join(lines))
