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

"""Knowledge-graph highlights — clusters, god nodes, bridges.

Thin typed helpers on top of the equivalent ``GraphStore`` methods. Lives
here so the retrieval/ surface owns the API for MCP / REST / UI clients,
matching the convention already established by ``search``, ``overview``,
``paths``, etc. The underlying Cypher still lives in ``graph_store.py``
because these queries depend on internal label / rel-type constants.

A cluster is stored as the ``cluster`` id on each member, so the summary
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
    """Derive every cluster's summary from the stored partition.

    Returns ``(rows, labels_by_id)``. Cohesion and the god flag are recomputed
    with the same definitions ``pipeline.cluster`` used when it partitioned the
    graph, so a summary read back matches the run that produced it.
    """
    from opentrace_agent.pipeline.cluster import GOD_RANK_SHARE, _cluster_label
    from opentrace_agent.store.graph_store import GraphStore as _Store

    nodes, edges = store.iter_analysis_graph()
    key = _Store.CLUSTER_PROPERTY

    members_by_cluster: dict[int, list[dict[str, Any]]] = defaultdict(list)
    cluster_of: dict[str, int] = {}
    for node in nodes:
        cluster = node.get(key)
        if cluster is None:
            continue
        cluster_of[node["id"]] = int(cluster)
        members_by_cluster[int(cluster)].append(node)
    if not members_by_cluster:
        return [], {}

    degree: dict[str, int] = defaultdict(int)
    intra_edges: dict[int, int] = defaultdict(int)
    for source, target in edges:
        degree[source] += 1
        degree[target] += 1
        source_cluster = cluster_of.get(source)
        if source_cluster is not None and source_cluster == cluster_of.get(target):
            intra_edges[source_cluster] += 1

    # God clusters are the top GOD_RANK_SHARE by member count, matching
    # detect_clusters' ranking.
    ranked = sorted(members_by_cluster, key=lambda cid: len(members_by_cluster[cid]), reverse=True)
    god_cutoff = max(1, int(len(ranked) * GOD_RANK_SHARE))
    gods = set(ranked[:god_cutoff])

    rows: list[dict[str, Any]] = []
    labels: dict[int, str] = {}
    for cluster_id, members in sorted(members_by_cluster.items()):
        members.sort(key=lambda m: degree[m["id"]], reverse=True)
        label = _cluster_label(members)
        labels[cluster_id] = label
        size = len(members)
        possible = size * (size - 1) / 2
        rows.append(
            {
                "id": cluster_id,
                "cluster_id": cluster_id,
                "name": label,
                "members": size,
                "cohesion": (intra_edges[cluster_id] / possible) if possible else 0.0,
                "is_god": cluster_id in gods,
            }
        )
    return rows, labels


def list_clusters(store: GraphStore) -> list[dict[str, Any]]:
    """Return every detected cluster, ordered by cluster id."""
    rows, _ = _summarize(store)
    return rows


def god_nodes(
    store: GraphStore,
    limit: int = 20,
    exclude_types: tuple[str, ...] = (),
) -> list[dict[str, Any]]:
    """Return the top-degree non-synthetic nodes — centrality hubs."""
    return store.list_god_nodes(limit=limit, exclude_types=exclude_types)


def cross_cluster_bridges(
    store: GraphStore,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return edges whose endpoints belong to different clusters.

    The store compares the two endpoints' cluster ids; the labels are joined
    on here, where the derived summary lives.
    """
    bridges = store.list_cross_cluster_bridges(limit=limit)
    if not bridges:
        return []
    _, labels = _summarize(store)
    for bridge in bridges:
        for end in ("source", "target"):
            cluster_id = bridge[f"{end}_cluster_id"]
            bridge[f"{end}_cluster_name"] = labels.get(cluster_id, str(cluster_id))
    return bridges
