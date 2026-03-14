"""Converts a TreeWithOrigin into plain dicts for the batch import API."""

from __future__ import annotations

import uuid
from collections import deque
from typing import Any

from opentrace_agent.models.base import BaseTreeNode, TreeWithOrigin

# Relationship type normalization (handles legacy snake_case + special aliases)
_REL_TYPE_MAP: dict[str, str] = {
    "PARENT_OF": "PART_OF",
    # Legacy snake_case compat (remove once all producers emit UPPER_CASE)
    "defined_in": "DEFINED_IN",
    "depends_on": "DEPENDS_ON",
    "calls": "CALLS",
    "extends": "EXTENDS",
    "part_of": "PART_OF",
    "authored": "AUTHORED",
    "assigned": "ASSIGNED",
    "parent_of": "PART_OF",
    "participated": "PARTICIPATED",
}


def _normalize_rel_type(rel_type: str) -> str:
    return _REL_TYPE_MAP.get(rel_type, rel_type.upper())


def tree_to_batch(
    tree: TreeWithOrigin,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """BFS-walk a tree and return (nodes, relationships) as plain dicts.

    Output format matches the API ``importBatchRequest``:
      - node:  ``{id, type, name, properties}``
      - rel:   ``{id, type, source_id, target_id, properties}``

    Returns:
        A tuple of (node_dicts, relationship_dicts).
    """
    nodes: list[dict[str, Any]] = []
    rels: list[dict[str, Any]] = []

    queue: deque[BaseTreeNode] = deque([tree.root])
    visited: set[str] = set()

    while queue:
        node = queue.popleft()
        if node.id in visited:
            continue
        visited.add(node.id)

        props = node.graph_properties
        nodes.append(
            {
                "id": node.id,
                "type": node.graph_type,
                "name": node.graph_display_name,
                "properties": props if props else {},
            }
        )

        for child_rel in node.children:
            queue.append(child_rel.target)

            # Direction determines edge orientation
            if child_rel.direction == "incoming":
                source_id = child_rel.target.id
                target_id = node.id
            else:
                source_id = node.id
                target_id = child_rel.target.id

            rel_props = child_rel.graph_properties
            rels.append(
                {
                    "id": f"rel-{uuid.uuid4().hex[:12]}",
                    "type": _normalize_rel_type(child_rel.relationship),
                    "source_id": source_id,
                    "target_id": target_id,
                    "properties": rel_props if rel_props else {},
                }
            )

    return nodes, rels
