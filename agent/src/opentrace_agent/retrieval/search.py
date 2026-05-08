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

"""OT-1732 ranked Search — FTS-only on the CLI surface.

Wraps :meth:`GraphStore._fts_search` to produce ranked results with a snippet
plus the optional metadata channels the agent uses to triage hits (type,
vault, recency, confidence). The vault / recency / confidence fields are
populated where the underlying property is set; otherwise ``None``. They
become consistently meaningful once Phases 4/5 land.
"""

from __future__ import annotations

from typing import Any

from opentrace_agent.store import GraphStore

DEFAULT_LIMIT = 25
LIMIT_CAP = 200
SNIPPET_LEN = 200


def search(
    store: GraphStore,
    query: str,
    limit: int = DEFAULT_LIMIT,
    node_types: list[str] | None = None,
    vault_scope: str | None = None,
) -> dict[str, Any]:
    """Ranked FTS search with snippets + spec-shaped metadata.

    Returns
    -------
    dict
        ``{"hits": [SearchHit, ...], "count": N, "query": str}`` where each
        hit is ``{id, type, name, snippet, score, vault, recency, confidence}``.
        ``vault`` / ``recency`` / ``confidence`` are ``None`` when the
        underlying property isn't set on the node.
    """
    from opentrace_agent.store.constants import INTERNAL_NODE_TYPES

    limit = max(1, min(limit, LIMIT_CAP))
    type_filter = set(node_types) if node_types else None

    try:
        fts = store._fts_search(query, limit * 3)
    except Exception:
        fts = []

    if not fts:
        # Fall back to the existing substring path so the caller still gets
        # something useful when FTS is unavailable. Drop scores in that case.
        nodes = store.search_nodes(query, node_types=node_types, limit=limit)
        hits = [_hit_from_node(store, n, score=None, query=query) for n in nodes]
        if vault_scope is not None:
            hits = [h for h in hits if h["vault"] == vault_scope]
        return {"hits": hits, "count": len(hits), "query": query}

    hits: list[dict[str, Any]] = []
    for node_id, score in fts:
        node = store.get_node(node_id)
        if node is None:
            continue
        if node["type"] in INTERNAL_NODE_TYPES:
            continue
        if type_filter and node["type"] not in type_filter:
            continue
        hit = _hit_from_node(store, node, score=score, query=query)
        if vault_scope is not None and hit["vault"] != vault_scope:
            continue
        hits.append(hit)
        if len(hits) >= limit:
            break

    return {"hits": hits, "count": len(hits), "query": query}


def _hit_from_node(
    store: GraphStore,
    node: dict[str, Any],
    score: float | None,
    query: str,
) -> dict[str, Any]:
    props = node.get("properties") or {}
    snippet = _snippet(node, props, query)

    # Vault scope is tracked at the WikiPage level via the auto-injected
    # `vault` column; for code nodes it stays None until Phase 4 adds an
    # ancestor lookup.
    vault = props.get("vault") if isinstance(props.get("vault"), str) else None

    # Recency: last_updated is populated on WikiPage by the wiki compile
    # pipeline today; code-side stamping arrives in Phase 5.
    recency = props.get("last_updated") if isinstance(props.get("last_updated"), str) else None

    # Confidence: Phase 5 stamps this on WikiPage; falls back to the rel-level
    # `confidence` carried on CALLS edges in some cases. Read whatever the
    # property says; None if unset.
    confidence_raw = props.get("confidence")
    try:
        confidence = float(confidence_raw) if confidence_raw is not None else None
    except (TypeError, ValueError):
        confidence = None

    return {
        "id": node["id"],
        "type": node["type"],
        "name": node["name"],
        "snippet": snippet,
        "score": score,
        "vault": vault,
        "recency": recency,
        "confidence": confidence,
    }


def _snippet(node: dict[str, Any], props: dict[str, Any], query: str) -> str:
    """Best-effort snippet around the query terms.

    We don't have access to the ``search_text`` column post-fetch (the helper
    methods strip it), so we recompute it from the node fields. For
    multi-token queries we anchor on the first token that appears.
    """
    name = node.get("name") or ""
    summary = props.get("one_line_summary") or props.get("summary") or ""
    body = " ".join(s for s in (str(name), str(summary)) if s).strip()
    if not body:
        return ""

    if not query:
        return body[:SNIPPET_LEN]

    lowered = body.lower()
    tokens = [t for t in query.lower().split() if t]
    anchor = -1
    for tok in tokens:
        idx = lowered.find(tok)
        if idx >= 0:
            anchor = idx
            break

    if anchor < 0:
        return body[:SNIPPET_LEN]

    half = SNIPPET_LEN // 2
    start = max(0, anchor - half)
    end = min(len(body), start + SNIPPET_LEN)
    snippet = body[start:end]
    if start > 0:
        snippet = "..." + snippet
    if end < len(body):
        snippet = snippet + "..."
    return snippet
