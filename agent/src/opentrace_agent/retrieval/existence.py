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

"""Existence/non-existence queries: ``find_orphans``."""

from __future__ import annotations

from typing import Any

from opentrace_agent.store import GraphStore

DEFAULT_ORPHAN_LIMIT = 1000
ORPHAN_LIMIT_CAP = 10000


def find_orphans(
    store: GraphStore,
    node_type: str,
    edge_type: str,
    direction: str = "incoming",
    limit: int = DEFAULT_ORPHAN_LIMIT,
) -> dict[str, Any]:
    """Find nodes of *node_type* that have no edges of *edge_type* in the
    given *direction*.

    Two-query Python composition rather than ``WHERE NOT pattern`` Cypher
    (unconfirmed dialect support). First query lists candidate nodes; second
    lists endpoints of edges with the given type in the given direction; the
    set difference is the orphan set.

    Parameters
    ----------
    direction : {'incoming', 'outgoing', 'both'}
        ``'incoming'`` → nodes with no incoming edges of this type (e.g.
        Functions never called). ``'outgoing'`` → nodes with no outgoing
        edges of this type. ``'both'`` → no edges of this type in either
        direction.

    Returns
    -------
    dict
        ``{"orphans": [{"id", "type", "name"}, …], "count": N}``
    """
    if direction not in ("incoming", "outgoing", "both"):
        raise ValueError(f"invalid direction: {direction!r}; expected 'incoming', 'outgoing', or 'both'")
    limit = max(1, min(limit, ORPHAN_LIMIT_CAP))

    # Query 1: every node of the requested type.
    candidates = store._conn.execute(
        "MATCH (n:Node {type: $type}) RETURN n.id, n.name",
        parameters={"type": node_type},
    )
    candidate_rows: list[tuple[str, str]] = []
    while candidates.has_next():
        row = candidates.get_next()
        candidate_rows.append((str(row[0]), str(row[1])))

    if not candidate_rows:
        return {"orphans": [], "count": 0}

    # Query 2: endpoint ids of edges with the given type in the given direction.
    bound: set[str] = set()
    if direction in ("incoming", "both"):
        # Nodes that are TARGETS of edges with this type are NOT orphans w.r.t. incoming.
        result = store._conn.execute(
            "MATCH (a:Node)-[r:RELATES]->(b:Node) WHERE r.type = $edge_type RETURN b.id",
            parameters={"edge_type": edge_type},
        )
        while result.has_next():
            bound.add(str(result.get_next()[0]))
    if direction in ("outgoing", "both"):
        # Nodes that are SOURCES of edges with this type are NOT orphans w.r.t. outgoing.
        result = store._conn.execute(
            "MATCH (a:Node)-[r:RELATES]->(b:Node) WHERE r.type = $edge_type RETURN a.id",
            parameters={"edge_type": edge_type},
        )
        while result.has_next():
            bound.add(str(result.get_next()[0]))

    orphans: list[dict[str, str]] = []
    for nid, nname in candidate_rows:
        if nid in bound:
            continue
        orphans.append({"id": nid, "type": node_type, "name": nname})
        if len(orphans) >= limit:
            break

    return {"orphans": orphans, "count": len(orphans)}
