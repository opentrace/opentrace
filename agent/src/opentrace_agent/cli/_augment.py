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

"""``opentraceai augment`` — quick graph context for a search pattern.

Queries the index for nodes matching the pattern, fetches their direct
relationships, and prints a compact human-readable block to stdout.
"""

from __future__ import annotations

from typing import Any

# Relationship types we surface in the context block.
_INTERESTING_RELS = frozenset({
    "CALLS", "IMPORTS", "DEPENDS_ON", "CONTAINS", "EXTENDS", "IMPLEMENTS",
})

# Maximum nodes / relationships to show to keep output < 50 lines.
_MAX_NODES = 10
_MAX_RELS_PER_NODE = 5


def _format_node(node: dict[str, Any]) -> str:
    """One-line summary: Type: Name (path)."""
    props = node.get("properties") or {}
    path = props.get("path", "")
    loc = f"  ({path})" if path else ""
    return f"  {node['type']}: {node['name']}{loc}"


def _format_rel(rel: dict[str, Any], neighbor: dict[str, Any], direction: str) -> str:
    """One-line relationship: --REL_TYPE--> Name (Type)."""
    arrow = f"--{rel['type']}-->" if direction == "out" else f"<--{rel['type']}--"
    return f"    {arrow} {neighbor['name']} ({neighbor['type']})"


def run_augment(pattern: str, db_path: str | None) -> None:
    """Entry point for the augment subcommand.

    *db_path* should already be resolved by the caller (via ``find_db`` /
    ``_resolve_db`` in ``main.py``).  Pass ``None`` to silently no-op.
    """
    if not db_path:
        return

    try:
        from opentrace_agent.store import KuzuStore
    except Exception:
        return

    try:
        store = KuzuStore(db_path, read_only=True)
    except Exception:
        return

    try:
        nodes = store.search_nodes(pattern, limit=_MAX_NODES)
        if not nodes:
            return

        lines: list[str] = []
        lines.append(f"[OpenTrace] Graph context for '{pattern}':")
        lines.append("")

        for node in nodes:
            lines.append(_format_node(node))

            # Fetch direct relationships
            try:
                neighbors = store._get_neighbors(node["id"], "both")
            except Exception:
                continue

            rel_count = 0
            for idx, (nb_node, nb_rel) in enumerate(neighbors):
                if nb_rel["type"] not in _INTERESTING_RELS:
                    continue
                if rel_count >= _MAX_RELS_PER_NODE:
                    remaining = sum(
                        1 for _, r in neighbors[idx:]
                        if r["type"] in _INTERESTING_RELS
                    )
                    if remaining > 0:
                        lines.append(f"    ... and {remaining} more relationships")
                    break
                direction = "out" if nb_rel["source_id"] == node["id"] else "in"
                lines.append(_format_rel(nb_rel, nb_node, direction))
                rel_count += 1

            lines.append("")

        output = "\n".join(lines).rstrip()
        if output:
            print(output)
    except Exception:
        pass
    finally:
        try:
            store.close()
        except Exception:
            pass
