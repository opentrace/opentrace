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

"""Aggregation queries: ``count_by``."""

from __future__ import annotations

from typing import Any

from opentrace_agent.store import GraphStore

COUNT_BY_DEFAULT_HOPS = 3
COUNT_BY_HOPS_CAP = 5


def count_by(
    store: GraphStore,
    node_type: str,
    parent_id: str | None = None,
    parent_edge: str = "CONTAINS",
    max_hops: int = COUNT_BY_DEFAULT_HOPS,
) -> dict[str, Any]:
    """Count nodes of *node_type*, optionally scoped to descendants of *parent_id*.

    Without ``parent_id``: a single ``MATCH ... count()`` query.
    With ``parent_id``: walks outgoing edges of type *parent_edge* up to
    *max_hops* (Python-composed via :meth:`GraphStore.traverse`) and counts
    descendants whose type matches *node_type*. Reachability rather than
    direct adjacency.

    Returns
    -------
    dict
        ``{"count": N, "node_type": str, "scope": "global" | f"descendants_of:{parent_id}"}``
    """
    if parent_id is None:
        result = store._conn.execute(
            "MATCH (n:Node {type: $type}) RETURN count(n)",
            parameters={"type": node_type},
        )
        total = 0
        if result.has_next():
            total = int(result.get_next()[0])
        return {"count": total, "node_type": node_type, "scope": "global"}

    if store.get_node(parent_id) is None:
        return {
            "count": 0,
            "node_type": node_type,
            "scope": f"descendants_of:{parent_id}",
            "error": f"parent node not found: {parent_id}",
        }

    max_hops = max(1, min(max_hops, COUNT_BY_HOPS_CAP))
    descendants = store.traverse(
        parent_id,
        direction="outgoing",
        max_depth=max_hops,
        relationship_type=parent_edge,
    )
    matching = sum(1 for r in descendants if r["node"]["type"] == node_type)
    return {
        "count": matching,
        "node_type": node_type,
        "scope": f"descendants_of:{parent_id}",
    }
