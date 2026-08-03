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
# Matches cli/mcp_server.py's list_nodes compact projection so the two doc
# surfaces truncate the label identically.
_TRIAGE_GLOSS_CHARS = 120

# Node types the --wiki doc pass extracts from document text. Redefined here
# (like provenance.py does) rather than imported from sources/markdown —
# retrieval must not depend on the extraction stack. Two of these names
# collide with legacy runtime types ("Service", "Module"), so type alone
# can't identify an extracted entity — see _is_llm_entity.
_LLM_ENTITY_TYPES = frozenset({"Idea", "Service", "Module", "Paper", "Person", "Event"})


def _is_llm_entity(node: dict[str, Any]) -> bool:
    """True when *node* is a doc-extracted entity, not a runtime node.

    Extracted entities always carry ``derived_from`` (stamped unconditionally
    at build time) and usually ``vault``; runtime Service/Cluster/... nodes
    carry neither. Measured motivation: entities' short search_text wins BM25
    over labelled docs (length normalisation), taking ~half the top-3 slots
    on a 25-doc index — content-free hits an agent then has to wade through.
    """
    if node.get("type") not in _LLM_ENTITY_TYPES:
        return False
    props = node.get("properties") or {}
    return "derived_from" in props or "vault" in props


def search(
    store: GraphStore,
    query: str,
    limit: int = DEFAULT_LIMIT,
    node_types: list[str] | None = None,
    vault_scope: str | None = None,
    exclude_llm_entities: bool = False,
) -> dict[str, Any]:
    """Ranked FTS search with snippets + spec-shaped metadata.

    With *exclude_llm_entities*, doc-extracted entity nodes are filtered out
    of the results (see :func:`_is_llm_entity`) and counted in
    ``entities_excluded``. Ignored when *node_types* is set — an explicit
    type filter always wins, including asking for the entity types themselves.

    Returns
    -------
    dict
        ``{"hits": [SearchHit, ...], "count": N, "query": str,
        "entities_excluded": M}`` where each hit is ``{id, type, name,
        snippet, score, vault, recency, confidence}``; ``KnowledgeDoc`` hits
        additionally carry ``title`` / ``status`` / ``one_line_summary``
        (≤120 chars) / ``path`` so they can be triaged without opening the
        doc. ``vault`` / ``recency`` / ``confidence`` are ``None`` when the
        underlying property isn't set on the node. ``entities_excluded`` is
        present only when *exclude_llm_entities* applied.
    """
    from opentrace_agent.store.constants import INTERNAL_NODE_TYPES

    limit = max(1, min(limit, LIMIT_CAP))
    type_filter = set(node_types) if node_types else None
    drop_entities = exclude_llm_entities and type_filter is None
    entities_excluded = 0

    try:
        fts = store._fts_search(query, limit * 3)
    except Exception:
        fts = []

    if not fts:
        # Fall back to the existing substring path so the caller still gets
        # something useful when FTS is unavailable. Drop scores in that case.
        nodes = store.search_nodes(query, node_types=node_types, limit=limit)
        if drop_entities:
            kept = [n for n in nodes if not _is_llm_entity(n)]
            entities_excluded = len(nodes) - len(kept)
            nodes = kept
        hits = [_hit_from_node(store, n, score=None, query=query) for n in nodes]
        if vault_scope is not None:
            hits = [h for h in hits if h["vault"] == vault_scope]
        result = {"hits": hits, "count": len(hits), "query": query}
        if drop_entities:
            result["entities_excluded"] = entities_excluded
        return result

    # Materialise candidates first (still ranked), then collapse File /
    # KnowledgeDoc twins BEFORE truncating to `limit` — collapsing after the
    # cut would free no slot, which is the entire point. Entity exclusion
    # also runs pre-cut so the freed slots refill from the 3x over-fetch.
    candidates: list[dict[str, Any]] = []
    for node_id, score in fts:
        node = store.get_node(node_id)
        if node is None:
            continue
        if node["type"] in INTERNAL_NODE_TYPES:
            continue
        if type_filter and node["type"] not in type_filter:
            continue
        if drop_entities and _is_llm_entity(node):
            entities_excluded += 1
            continue
        hit = _hit_from_node(store, node, score=score, query=query)
        if vault_scope is not None and hit["vault"] != vault_scope:
            continue
        candidates.append(hit)

    hits = _collapse_doc_file_twins(store, candidates)[:limit]
    result = {"hits": hits, "count": len(hits), "query": query}
    if drop_entities:
        result["entities_excluded"] = entities_excluded
    return result


def _collapse_doc_file_twins(store: GraphStore, hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge each ``KnowledgeDoc`` and its ``MIRRORS`` File twin into ONE hit.

    An indexed document exists twice in the graph — as the File the code walk
    saw and as the KnowledgeDoc the doc pass created — and both are
    FTS-indexed, so one document could occupy two result slots. Measured on a
    25-doc index: 8 of 12 queries returned the same document twice in the top
    5, and the File outranked its own KnowledgeDoc in 15 of 22 pairs (BM25
    length normalisation — the File's short ``search_text`` beats the
    KnowledgeDoc's identical tokens *plus* a gloss, so enriching a node
    demotes it).

    The surviving hit is the KnowledgeDoc — it carries the title, one-line
    summary, and epistemic status — promoted to whichever of the pair's two
    positions ranked better, with the File twin's id kept on the hit as
    ``fileTwin`` so a code-tree traversal is still one hop. Pairing uses the
    MIRRORS edge rather than a path-string match, so same-named docs in
    different repos are never wrongly merged.
    """
    docs = [h for h in hits if h["type"] == "KnowledgeDoc"]
    if not docs:
        return hits

    present = {h["id"] for h in hits}
    # twin File id -> the KnowledgeDoc hit that mirrors it.
    doc_by_twin: dict[str, dict[str, Any]] = {}
    for doc in docs:
        twin_id = None
        try:
            for r in store.traverse(doc["id"], direction="outgoing", max_depth=1, relationship_type="MIRRORS"):
                node = r.get("node") or {}
                if node.get("type") == "File":
                    twin_id = node.get("id")
                    break
        except (ValueError, KeyError):
            continue  # node vanished mid-query; leave this pair alone
        if not twin_id:
            continue
        doc["fileTwin"] = twin_id
        if twin_id in present:
            doc_by_twin.setdefault(twin_id, doc)

    if not doc_by_twin:
        return hits

    # Emit in rank order. A twinned File's slot yields its KnowledgeDoc
    # instead, which promotes the merged hit to whichever of the two ranked
    # better (usually the File's) and keeps the pair's stronger score.
    out: list[dict[str, Any]] = []
    emitted: set[int] = set()
    for h in hits:
        promoted = doc_by_twin.get(h["id"]) if h["type"] == "File" else None
        chosen = promoted or h
        if id(chosen) in emitted:
            continue  # this pair already took a slot further up
        if promoted is not None:
            promoted["score"] = max(promoted.get("score") or 0.0, h.get("score") or 0.0)
        emitted.add(id(chosen))
        out.append(chosen)
    return out


def _hit_from_node(
    store: GraphStore,
    node: dict[str, Any],
    score: float | None,
    query: str,
) -> dict[str, Any]:
    props = node.get("properties") or {}
    snippet = _snippet(node, props, query)

    # Vault scope is tracked at the Page level via the auto-injected
    # `vault` column; for code nodes it stays None until Phase 4 adds an
    # ancestor lookup.
    vault = props.get("vault") if isinstance(props.get("vault"), str) else None

    # Recency: last_updated is populated on Page by the wiki compile
    # pipeline today; code-side stamping arrives in Phase 5.
    recency = props.get("last_updated") if isinstance(props.get("last_updated"), str) else None

    # Confidence: Phase 5 stamps this on Page; falls back to the rel-level
    # `confidence` carried on CALLS edges in some cases. Read whatever the
    # property says; None if unset.
    confidence_raw = props.get("confidence")
    try:
        confidence = float(confidence_raw) if confidence_raw is not None else None
    except (TypeError, ValueError):
        confidence = None

    hit = {
        "id": node["id"],
        "type": node["type"],
        "name": node["name"],
        "snippet": snippet,
        "score": score,
        "vault": vault,
        "recency": recency,
        "confidence": confidence,
    }

    # KnowledgeDoc hits carry their navigation label inline so an agent can
    # triage results WITHOUT a load_source round-trip per hit — the snippet
    # alone can't say what a document is, whether it's current
    # (status: design proposal vs live docs), or where it lives.
    if node["type"] == "KnowledgeDoc":
        one = props.get("one_line_summary") or props.get("summary") or ""
        hit["title"] = props.get("title") or None
        hit["status"] = props.get("status") or None
        if len(one) > _TRIAGE_GLOSS_CHARS:
            one = one[: _TRIAGE_GLOSS_CHARS - 1] + "…"
        hit["one_line_summary"] = one or None
        hit["path"] = props.get("path") or None
    return hit


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
