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

"""Knowledge-graph highlights — communities, god nodes, bridges.

Thin typed helpers on top of the equivalent ``GraphStore`` methods. Lives
here so the retrieval/ surface owns the API for MCP / REST / UI clients,
matching the convention already established by ``search``, ``overview``,
``paths``, etc. The underlying Cypher still lives in ``graph_store.py``
because these queries depend on internal label / rel-type constants.

A community is stored as the ``community`` id on each member, so the summary
a caller wants — label, member count, cohesion, god flag — is *derived* here
from the partition rather than read back from a persisted row. Deriving is
what keeps the summary honest: there is no second copy of the member count to
drift from the members, and no orphaned summary left behind when a re-cluster
moves nodes around.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from opentrace_agent.store import GraphStore


def _summarize(store: GraphStore) -> tuple[list[dict[str, Any]], dict[int, str]]:
    """Derive every community's summary from the stored partition.

    Returns ``(rows, labels_by_id)``. Cohesion and the god flag are recomputed
    with the same definitions ``pipeline.cluster`` used when it partitioned the
    graph, so a summary read back matches the run that produced it.
    """
    from opentrace_agent.pipeline.cluster import GOD_RANK_SHARE, _community_label
    from opentrace_agent.store.graph_store import GraphStore as _Store

    nodes, edges = store.iter_analysis_graph()
    key = _Store.COMMUNITY_PROPERTY

    members_by_community: dict[int, list[dict[str, Any]]] = defaultdict(list)
    community_of: dict[str, int] = {}
    for node in nodes:
        community = node.get(key)
        if community is None:
            continue
        community_of[node["id"]] = int(community)
        members_by_community[int(community)].append(node)
    if not members_by_community:
        return [], {}

    degree: dict[str, int] = defaultdict(int)
    intra_edges: dict[int, int] = defaultdict(int)
    for source, target in edges:
        degree[source] += 1
        degree[target] += 1
        source_community = community_of.get(source)
        if source_community is not None and source_community == community_of.get(target):
            intra_edges[source_community] += 1

    # God communities are the top GOD_RANK_SHARE by member count, matching
    # detect_communities' ranking.
    ranked = sorted(members_by_community, key=lambda cid: len(members_by_community[cid]), reverse=True)
    god_cutoff = max(1, int(len(ranked) * GOD_RANK_SHARE))
    gods = set(ranked[:god_cutoff])

    rows: list[dict[str, Any]] = []
    labels: dict[int, str] = {}
    for community_id, members in sorted(members_by_community.items()):
        members.sort(key=lambda m: degree[m["id"]], reverse=True)
        label = _community_label(members)
        labels[community_id] = label
        size = len(members)
        possible = size * (size - 1) / 2
        rows.append(
            {
                "id": community_id,
                "community_id": community_id,
                "name": label,
                "members": size,
                "cohesion": (intra_edges[community_id] / possible) if possible else 0.0,
                "is_god": community_id in gods,
            }
        )
    return rows, labels


def list_communities(store: GraphStore) -> list[dict[str, Any]]:
    """Return every detected community, ordered by community id."""
    rows, _ = _summarize(store)
    return rows


def god_nodes(
    store: GraphStore,
    limit: int = 20,
    exclude_types: tuple[str, ...] = (),
) -> list[dict[str, Any]]:
    """Return the top-degree non-synthetic nodes — centrality hubs."""
    return store.list_god_nodes(limit=limit, exclude_types=exclude_types)


def cross_community_bridges(
    store: GraphStore,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return edges whose endpoints belong to different communities.

    The store compares the two endpoints' community ids; the labels are joined
    on here, where the derived summary lives.
    """
    bridges = store.list_cross_community_bridges(limit=limit)
    if not bridges:
        return []
    _, labels = _summarize(store)
    for bridge in bridges:
        for end in ("source", "target"):
            community_id = bridge[f"{end}_community_id"]
            bridge[f"{end}_community_name"] = labels.get(community_id, str(community_id))
    return bridges
