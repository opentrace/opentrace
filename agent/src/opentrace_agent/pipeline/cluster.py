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

"""Community detection over the OpenTrace graph.

Leiden via graspologic is preferred; falls back to Louvain via networkx when
graspologic isn't available (e.g. Python ≥3.13 where graspologic doesn't
build). Both produce a partition of node IDs into communities.

``detect_communities(graph)`` is pure — networkx in, ``Community`` list out,
no store access. Community size is bounded at ``OVERSIZE_SHARE`` of the
graph (a well-connected document can otherwise drag everything into one
blob): on the Leiden path the bound is enforced natively by
``hierarchical_leiden(max_cluster_size=...)``, which recursively
re-partitions any community over the cap; the Louvain fallback has no such
parameter, so it gets one explicit subdivision sweep instead. A second sweep
subdivides large-but-sparse communities below ``SPARSE_COHESION_CEILING``
(usually several real groups bridged by hub nodes). Each surviving community
gets a cohesion score (intra-community edge density) and the biggest few are
flagged ``is_god``. ``run_clustering`` wraps the store round-trip.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Callable

logger = logging.getLogger(__name__)

# Sizing thresholds. The community-size cap is OVERSIZE_SHARE of the graph,
# but never below MEMBER_CAP_FLOOR — splitting tiny communities produces
# noise, not structure. A community is also re-partitioned when it has at
# least SPARSE_MIN_MEMBERS members but its edge density sits under
# SPARSE_COHESION_CEILING. The top GOD_RANK_SHARE of communities by member
# count are flagged as god communities.
OVERSIZE_SHARE = 0.25
MEMBER_CAP_FLOOR = 10
SPARSE_COHESION_CEILING = 0.05
SPARSE_MIN_MEMBERS = 50
GOD_RANK_SHARE = 0.10


@dataclass(frozen=True)
class Community:
    """A detected community: integer id + the node ids that belong to it."""

    id: int
    members: tuple[str, ...]
    cohesion: float
    is_god: bool


def _import_networkx():
    try:
        import networkx as nx  # type: ignore[import-not-found]

        return nx
    except ImportError as exc:
        raise RuntimeError("networkx not installed. Run: uv pip install 'opentraceai[graph]'") from exc


def _try_leiden(graph, member_cap: int) -> dict[Any, int] | None:
    """Run Leiden via graspologic. Returns None if unavailable.

    ``member_cap`` is handed to graspologic as ``max_cluster_size``: any
    community whose membership exceeds it gets its own induced subnetwork,
    is re-partitioned, and the result is folded back into the overall map —
    recursively, until nothing exceeds the cap. ``final_level_hierarchical_clustering``
    is the per-node assignment after all of that (communities that never
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
    communities = nx.community.louvain_communities(graph, seed=42)
    partition: dict[Any, int] = {}
    for cid, members in enumerate(communities):
        for node in members:
            partition[node] = cid
    return partition


def _group_partition(partition: dict[Any, int]) -> list[list[Any]]:
    """Turn a node→community-id mapping into member lists."""
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
    """Partition one community's induced subgraph into smaller ones.

    A community the algorithm can't break apart comes back unchanged as a
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


def detect_communities(graph) -> list[Community]:
    """Partition a networkx Graph into size-bounded communities.

    Pure function — does not touch the store. Output is ordered by member
    count, largest first; ids are the position in that order.
    """
    nx = _import_networkx()
    if not isinstance(graph, nx.Graph):
        raise TypeError("detect_communities requires a networkx.Graph")
    if graph.number_of_nodes() == 0:
        return []

    member_cap = max(MEMBER_CAP_FLOOR, int(graph.number_of_nodes() * OVERSIZE_SHARE))

    partition = _try_leiden(graph, member_cap)
    if partition is not None:
        # The size cap was enforced inside hierarchical Leiden.
        groups = _group_partition(partition)
    else:
        # Louvain can't bound community size itself — sweep once afterwards.
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
        Community(
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
    communities: int
    god_communities: int
    largest_community: int
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


def _community_label(members: list[dict[str, Any]]) -> str:
    """Cheap deterministic label until LLM labelling is wired in.

    Named after the community's two most-connected members (callers pass
    ``members`` ordered by degree) so listings read as content —
    ``"auth_service, login_handler +60"`` — rather than bookkeeping. The
    :mod:`pipeline.labels` module (added later) will replace this with an
    LLM call.
    """
    if not members:
        return "empty community"
    hubs = [_short_member_name(m) for m in members[:2]]
    label = ", ".join(hubs)
    remainder = len(members) - len(hubs)
    return f"{label} +{remainder}" if remainder > 0 else label


def run_clustering(store) -> ClusterReport:  # type: ignore[no-untyped-def]
    """End-to-end: read graph → detect communities → write back.

    Idempotent: clears existing Community nodes + memberships before writing.
    """
    g = build_graph_from_store(store)
    n_nodes = g.number_of_nodes()
    n_edges = g.number_of_edges()
    if n_nodes == 0:
        return ClusterReport(0, 0, 0, 0, 0, 0.0)

    communities = detect_communities(g)

    store.clear_communities()

    # Quick name lookup by id for label generation.
    node_lookup: dict[str, dict[str, Any]] = {n: g.nodes[n] for n in g.nodes}

    god_count = 0
    largest = 0
    cohesion_sum = 0.0
    for c in communities:
        members_info = [
            {"id": nid, "type": node_lookup[nid].get("type", ""), "name": node_lookup[nid].get("name", "")}
            for nid in c.members
            if nid in node_lookup
        ]
        # Most-connected members first — the label is derived from the top two.
        members_info.sort(key=lambda m: g.degree(m["id"]), reverse=True)
        community_id_str = f"_comm:{c.id}"
        store.save_community(
            id=community_id_str,
            name=_community_label(members_info),
            community_id=c.id,
            cohesion=c.cohesion,
            members=len(c.members),
            is_god=c.is_god,
        )
        for nid in c.members:
            store.save_membership(
                id=f"_mem:{c.id}:{nid}",
                node_id=nid,
                community_id=community_id_str,
            )
        if c.is_god:
            god_count += 1
        largest = max(largest, len(c.members))
        cohesion_sum += c.cohesion

    mean_cohesion = cohesion_sum / len(communities) if communities else 0.0
    return ClusterReport(
        nodes=n_nodes,
        edges=n_edges,
        communities=len(communities),
        god_communities=god_count,
        largest_community=largest,
        mean_cohesion=mean_cohesion,
    )
