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

"""Compact orientation response for agent session start (OT-1732 Overview)."""

from __future__ import annotations

from typing import Any

from opentrace_agent.store import GraphStore

DEFAULT_TOP_N = 5
TOP_N_CAP = 20


def overview(
    store: GraphStore,
    top_n: int = DEFAULT_TOP_N,
    vault_scope: str | None = None,
) -> dict[str, Any]:
    """Return a small structural orientation of the indexed graph.

    Returns
    -------
    dict
        ``{"counts_by_type": {...}, "top_concepts": [...], "recently_updated": [...], "vault_scope": str | None}``

    Targets a compact JSON payload (well under 500 tokens) to fit the OT-1732
    Overview success criterion. Top concepts are the highest-degree non-internal
    nodes; recently-updated entries come from the per-node ``last_updated``
    property when set (today: WikiPage). ``vault_scope`` is reserved for
    Phase 4 — currently no-op.
    """
    top_n = max(1, min(top_n, TOP_N_CAP))

    if vault_scope is not None:
        return _scoped_overview(store, top_n=top_n, vault_scope=vault_scope)

    stats = store.get_stats()
    nodes_by_type: dict[str, int] = stats.get("nodes_by_type", {}) or {}

    # Top concepts by outgoing+incoming degree.
    top_concepts = _top_by_degree(store, top_n=top_n)

    # Recently-updated nodes — sourced from any node carrying a `last_updated`
    # property. Today populated by the wiki compile pipeline; future: also
    # code nodes once Phase 5 stamps them.
    recent = _recently_updated(store, top_n=top_n)

    return {
        "counts_by_type": nodes_by_type,
        "top_concepts": top_concepts,
        "recently_updated": recent,
        "top_linked_concepts": _top_linked_concepts(store, top_n=top_n, vault_scope=None),
        "top_cited_sources": _top_cited_sources(store, top_n=top_n, vault_scope=None),
        "cluster_sizes": _cluster_sizes(store, vault_scope=None),
        "vault_scope": None,
    }


def _scoped_overview(store: GraphStore, top_n: int, vault_scope: str) -> dict[str, Any]:
    """Restrict overview output to nodes whose ``vault`` property matches.

    Vault-domain nodes (WikiVault / WikiPage / Source) all carry a ``vault``
    property by Phase 4 convention; non-vault nodes are excluded.
    """
    from opentrace_agent.store.graph_store import _parse_props

    result = store._conn.execute(
        "MATCH (n:Node) WHERE n.properties CONTAINS 'vault' RETURN n.id, n.type, n.name, n.properties LIMIT 5000"
    )
    counts: dict[str, int] = {}
    in_scope: list[dict[str, Any]] = []
    while result.has_next():
        row = result.get_next()
        props = _parse_props(row[3]) or {}
        if props.get("vault") != vault_scope:
            continue
        ntype = str(row[1])
        counts[ntype] = counts.get(ntype, 0) + 1
        in_scope.append(
            {
                "id": str(row[0]),
                "type": ntype,
                "name": str(row[2]),
                "properties": props,
            }
        )

    # Top concepts by 1-hop degree, computed only for in-scope nodes.
    scored: list[tuple[dict[str, Any], int]] = []
    for n in in_scope[: top_n * 5]:
        try:
            neighbours = store.traverse(n["id"], direction="both", max_depth=1)
        except ValueError:
            neighbours = []
        scored.append((n, len(neighbours)))
    scored.sort(key=lambda p: p[1], reverse=True)
    top_concepts: list[dict[str, Any]] = []
    for n, degree in scored[:top_n]:
        props = n["properties"]
        summary = props.get("one_line_summary") or props.get("summary") or ""
        if isinstance(summary, str) and len(summary) > 120:
            summary = summary[:117] + "..."
        top_concepts.append(
            {
                "id": n["id"],
                "type": n["type"],
                "name": n["name"],
                "degree": degree,
                "summary": summary if isinstance(summary, str) else "",
            }
        )

    # Recently-updated within the scope.
    recent = [n for n in in_scope if isinstance(n["properties"].get("last_updated"), str)]
    recent.sort(key=lambda n: n["properties"]["last_updated"], reverse=True)
    recently_updated = [
        {
            "id": n["id"],
            "type": n["type"],
            "name": n["name"],
            "last_updated": n["properties"]["last_updated"],
            "one_line_summary": (
                n["properties"].get("one_line_summary")
                if isinstance(n["properties"].get("one_line_summary"), str)
                else ""
            ),
        }
        for n in recent[:top_n]
    ]

    return {
        "counts_by_type": counts,
        "top_concepts": top_concepts,
        "recently_updated": recently_updated,
        "top_linked_concepts": _top_linked_concepts(store, top_n=top_n, vault_scope=vault_scope),
        "top_cited_sources": _top_cited_sources(store, top_n=top_n, vault_scope=vault_scope),
        "cluster_sizes": _cluster_sizes(store, vault_scope=vault_scope),
        "vault_scope": vault_scope,
    }


def _top_by_degree(store: GraphStore, top_n: int) -> list[dict[str, Any]]:
    """Return up to *top_n* nodes ranked by total degree (in + out edges).

    Implementation: aggregate edge endpoints in Cypher, then resolve each ID
    to a {id, type, name, summary} record. Internal types are excluded.
    """
    from opentrace_agent.store.constants import INTERNAL_NODE_TYPES

    result = store._conn.execute(
        "MATCH (a:Node)-[r:RELATES]-(b:Node) "
        "WHERE a.type <> $meta "
        "RETURN a.id AS id, count(r) AS degree "
        "ORDER BY degree DESC "
        f"LIMIT {top_n * 3}",  # over-fetch, filter, trim
        parameters={"meta": "_overflow_"},  # not really needed; node-level filter below
    )
    candidates: list[tuple[str, int]] = []
    while result.has_next():
        row = result.get_next()
        candidates.append((str(row[0]), int(row[1])))

    out: list[dict[str, Any]] = []
    for nid, degree in candidates:
        node = store.get_node(nid)
        if node is None:
            continue
        if node["type"] in INTERNAL_NODE_TYPES:
            continue
        props = node.get("properties") or {}
        summary = props.get("one_line_summary") or props.get("summary") or ""
        if isinstance(summary, str) and len(summary) > 120:
            summary = summary[:117] + "..."
        out.append(
            {
                "id": node["id"],
                "type": node["type"],
                "name": node["name"],
                "degree": degree,
                "summary": summary if isinstance(summary, str) else "",
            }
        )
        if len(out) >= top_n:
            break
    return out


def _recently_updated(store: GraphStore, top_n: int) -> list[dict[str, Any]]:
    """Return nodes whose properties carry a ``last_updated`` timestamp,
    sorted descending. Currently driven by WikiPage; will broaden when code
    provenance stamping lands in Phase 5.
    """
    # Pull a bounded set of candidates and sort in Python — avoids relying on
    # JSON-property sort in Cypher (LadybugDB MAP literal sorting is brittle).
    candidates: list[dict[str, Any]] = []
    result = store._conn.execute(
        "MATCH (n:Node) WHERE n.properties CONTAINS 'last_updated' RETURN n.id, n.type, n.name, n.properties LIMIT 200"
    )
    from opentrace_agent.store.graph_store import _parse_props

    while result.has_next():
        row = result.get_next()
        props = _parse_props(row[3]) or {}
        last = props.get("last_updated")
        if not isinstance(last, str):
            continue
        candidates.append(
            {
                "id": str(row[0]),
                "type": str(row[1]),
                "name": str(row[2]),
                "last_updated": last,
                "one_line_summary": (
                    props.get("one_line_summary") if isinstance(props.get("one_line_summary"), str) else ""
                ),
            }
        )
    candidates.sort(key=lambda c: c["last_updated"], reverse=True)
    return candidates[:top_n]


def _trim_summary(value: Any) -> str:
    """Coerce *value* to a short summary string (≤120 chars)."""
    if not isinstance(value, str):
        return ""
    return value[:117] + "..." if len(value) > 120 else value


def _top_linked_concepts(store: GraphStore, top_n: int, vault_scope: str | None) -> list[dict[str, Any]]:
    """Concept WikiPages ranked by how many ``LINKS_TO`` edges touch them.

    Degree counts incident edges in either direction (a concept linked twice
    and linking out once has degree 3). File-summary pages and zero-degree
    ("lonely") concepts are excluded; restricted to *vault_scope* when set.
    """
    result = store._conn.execute(
        "MATCH (a:Node)-[r:RELATES]-(b:Node) WHERE r.type = 'LINKS_TO' "
        "RETURN a.id AS id, count(r) AS degree ORDER BY degree DESC, id LIMIT 200"
    )
    out: list[dict[str, Any]] = []
    while result.has_next():
        row = result.get_next()
        nid, degree = str(row[0]), int(row[1])
        if degree <= 0:
            continue
        node = store.get_node(nid)
        if node is None or node["type"] != "WikiPage":
            continue
        props = node.get("properties") or {}
        if props.get("kind") != "concept":
            continue
        if vault_scope is not None and props.get("vault") != vault_scope:
            continue
        out.append(
            {
                "id": nid,
                "name": node["name"],
                "vault": props.get("vault"),
                "degree": degree,
                "summary": _trim_summary(props.get("one_line_summary") or props.get("summary") or ""),
            }
        )
        if len(out) >= top_n:
            break
    return out


def _top_cited_sources(store: GraphStore, top_n: int, vault_scope: str | None) -> list[dict[str, Any]]:
    """``Source`` nodes ranked by incoming ``CITES`` count.

    Counts edges pointing *at* each source (concept page → Source, direct by
    sha). Uncited sources never appear. Sources deliberately carry no
    ``vault`` property (membership is the WikiVault -CONTAINS-> Source edge),
    so *vault_scope* filters against the vault's contained-source set.
    """
    scope_source_ids: set[str] | None = None
    if vault_scope is not None:
        try:
            contained = store.traverse(
                f"vault::{vault_scope}",
                direction="outgoing",
                max_depth=1,
                relationship_type="CONTAINS",
            )
        except ValueError:
            contained = []
        scope_source_ids = {r["node"]["id"] for r in contained if (r.get("node") or {}).get("type") == "CorpusDoc"}

    result = store._conn.execute(
        "MATCH (a:Node)-[r:RELATES]->(b:Node) WHERE r.type = 'CITES' "
        "RETURN b.id AS id, count(r) AS citations ORDER BY citations DESC, id LIMIT 200"
    )
    out: list[dict[str, Any]] = []
    while result.has_next():
        row = result.get_next()
        nid, citations = str(row[0]), int(row[1])
        if citations <= 0:
            continue
        if scope_source_ids is not None and nid not in scope_source_ids:
            continue
        node = store.get_node(nid)
        if node is None or node["type"] != "CorpusDoc":
            continue
        props = node.get("properties") or {}
        out.append(
            {
                "id": nid,
                "name": node["name"],
                "title": props.get("title"),
                "summary": _trim_summary(props.get("one_line_summary") or ""),
                "citation_count": citations,
            }
        )
        if len(out) >= top_n:
            break
    return out


def _cluster_sizes(store: GraphStore, vault_scope: str | None) -> dict[str, int]:
    """Count WikiPages per ``cluster_id`` stamp (keys stringified).

    Returns an empty dict when no page carries a ``cluster_id``. Restricted to
    *vault_scope* when set.
    """
    from opentrace_agent.store.graph_store import _parse_props

    result = store._conn.execute(
        "MATCH (n:Node) WHERE n.type = 'WikiPage' AND n.properties CONTAINS 'cluster_id' RETURN n.properties LIMIT 5000"
    )
    sizes: dict[str, int] = {}
    while result.has_next():
        props = _parse_props(result.get_next()[0]) or {}
        if "cluster_id" not in props:
            continue
        if vault_scope is not None and props.get("vault") != vault_scope:
            continue
        key = str(props["cluster_id"])
        sizes[key] = sizes.get(key, 0) + 1
    return sizes
