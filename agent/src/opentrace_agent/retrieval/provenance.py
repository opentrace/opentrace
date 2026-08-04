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

Two branches keyed off node type / edges:

* **Wiki** (``Vault`` / ``Page`` / ``Source``) — agent/model/session/
  confidence stamped at compile time plus the CITES chain to the original
  ``Source`` artefacts (concept pages cite Sources directly by sha).
* **Code** (``Repository`` / ``Directory`` / ``File`` / ``Class`` / ``Function`` /
  ``Variable``) — ``commit_sha`` / ``indexer_version`` from the per-repo
  ``IndexMetadata`` node written by ``opentraceai index``; file path and line
  range come from the node itself.

A third **derived** branch walked ``DERIVED_FROM`` from an LLM-extracted
entity back to the document it came out of. It went with the entity layer on
2026-08-04 (see the wiki CLAUDE.md); nothing produces those nodes any more, so
their type now falls through to ``kind="unknown"``.
"""

from __future__ import annotations

from typing import Any

from opentrace_agent.store import GraphStore

WIKI_NODE_TYPES = {"KnowledgeVault", "KnowledgeConcept", "KnowledgeDoc"}
CODE_NODE_TYPES = {"Repository", "Directory", "File", "Class", "Function", "Variable"}


def provenance(store: GraphStore, node_id: str) -> dict[str, Any]:
    """Return the provenance chain for *node_id*.

    Returns
    -------
    dict
        ``{node_id, node_type, kind, code, wiki}`` where ``kind``
        is one of ``"code"``, ``"wiki"``, or ``"unknown"``.
        The unused sub-payload is ``null``.
    """
    node = store.get_node(node_id)
    if node is None:
        return {
            "node_id": node_id,
            "node_type": None,
            "kind": "unknown",
            "code": None,
            "wiki": None,
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
        }
    if ntype in CODE_NODE_TYPES:
        return {
            "node_id": node_id,
            "node_type": ntype,
            "kind": "code",
            "code": _code_provenance(store, node_id, ntype, props),
            "wiki": None,
        }
    return {
        "node_id": node_id,
        "node_type": ntype,
        "kind": "unknown",
        "code": None,
        "wiki": None,
    }


# ---------------------------------------------------------------------------
# Wiki provenance
# ---------------------------------------------------------------------------


def _wiki_provenance(store: GraphStore, node_id: str, node_type: str, props: dict[str, Any]) -> dict[str, Any]:
    """Return ``{agent, model, session, confidence, vault, chain}`` for a wiki node.

    ``chain`` walks CITES outgoing up to 3 hops, stopping at Source nodes.
    For a concept page the chain goes concept → Source (direct by sha).
    For a Source, the chain is just itself.
    """
    chain: list[dict[str, Any]] = []
    visited: set[str] = {node_id}

    if node_type == "KnowledgeDoc":
        chain.append(_source_link(node_id, props, store))
    else:
        # Walk CITES outgoing (depth-capped defensively; the schema is one
        # hop, concept → Source).
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
            if t == "KnowledgeDoc":
                chain.append(_source_link(nid, p, store))
            elif t == "KnowledgeConcept":
                chain.append(
                    {
                        "kind": "knowledge_concept",
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


def _source_link(node_id: str, props: dict[str, Any], store: GraphStore | None = None) -> dict[str, Any]:
    """Chain entry for a KnowledgeDoc. When *store* is given, follows the
    outgoing MIRRORS edge (present for repo-walked docs whose extension also
    produced a File node) so the chain hands the caller a code-tree anchor."""
    link: dict[str, Any] = {
        "kind": "knowledge_doc",
        "id": node_id,
        "sha256": props.get("sha256"),
        "filename": props.get("filename"),
        "path": props.get("path"),
        "acquired_at": props.get("acquired_at"),
    }
    if store is not None:
        try:
            mirrors = store.traverse(node_id, direction="outgoing", max_depth=1, relationship_type="MIRRORS")
        except ValueError:
            mirrors = []
        for r in mirrors:
            n = r.get("node") or {}
            if n.get("type") == "File":
                link["file"] = n.get("id")
                break
    return link


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
