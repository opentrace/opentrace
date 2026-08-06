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

"""Path-shaped retrieval queries: ``find_path`` and ``find_via_relationship_to_type``."""

from __future__ import annotations

from collections import deque
from typing import Any

from opentrace_agent.store import GraphStore

MAX_HOPS_CAP = 10
DEFAULT_PAIR_LIMIT = 100
PAIR_LIMIT_CAP = 1000


def find_path(
    store: GraphStore,
    start_id: str,
    end_id: str,
    max_hops: int = 5,
    edge_types: list[str] | None = None,
) -> dict[str, Any]:
    """Find the shortest path between two nodes via Python BFS.

    Composed on top of :meth:`GraphStore._get_neighbors` to avoid relying on
    LadybugDB ``shortestPath`` (unconfirmed dialect support). Walks outgoing
    edges from *start_id* up to *max_hops* and returns the first path that
    reaches *end_id*.

    Returns
    -------
    dict
        ``{"path": [{"node": …, "relationship": …, "depth": N}, …], "length": N}``
        where ``path`` includes the start node at depth 0 and the end node
        last. If no path is found within ``max_hops``, ``path`` is ``None``,
        ``length`` is ``None``, and ``truncated`` says WHY: ``True`` means the
        walk stopped at the hop ceiling with nodes left unexpanded (raising
        ``max_hops`` may find one), ``False`` means the reachable graph was
        exhausted and no path exists. Callers must not collapse these two into
        one message — reporting "no path" for a truncated search tells the user
        something false.
    """
    max_hops = max(1, min(max_hops, MAX_HOPS_CAP))
    edge_filter = set(edge_types) if edge_types else None

    start = store.get_node(start_id)
    if start is None:
        return {"path": None, "length": None, "error": f"start node not found: {start_id}"}
    if store.get_node(end_id) is None:
        return {"path": None, "length": None, "error": f"end node not found: {end_id}"}

    if start_id == end_id:
        return {
            "path": [{"node": start, "relationship": None, "depth": 0}],
            "length": 0,
        }

    # parent[node_id] = (predecessor_id, relationship_to_predecessor)
    parent: dict[str, tuple[str, dict[str, Any]]] = {}
    visited: set[str] = {start_id}
    queue: deque[tuple[str, int]] = deque([(start_id, 0)])

    truncated = False

    while queue:
        curr_id, depth = queue.popleft()
        if depth >= max_hops:
            # Reached the ceiling with this node still unexpanded, so the search
            # is incomplete rather than exhaustive.
            truncated = True
            continue
        # Outgoing-only walk; reversing for incoming paths is a future option.
        for nb_node, nb_rel in store._get_neighbors(curr_id, "outgoing"):
            if edge_filter is not None and nb_rel["type"] not in edge_filter:
                continue
            if nb_node["id"] in visited:
                continue
            visited.add(nb_node["id"])
            parent[nb_node["id"]] = (curr_id, nb_rel)
            if nb_node["id"] == end_id:
                return {
                    "path": _reconstruct_path(store, start_id, end_id, parent),
                    "length": depth + 1,
                }
            queue.append((nb_node["id"], depth + 1))

    return {"path": None, "length": None, "truncated": truncated}


def _reconstruct_path(
    store: GraphStore,
    start_id: str,
    end_id: str,
    parent: dict[str, tuple[str, dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Walk parent pointers back from end → start, then reverse."""
    chain: list[tuple[str, dict[str, Any] | None]] = [(end_id, None)]
    cursor = end_id
    while cursor != start_id:
        pred_id, rel = parent[cursor]
        chain[-1] = (cursor, rel)  # rel is the edge from pred → cursor
        chain.append((pred_id, None))
        cursor = pred_id
    chain.reverse()

    out: list[dict[str, Any]] = []
    for depth, (nid, rel) in enumerate(chain):
        node = store.get_node(nid)
        out.append({"node": node, "relationship": rel, "depth": depth})
    return out


def find_via_relationship_to_type(
    store: GraphStore,
    start_type: str,
    edge_type: str,
    target_type: str,
    limit: int = DEFAULT_PAIR_LIMIT,
) -> dict[str, Any]:
    """Find all (A, B) pairs where A is *start_type*, B is *target_type*, and
    a relationship of *edge_type* points from A to B.

    Single Cypher MATCH with parameterised type values; no allowlist
    substitution because the rel label is the generic ``RELATES`` and the
    actual type is filtered via ``r.type``.

    Returns
    -------
    dict
        ``{"pairs": [{"start": NodeResult, "target": NodeResult}, …], "count": N}``
    """
    limit = max(1, min(limit, PAIR_LIMIT_CAP))

    result = store._conn.execute(
        "MATCH (a:Node {type: $start_type})-[r:RELATES]->(b:Node {type: $target_type}) "
        "WHERE r.type = $edge_type "
        "RETURN a.id, a.type, a.name, a.properties, "
        "       b.id, b.type, b.name, b.properties "
        f"LIMIT {limit}",
        parameters={
            "start_type": start_type,
            "target_type": target_type,
            "edge_type": edge_type,
        },
    )

    from opentrace_agent.store.graph_store import _parse_props

    pairs: list[dict[str, Any]] = []
    while result.has_next():
        vals = result.get_next()
        pairs.append(
            {
                "start": {
                    "id": str(vals[0]),
                    "type": str(vals[1]),
                    "name": str(vals[2]),
                    "properties": _parse_props(vals[3]),
                },
                "target": {
                    "id": str(vals[4]),
                    "type": str(vals[5]),
                    "name": str(vals[6]),
                    "properties": _parse_props(vals[7]),
                },
            }
        )

    return {"pairs": pairs, "count": len(pairs)}
