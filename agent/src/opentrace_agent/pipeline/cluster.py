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

"""Clustering over the OpenTrace graph.

Leiden via graspologic is preferred; falls back to Louvain via networkx when
graspologic isn't available (e.g. Python ≥3.13 where graspologic doesn't
build). Both are community-detection algorithms in the graph-theory sense;
their output — a partition of node IDs — is what OpenTrace calls *clusters*.
(The UI's unrelated viewer-local "communities" feature is a different thing;
see ``ui/CLAUDE.md``.)

``detect_clusters(graph)`` is pure — networkx in, ``Cluster`` list out,
no store access. Cluster size is bounded at ``OVERSIZE_SHARE`` of the
graph (a well-connected document can otherwise drag everything into one
blob): on the Leiden path the bound is enforced natively by
``hierarchical_leiden(max_cluster_size=...)``, which recursively
re-partitions any cluster over the cap; the Louvain fallback has no such
parameter, so it gets one explicit subdivision sweep instead. A second sweep
subdivides large-but-sparse clusters below ``SPARSE_COHESION_CEILING``
(usually several real groups bridged by hub nodes). Each surviving cluster
gets a cohesion score (intra-cluster edge density) and the biggest few are
flagged ``is_god``. ``run_clustering`` wraps the store round-trip.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Callable

logger = logging.getLogger(__name__)

# Sizing thresholds. The cluster-size cap is OVERSIZE_SHARE of the graph,
# but never below MEMBER_CAP_FLOOR — splitting tiny clusters produces
# noise, not structure. A cluster is also re-partitioned when it has at
# least SPARSE_MIN_MEMBERS members but its edge density sits under
# SPARSE_COHESION_CEILING. The top GOD_RANK_SHARE of clusters by member
# count are flagged as god clusters.
OVERSIZE_SHARE = 0.25
MEMBER_CAP_FLOOR = 10
SPARSE_COHESION_CEILING = 0.05
SPARSE_MIN_MEMBERS = 50
GOD_RANK_SHARE = 0.10


@dataclass(frozen=True)
class Cluster:
    """A detected cluster: integer id + the node ids that belong to it."""

    id: int
    members: tuple[str, ...]
    cohesion: float
    is_god: bool


def _import_networkx():
    try:
        import networkx as nx  # type: ignore[import-not-found]

        return nx
    except ImportError as exc:
        raise RuntimeError(
            "networkx not installed. It is a core dependency — reinstall opentraceai, "
            "or `uv pip install networkx` into the active environment."
        ) from exc


def _try_leiden(graph, member_cap: int) -> dict[Any, int] | None:
    """Run Leiden via graspologic. Returns None if unavailable.

    ``member_cap`` is handed to graspologic as ``max_cluster_size``: any
    cluster whose membership exceeds it gets its own induced subnetwork,
    is re-partitioned, and the result is folded back into the overall map —
    recursively, until nothing exceeds the cap. ``final_level_hierarchical_clustering``
    is the per-node assignment after all of that (clusters that never
    needed splitting only appear at level 0, so reading any single level
    would drop nodes).
    """
    try:
        from graspologic.partition import hierarchical_leiden  # type: ignore[import-not-found]
    except ImportError:
        return None
    try:
        result = hierarchical_leiden(graph, max_cluster_size=member_cap, random_seed=42)
        return result.final_level_hierarchical_clustering()
    except Exception as exc:  # noqa: BLE001
        logger.info("Leiden failed (%s); falling back to Louvain", exc)
        return None


def _louvain(graph) -> dict[Any, int]:
    """Louvain via networkx (always available). Deterministic via seed."""
    nx = _import_networkx()
    groups = nx.community.louvain_communities(graph, seed=42)
    partition: dict[Any, int] = {}
    for cid, members in enumerate(groups):
        for node in members:
            partition[node] = cid
    return partition


def _group_partition(partition: dict[Any, int]) -> list[list[Any]]:
    """Turn a node→cluster-id mapping into member lists."""
    grouped: defaultdict[int, list[Any]] = defaultdict(list)
    for node, cid in partition.items():
        grouped[cid].append(node)
    return list(grouped.values())


def _cohesion(graph, members: list[Any]) -> float:
    """Edge density of the subgraph induced by ``members``.

    Defined as 0.0 below two members, where density is degenerate.
    """
    if len(members) < 2:
        return 0.0
    return _import_networkx().density(graph.subgraph(members))


def _subdivide(graph, members: list[Any], member_cap: int) -> list[list[Any]]:
    """Partition one cluster's induced subgraph into smaller ones.

    Tries Leiden on the subgraph first and only falls back to Louvain, exactly
    as the top-level pass does. So the "Louvain fallback" is a hybrid whenever
    graspologic is installed but the top-level Leiden call returned nothing:
    Louvain partitions the whole graph, then Leiden re-partitions the oversized
    and sparse clusters. Both paths therefore converge on the same
    subdivision behaviour, which is why only the top-level algorithm is
    reported.

    A cluster the algorithm can't break apart comes back unchanged as a
    single-element list, so callers can splice the result in unconditionally.
    """
    if len(members) < 2:
        return [members]
    sub = graph.subgraph(members)
    parts = _group_partition(_try_leiden(sub, member_cap) or _louvain(sub))
    return parts if len(parts) > 1 else [members]


def _sweep(
    graph, groups: list[list[Any]], should_split: Callable[[list[Any]], bool], member_cap: int
) -> list[list[Any]]:
    """One refinement sweep: subdivide every group that ``should_split``."""
    refined: list[list[Any]] = []
    for members in groups:
        refined.extend(_subdivide(graph, members, member_cap) if should_split(members) else [members])
    return refined


def detect_clusters(graph) -> list[Cluster]:
    """Partition a networkx Graph into size-bounded clusters.

    Pure function — does not touch the store. Output is ordered by member
    count, largest first; ids are the position in that order.
    """
    nx = _import_networkx()
    if not isinstance(graph, nx.Graph):
        raise TypeError("detect_clusters requires a networkx.Graph")
    if graph.number_of_nodes() == 0:
        return []

    member_cap = max(MEMBER_CAP_FLOOR, int(graph.number_of_nodes() * OVERSIZE_SHARE))

    partition = _try_leiden(graph, member_cap)
    if partition is not None:
        # The size cap was enforced inside hierarchical Leiden.
        groups = _group_partition(partition)
    else:
        # Louvain can't bound cluster size itself — sweep once afterwards.
        groups = _sweep(graph, _group_partition(_louvain(graph)), lambda m: len(m) > member_cap, member_cap)

    groups = _sweep(
        graph,
        groups,
        lambda m: len(m) >= SPARSE_MIN_MEMBERS and _cohesion(graph, m) < SPARSE_COHESION_CEILING,
        member_cap,
    )

    ranked = sorted(groups, key=len, reverse=True)
    god_cutoff = max(1, int(len(ranked) * GOD_RANK_SHARE))
    return [
        Cluster(
            id=rank,
            members=tuple(str(m) for m in members),
            cohesion=_cohesion(graph, members),
            is_god=rank < god_cutoff,
        )
        for rank, members in enumerate(ranked)
    ]


# ---------------------------------------------------------------------------
# Store round-trip
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ClusterReport:
    """Summary of a clustering run."""

    nodes: int
    edges: int
    clusters: int
    god_clusters: int
    largest_cluster: int
    mean_cohesion: float


def build_graph_from_store(store) -> Any:  # type: ignore[no-untyped-def]
    """Read the store's analytical graph into a networkx undirected Graph."""
    nx = _import_networkx()
    nodes, edges = store.iter_analysis_graph()
    g = nx.Graph()
    for n in nodes:
        g.add_node(n["id"], type=n["type"], name=n["name"])
    for src, tgt in edges:
        if g.has_node(src) and g.has_node(tgt) and src != tgt:
            g.add_edge(src, tgt)
    return g


def _short_member_name(member: dict[str, Any]) -> str:
    """A label-sized member name.

    Collapses whitespace (tree-sitter occasionally captures a full multi-line
    declaration as the symbol name), strips signature noise from code symbols
    so ``def foo(a, b):`` labels as ``foo``, and clips the rest.
    """
    name = " ".join(str(member.get("name") or member["id"]).split())
    if member.get("type") in {"Function", "Method", "Class"}:
        if "(" in name:
            name = name.split("(", 1)[0].rstrip()
        for prefix in ("async def ", "def ", "class "):
            if name.startswith(prefix):
                name = name[len(prefix) :].lstrip()
                break
    return name[:40]


def _cluster_label(members: list[dict[str, Any]]) -> str:
    """Cheap deterministic label until LLM labelling is wired in.

    Named after the cluster's two most-connected members (callers pass
    ``members`` ordered by degree) so listings read as content —
    ``"auth_service, login_handler +60"`` — rather than bookkeeping. The
    :mod:`pipeline.labels` module (added later) will replace this with an
    LLM call.
    """
    if not members:
        return "empty cluster"
    hubs = [_short_member_name(m) for m in members[:2]]
    label = ", ".join(hubs)
    remainder = len(members) - len(hubs)
    return f"{label} +{remainder}" if remainder > 0 else label


def run_clustering(store) -> ClusterReport:  # type: ignore[no-untyped-def]
    """End-to-end: read graph → detect clusters → stamp the partition back.

    The partition is written as a ``cluster`` property on each member, not as
    Community nodes and membership edges: it is derived from the graph, so it is
    metadata about nodes rather than graph data in its own right. The label,
    cohesion and god flag summarised in the returned report are recomputed on
    read by ``retrieval.clusters`` from the same partition, so nothing has to
    be kept in sync with the members.

    Idempotent: ``assign_clusters`` rewrites every node's assignment.
    """
    # Clear before reading, not just before writing. A database written by the
    # old node-based model still holds Community nodes, and those are ordinary
    # nodes to the reader — partitioning would take clustering's own previous
    # output as input and report an inflated node count for the run.
    store.clear_clusters()

    g = build_graph_from_store(store)
    n_nodes = g.number_of_nodes()
    n_edges = g.number_of_edges()
    if n_nodes == 0:
        return ClusterReport(0, 0, 0, 0, 0, 0.0)

    clusters = detect_clusters(g)

    store.assign_clusters({nid: c.id for c in clusters for nid in c.members})

    god_count = 0
    largest = 0
    cohesion_sum = 0.0
    for c in clusters:
        if c.is_god:
            god_count += 1
        largest = max(largest, len(c.members))
        cohesion_sum += c.cohesion

    mean_cohesion = cohesion_sum / len(clusters) if clusters else 0.0
    return ClusterReport(
        nodes=n_nodes,
        edges=n_edges,
        clusters=len(clusters),
        god_clusters=god_count,
        largest_cluster=largest,
        mean_cohesion=mean_cohesion,
    )
