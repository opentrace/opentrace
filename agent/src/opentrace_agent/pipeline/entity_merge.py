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
label, then rewriting edges to point at a canonical node.

Merging is **cross-type**: per-doc extraction types the same referent
inconsistently ("Werkzeug" is a Service to the changelog and a Module to
the deploy guide), and a same-type-only rule leaves those as duplicate
nodes — each of which then earns its own MENTIONS/DERIVED_FROM edges,
double-counting everything downstream. The group's type is resolved by
majority vote among the members (ties broken by ``_TYPE_PRECEDENCE`` so
runs are stable).

Two safety rails:

* **Person rule.** ``Person`` nodes only merge with other ``Person``
  nodes — a person who shares a name with a product/library ("Click")
  must not collapse into it.
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
from collections import Counter, defaultdict
from dataclasses import dataclass, replace

from opentrace_agent.pipeline.types import GraphNode, GraphRelationship

# LLM-extracted entity types participate in the merge. Other types
# (File, Class, Function, etc.) have deterministic AST-derived IDs.
MERGEABLE_TYPES: frozenset[str] = frozenset({"Idea", "Service", "Module", "Paper", "Person", "Event"})

# Tie-break order for the cross-type majority vote: concrete artefact
# types beat the catch-all Idea, so a 1-1 "Werkzeug is a Service / a
# Module" split resolves to Service rather than whichever id sorts first.
_TYPE_PRECEDENCE: tuple[str, ...] = ("Service", "Module", "Paper", "Event", "Person", "Idea")


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


def _resolve_type(members: list[GraphNode]) -> str:
    """Majority-vote the merged group's type; ties break by _TYPE_PRECEDENCE."""
    counts = Counter(m.type for m in members)
    return min(
        counts,
        key=lambda t: (-counts[t], _TYPE_PRECEDENCE.index(t) if t in _TYPE_PRECEDENCE else len(_TYPE_PRECEDENCE)),
    )


def _pick_canonical(members: list[GraphNode], resolved_type: str) -> GraphNode:
    """Select the representative node for a merge group.

    Prefers a member of the group's resolved type (so the surviving id and
    properties agree with the type), then the longest label (most
    descriptive). Remaining ties break by ID order so the choice is stable
    across runs.
    """
    return sorted(members, key=lambda n: (n.type != resolved_type, -len(n.name), n.id))[0]


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

    # Group by canonical name, cross-type. The Person rule lives here:
    # Person nodes group in their own namespace so a person sharing a name
    # with a product never collapses into it.
    groups: dict[tuple[str, str], list[GraphNode]] = defaultdict(list)
    for n in mergeable:
        namespace = "person" if n.type == "Person" else "entity"
        groups[(namespace, canonical_key(n.name))].append(n)

    # Build id remap and canonical node list. The group's type is the
    # member majority — per-doc extraction types the same referent
    # inconsistently, and the canonical node is rewritten to the resolved
    # type when it disagrees.
    id_remap: dict[str, str] = {}
    canonical_nodes: list[GraphNode] = []
    for members in groups.values():
        stats.groups_considered += 1
        resolved_type = _resolve_type(members)
        canonical = _pick_canonical(members, resolved_type)
        if canonical.type != resolved_type:
            canonical = replace(canonical, type=resolved_type)
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
