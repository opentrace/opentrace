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

"""Cross-document entity merge for LLM-extracted nodes.

After per-file LLM extraction, the same concept named in multiple files
produces multiple nodes — one per ``{stem}_{entity}`` ID. This module
collapses those duplicates by grouping nodes that share a normalised
label and type, then rewriting edges to point at a canonical node.

Two safety rails:

* **Same-type rule.** Only nodes of identical ``type`` may merge. This
  prevents generic-name collisions like ``Cluster:Idea`` (graph community)
  vs ``Cluster:Service`` (Kubernetes cluster) from collapsing into one.
* **Allowlist by type.** Only the LLM-extracted entity types
  (``Idea``, ``Service``, ``Module``, ``Paper``, ``Person``, ``Event``)
  participate. AST-extracted nodes (``File``, ``Class``, ``Function``)
  already have deterministic structural IDs and are passed through.

Edges are dedup'd post-rewrite. ``DERIVED_FROM`` keeps every distinct
``(source, target)`` so a merged node retains provenance for every file
that mentioned it; semantic edges collapse on
``(source, target, relation)`` keeping the highest ``confidence_score``.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

from opentrace_agent.pipeline.types import GraphNode, GraphRelationship


# LLM-extracted entity types participate in the merge. Other types
# (File, Class, Function, etc.) have deterministic AST-derived IDs.
MERGEABLE_TYPES: frozenset[str] = frozenset({"Idea", "Service", "Module", "Paper", "Person", "Event"})


_PARENTHETICAL = re.compile(r"\s*\([^)]*\)\s*")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def canonical_key(label: str) -> str:
    """Normalise a label so trivial variants collapse to one key.

    Lowercases, strips parenthetical clarifications, collapses any run of
    non-alphanumeric characters to a single space, trims. So
    ``"Autoprune"``, ``"autoprune"``, and ``"Autoprune (stale-page
    stamping on source removal)"`` all map to ``"autoprune"``.
    """
    s = label.lower()
    s = _PARENTHETICAL.sub(" ", s)
    s = _NON_ALNUM.sub(" ", s)
    return " ".join(s.split())


@dataclass
class MergeStats:
    """Counters surfaced by :func:`merge_entities` for telemetry/logging."""

    groups_considered: int = 0
    nodes_merged: int = 0
    edges_rewritten: int = 0
    edges_deduped: int = 0


def _pick_canonical(members: list[GraphNode]) -> GraphNode:
    """Select the representative node for a merge group.

    Prefers the longest label (most descriptive). Ties broken by ID order
    so the choice is stable across runs.
    """
    return sorted(members, key=lambda n: (-len(n.name), n.id))[0]


def merge_entities(
    nodes: list[GraphNode],
    relationships: list[GraphRelationship],
) -> tuple[list[GraphNode], list[GraphRelationship], MergeStats]:
    """Collapse duplicate LLM-extracted entities and rewrite their edges.

    Returns the deduped node list, rewritten + deduped relationship list,
    and a :class:`MergeStats` for callers that want to surface what
    happened (e.g. in a pipeline progress event).
    """
    stats = MergeStats()

    # Partition: mergeable LLM entities vs everything else.
    mergeable: list[GraphNode] = []
    pass_through: list[GraphNode] = []
    for n in nodes:
        if n.type in MERGEABLE_TYPES:
            mergeable.append(n)
        else:
            pass_through.append(n)

    # Group by (type, canonical_key). Same-type rule lives here.
    groups: dict[tuple[str, str], list[GraphNode]] = defaultdict(list)
    for n in mergeable:
        groups[(n.type, canonical_key(n.name))].append(n)

    # Build id remap and canonical node list.
    id_remap: dict[str, str] = {}
    canonical_nodes: list[GraphNode] = []
    for members in groups.values():
        stats.groups_considered += 1
        canonical = _pick_canonical(members)
        canonical_nodes.append(canonical)
        for m in members:
            id_remap[m.id] = canonical.id
            if m.id != canonical.id:
                stats.nodes_merged += 1

    # Rewrite edges through the remap. IDs of pass-through nodes are not
    # in the remap, so .get(id, id) leaves them untouched.
    rewritten: list[GraphRelationship] = []
    for r in relationships:
        new_source = id_remap.get(r.source_id, r.source_id)
        new_target = id_remap.get(r.target_id, r.target_id)
        if new_source != r.source_id or new_target != r.target_id:
            stats.edges_rewritten += 1
        rewritten.append(
            GraphRelationship(
                id=r.id,
                type=r.type,
                source_id=new_source,
                target_id=new_target,
                properties=r.properties,
            )
        )

    # Dedupe. DERIVED_FROM keeps all (source, target) so provenance to
    # every source file survives. Semantic edges collapse on
    # (source, target, relation) keeping highest confidence_score.
    by_key: dict[tuple, GraphRelationship] = {}
    for r in rewritten:
        if r.type == "SEMANTIC_EDGE":
            relation = (r.properties or {}).get("relation", "")
            key = ("SEMANTIC_EDGE", r.source_id, r.target_id, relation)
            existing = by_key.get(key)
            if existing is None:
                by_key[key] = r
            else:
                new_score = float((r.properties or {}).get("confidence_score") or 0.0)
                old_score = float((existing.properties or {}).get("confidence_score") or 0.0)
                if new_score > old_score:
                    by_key[key] = r
                stats.edges_deduped += 1
        else:
            # DERIVED_FROM and anything else: dedupe on (type, source, target).
            key = (r.type, r.source_id, r.target_id)
            if key in by_key:
                stats.edges_deduped += 1
            else:
                by_key[key] = r

    deduped_rels = list(by_key.values())
    final_nodes = pass_through + canonical_nodes
    return final_nodes, deduped_rels, stats
