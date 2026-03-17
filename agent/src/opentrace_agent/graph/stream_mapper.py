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

"""Stream mapper: BFS walks trees and yields batched RunJobEvent messages.

Instead of saving nodes via MCP, this mapper collects all nodes first, then all
relationships, and streams them as proto events. This guarantees referential
integrity (nodes exist before relationships reference them).
"""

from __future__ import annotations

import json
import logging
import uuid
from collections import deque
from typing import Iterator

from opentrace_agent.gen.opentrace.v1 import agent_service_pb2 as pb2
from opentrace_agent.models.base import BaseTreeNode, TreeWithOrigin

logger = logging.getLogger(__name__)

BATCH_SIZE = 50

# Relationship type normalization (handles legacy snake_case + special aliases)
_REL_TYPE_MAP = {
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
    """Normalize a relationship type to UPPER_SNAKE_CASE."""
    return _REL_TYPE_MAP.get(rel_type, rel_type.upper())


def stream_trees(trees: list[TreeWithOrigin]) -> Iterator[pb2.RunJobEvent]:
    """Walk all trees via BFS, yielding RunJobEvent batches.

    Phase 1: Yield all nodes in batches of BATCH_SIZE.
    Phase 2: Yield all relationships in batches of BATCH_SIZE.
    """
    all_nodes: list[pb2.IndexedNode] = []
    all_rels: list[pb2.IndexedRelationship] = []

    for tree in trees:
        _collect_tree(tree.root, all_nodes, all_rels)

    logger.info(
        "Stream mapper collected %d nodes, %d relationships from %d tree(s)",
        len(all_nodes),
        len(all_rels),
        len(trees),
    )

    # Yield node batches.
    for i in range(0, len(all_nodes), BATCH_SIZE):
        batch = all_nodes[i : i + BATCH_SIZE]
        yield pb2.RunJobEvent(
            phase=pb2.JOB_PHASE_MAPPING,
            message=f"Streaming nodes {i + 1}-{i + len(batch)} of {len(all_nodes)}",
            nodes=batch,
        )

    # Yield relationship batches.
    for i in range(0, len(all_rels), BATCH_SIZE):
        batch = all_rels[i : i + BATCH_SIZE]
        yield pb2.RunJobEvent(
            phase=pb2.JOB_PHASE_MAPPING,
            message=f"Streaming relationships {i + 1}-{i + len(batch)} of {len(all_rels)}",
            relationships=batch,
        )


def _collect_tree(
    root: BaseTreeNode,
    nodes: list[pb2.IndexedNode],
    rels: list[pb2.IndexedRelationship],
) -> None:
    """BFS walk a tree, collecting nodes and relationships."""
    queue: deque[BaseTreeNode] = deque([root])
    visited: set[str] = set()

    while queue:
        node = queue.popleft()
        if node.id in visited:
            continue
        visited.add(node.id)

        # Collect the node.
        props = node.graph_properties
        nodes.append(
            pb2.IndexedNode(
                id=node.id,
                type=node.graph_type,
                name=node.graph_display_name,
                properties_json=json.dumps(props) if props else "{}",
            )
        )

        # Process children.
        for child_rel in node.children:
            queue.append(child_rel.target)

            # Determine relationship direction.
            if child_rel.direction == "incoming":
                source_id = child_rel.target.id
                target_id = node.id
            else:
                source_id = node.id
                target_id = child_rel.target.id

            rel_props = child_rel.graph_properties
            rels.append(
                pb2.IndexedRelationship(
                    id=f"rel-{uuid.uuid4().hex[:12]}",
                    type=_normalize_rel_type(child_rel.relationship),
                    source_id=source_id,
                    target_id=target_id,
                    properties_json=json.dumps(rel_props) if rel_props else "{}",
                )
            )
