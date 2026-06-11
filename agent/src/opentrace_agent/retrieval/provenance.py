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

"""OT-1732 Provenance — return the trust chain for a node.

Three branches keyed off node type / edges:

* **Wiki** (``WikiVault`` / ``WikiPage`` / ``Source``) — agent/model/session/
  confidence stamped at compile time plus the CITES chain back through any
  file-summary pages to the original ``Source`` artefacts.
* **Code** (``Repository`` / ``Directory`` / ``File`` / ``Class`` / ``Function`` /
  ``Variable``) — ``commit_sha`` / ``indexer_version`` from the per-repo
  ``IndexMetadata`` node written by ``opentraceai index``; file path and line
  range come from the node itself.
* **Derived** (entities created by ``opentraceai ingest``: ``Concept`` /
  ``Service`` / ``Module`` / ``Paper`` / ``Person`` / ``Event``) — walk the
  outgoing ``DERIVED_FROM`` edge to the ``Source`` they came out of and
  surface that Source's metadata + the ``transform`` discriminator
  (e.g. ``"llm_extraction"``) recorded on the edge.
"""

from __future__ import annotations

from typing import Any

from opentrace_agent.store import GraphStore

WIKI_NODE_TYPES = {"WikiVault", "WikiPage", "Source"}
CODE_NODE_TYPES = {"Repository", "Directory", "File", "Class", "Function", "Variable"}
DERIVED_NODE_TYPES = {"Idea", "Service", "Module", "Paper", "Person", "Event"}


def provenance(store: GraphStore, node_id: str) -> dict[str, Any]:
    """Return the provenance chain for *node_id*.

    Returns
    -------
    dict
        ``{node_id, node_type, kind, code, wiki, derived}`` where ``kind``
        is one of ``"code"``, ``"wiki"``, ``"derived"``, or ``"unknown"``.
        The unused sub-payloads are ``null``.
    """
    node = store.get_node(node_id)
    if node is None:
        return {
            "node_id": node_id,
            "node_type": None,
            "kind": "unknown",
            "code": None,
            "wiki": None,
            "derived": None,
            "error": f"node not found: {node_id}",
        }

    ntype = node["type"]
    props = node.get("properties") or {}

    if ntype in WIKI_NODE_TYPES:
        return {
            "node_id": node_id,
            "node_type": ntype,
            "kind": "wiki",
            "code": None,
            "wiki": _wiki_provenance(store, node_id, ntype, props),
            "derived": None,
        }
    if ntype in CODE_NODE_TYPES:
        return {
            "node_id": node_id,
            "node_type": ntype,
            "kind": "code",
            "code": _code_provenance(store, node_id, ntype, props),
            "wiki": None,
            "derived": None,
        }
    if ntype in DERIVED_NODE_TYPES:
        return {
            "node_id": node_id,
            "node_type": ntype,
            "kind": "derived",
            "code": None,
            "wiki": None,
            "derived": _derived_provenance(store, node_id, props),
        }
    return {
        "node_id": node_id,
        "node_type": ntype,
        "kind": "unknown",
        "code": None,
        "wiki": None,
        "derived": None,
    }


# ---------------------------------------------------------------------------
# Wiki provenance
# ---------------------------------------------------------------------------


def _wiki_provenance(store: GraphStore, node_id: str, node_type: str, props: dict[str, Any]) -> dict[str, Any]:
    """Return ``{agent, model, session, confidence, vault, chain}`` for a wiki node.

    ``chain`` walks CITES outgoing up to 3 hops, stopping at Source nodes.
    For a concept page the chain typically goes
    concept → file-summary page → Source. For a file-summary page it
    goes file-summary → Source. For a Source, the chain is just itself.
    """
    chain: list[dict[str, Any]] = []
    visited: set[str] = {node_id}

    if node_type == "Source":
        chain.append(_source_link(node_id, props))
    else:
        # Walk CITES outgoing up to 3 hops to capture concept→summary→source.
        traversal = store.traverse(
            node_id,
            direction="outgoing",
            max_depth=3,
            relationship_type="CITES",
        )
        # Sort by depth so the chain reads start-to-source.
        traversal.sort(key=lambda r: r["depth"])
        for r in traversal:
            nid = r["node"]["id"]
            if nid in visited:
                continue
            visited.add(nid)
            t = r["node"]["type"]
            p = r["node"].get("properties") or {}
            if t == "Source":
                chain.append(_source_link(nid, p))
            elif t == "WikiPage":
                chain.append(
                    {
                        "kind": "wiki_page",
                        "id": nid,
                        "page_kind": p.get("kind"),
                        "title": r["node"].get("name"),
                        "slug": p.get("slug"),
                        "vault": p.get("vault"),
                    }
                )

    return {
        "agent": props.get("agent") or None,
        "model": props.get("model") or None,
        "session": props.get("session") or None,
        "confidence": _try_float(props.get("confidence")),
        "vault": props.get("vault"),
        "chain": chain,
    }


def _source_link(node_id: str, props: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "source",
        "id": node_id,
        "sha256": props.get("sha256"),
        "filename": props.get("filename"),
        "acquired_at": props.get("acquired_at"),
    }


# ---------------------------------------------------------------------------
# Derived-from provenance (opentraceai ingest entities)
# ---------------------------------------------------------------------------


def _derived_provenance(store: GraphStore, node_id: str, props: dict[str, Any]) -> dict[str, Any]:
    """Return ``{source, transform, source_uri, derived_from}`` for a derived entity.

    Walks the outgoing ``DERIVED_FROM`` edge to the originating ``Source`` and
    surfaces that Source's metadata. The ``transform`` field on the edge
    distinguishes how the entity was extracted (``llm_extraction`` for
    `opentraceai ingest` today). When the edge or target is missing, returns
    ``source=None`` so callers can detect orphaned entities rather than
    crashing.
    """
    # Cheap signals already on the node — these were stamped at ingest time
    # so consumers don't have to traverse to learn the immediate Source.
    derived_from = props.get("derived_from")
    source_uri = props.get("source_uri")

    chain: list[dict[str, Any]] = []
    target: dict[str, Any] | None = None
    transform: str | None = None

    traversal = store.traverse(
        node_id,
        direction="outgoing",
        max_depth=1,
        relationship_type="DERIVED_FROM",
    )
    for r in traversal:
        node = r.get("node") or {}
        rel = r.get("relationship") or {}
        if node.get("type") != "Source":
            continue
        rel_props = rel.get("properties") or {}
        transform = rel_props.get("transform") or transform
        sp = node.get("properties") or {}
        link = _source_link(node["id"], sp)
        link["content_type"] = sp.get("content_type")
        link["source_uri"] = sp.get("source_uri") or source_uri
        link["corpus_path"] = sp.get("corpus_path")
        chain.append(link)
        if target is None:
            target = link

    return {
        "source": target,
        "transform": transform,
        "source_uri": source_uri,
        "derived_from": derived_from,
        "chain": chain,
    }


# ---------------------------------------------------------------------------
# Code provenance
# ---------------------------------------------------------------------------


def _code_provenance(store: GraphStore, node_id: str, node_type: str, props: dict[str, Any]) -> dict[str, Any]:
    """Return ``{commit_sha, indexer_version, file_path, line_range, repo}``."""
    file_path = props.get("path") or None
    start_line = props.get("start_line") or props.get("startLine")
    end_line = props.get("end_line") or props.get("endLine")
    line_range = [int(start_line), int(end_line)] if start_line is not None and end_line is not None else None

    # Find the per-repo IndexMetadata node by walking the id prefix that
    # ``save_metadata`` uses (``_meta:index:{repoId}``). The repoId is the
    # prefix of the node id up to the first ``/`` (e.g.
    # ``test/go-project/cmd/server/main.go`` → repo id ``test/go-project``).
    repo_id = _infer_repo_id(node_id)
    commit_sha: str | None = None
    indexer_version: str | None = None
    indexed_at: str | None = None
    if repo_id:
        meta_node = store.get_node(f"_meta:index:{repo_id}")
        if meta_node is not None:
            mp = meta_node.get("properties") or {}
            commit_sha = mp.get("commitSha") or mp.get("commit_sha") or None
            indexer_version = mp.get("opentraceaiVersion") or mp.get("opentraceai_version") or None
            indexed_at = mp.get("indexedAt") or mp.get("indexed_at") or None

    return {
        "commit_sha": commit_sha,
        "indexer_version": indexer_version,
        "indexed_at": indexed_at,
        "repo_id": repo_id,
        "file_path": file_path,
        "line_range": line_range,
    }


def _infer_repo_id(node_id: str) -> str | None:
    """Best-effort extraction of the repo prefix from a code node id.

    Code node IDs follow ``{repoId}/{path}::{symbol}`` — see
    ``pipeline/saving.py`` and the ``DirectoryWalker``. We assume the repo id
    is the substring before the third ``/`` for github-style IDs (e.g.
    ``owner/repo/path``) or before the second ``/`` for directory-imported
    repos. Fall back to splitting on ``::`` when present.
    """
    if not node_id:
        return None
    # Strip symbol suffix if present.
    head = node_id.split("::", 1)[0]
    parts = head.split("/")
    if len(parts) >= 2:
        # For owner/repo/... prefer two segments; for local/<name>/... same.
        return "/".join(parts[:2])
    return parts[0] if parts else None


def _try_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
