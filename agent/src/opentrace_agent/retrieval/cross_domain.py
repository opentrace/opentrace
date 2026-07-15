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

"""Retrieval helpers that surface cross-domain structure in the graph.

After Phase 5 the graph contains three coexisting domains:

* **code** — `Repository` / `Directory` / `File` / `Class` / `Function` /
  `Variable`
* **entity** — `Idea` / `Service` / `Module` / `Paper` / `Person` / `Event`
* **page** — `Vault` / `Page` / `Source`

This module surfaces the bridges across those domains — the "AuthMiddleware
appears in 5 code files plus 2 design docs" view that's hard to ask via
generic traversal.
"""

from __future__ import annotations

from typing import Any

from opentrace_agent.store import GraphStore

# Domain map. Kept here (not in store/constants.py) because it's a
# retrieval-layer concept — the store doesn't care about domains.
DOMAINS: dict[str, frozenset[str]] = {
    "code": frozenset({"Repository", "Directory", "File", "Class", "Function", "Variable"}),
    "entity": frozenset({"Idea", "Service", "Module", "Paper", "Person", "Event"}),
    "page": frozenset({"KnowledgeVault", "KnowledgeConcept", "KnowledgeDoc"}),
}


def _domain_of(node_type: str) -> str | None:
    """Return the domain name a node type belongs to, or ``None`` if it's neither."""
    for name, types in DOMAINS.items():
        if node_type in types:
            return name
    return None


def cross_domain_bridges(
    store: GraphStore,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return edges whose source and target sit in different domains.

    Sorted by how connective each edge type is (most frequent first), then
    by source name. Returns ``{source_id, source_type, source_domain,
    target_id, target_type, target_domain, edge_type}`` records — agent-
    consumable shape.

    Uses ``iter_analysis_graph`` for the node universe, then walks edge
    rows from ``list_relationships_for_nodes``.
    """
    nodes, _ = store.iter_analysis_graph()
    type_by_id: dict[str, str] = {n["id"]: n["type"] for n in nodes}
    name_by_id: dict[str, str] = {n["id"]: n.get("name") or n["id"] for n in nodes}

    rels = store.list_relationships_for_nodes(set(type_by_id))
    bridges: list[dict[str, Any]] = []
    for r in rels:
        src_id = r.get("source_id")
        tgt_id = r.get("target_id")
        if not src_id or not tgt_id:
            continue
        src_dom = _domain_of(type_by_id.get(src_id, ""))
        tgt_dom = _domain_of(type_by_id.get(tgt_id, ""))
        if src_dom is None or tgt_dom is None or src_dom == tgt_dom:
            continue
        bridges.append(
            {
                "source_id": src_id,
                "source_type": type_by_id[src_id],
                "source_domain": src_dom,
                "source_name": name_by_id.get(src_id, src_id),
                "target_id": tgt_id,
                "target_type": type_by_id[tgt_id],
                "target_domain": tgt_dom,
                "target_name": name_by_id.get(tgt_id, tgt_id),
                "edge_type": r.get("type") or "",
            }
        )

    # Order by edge-type frequency (most connective first), then by source name.
    type_count: dict[str, int] = {}
    for b in bridges:
        type_count[b["edge_type"]] = type_count.get(b["edge_type"], 0) + 1
    bridges.sort(key=lambda b: (-type_count[b["edge_type"]], b["source_name"], b["target_name"]))
    return bridges[:limit]


def find_communities_spanning_domains(
    store: GraphStore,
    min_domains: int = 2,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return Community nodes whose members come from ≥ *min_domains* domains.

    Useful for "topics that bridge code and docs" surfacing. Returns
    ``{community_id, name, domains, member_counts, total_members}`` per row,
    sorted by total domain count descending then by total_members.
    """
    communities = store.list_communities()
    if not communities:
        return []

    out: list[dict[str, Any]] = []
    for c in communities:
        # Walk MEMBER_OF_COMMUNITY edges into the Community to get its
        # members. Direction: members → community → so traverse incoming.
        incoming = store.traverse(c["id"], direction="incoming", max_depth=1, relationship_type="MEMBER_OF_COMMUNITY")
        domain_counts: dict[str, int] = {}
        for r in incoming:
            ntype = r.get("node", {}).get("type") or ""
            dom = _domain_of(ntype)
            if dom:
                domain_counts[dom] = domain_counts.get(dom, 0) + 1
        if len(domain_counts) >= min_domains:
            out.append(
                {
                    "community_id": c["id"],
                    "name": c.get("name") or c["id"],
                    "domains": sorted(domain_counts.keys()),
                    "member_counts": domain_counts,
                    "total_members": sum(domain_counts.values()),
                }
            )

    out.sort(key=lambda x: (-len(x["domains"]), -x["total_members"], x["name"]))
    return out[:limit]
