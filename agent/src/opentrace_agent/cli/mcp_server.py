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

"""MCP server exposing graph query tools against a local LadybugDB database."""

from __future__ import annotations

import json
import logging
import traceback
from typing import Any

from mcp.server.fastmcp import FastMCP

from opentrace_agent.retrieval import (
    count_by as _count_by,
)
from opentrace_agent.retrieval import (
    find_communities_spanning_domains as _find_communities_spanning_domains,
)
from opentrace_agent.retrieval import (
    find_entities_mentioned_by as _find_entities_mentioned_by,
)
from opentrace_agent.retrieval import (
    find_orphans as _find_orphans,
)
from opentrace_agent.retrieval import (
    find_pages_mentioning as _find_pages_mentioning,
)
from opentrace_agent.retrieval import (
    find_path as _find_path,
)
from opentrace_agent.retrieval import (
    find_via_relationship_to_type as _find_via_relationship_to_type,
)
from opentrace_agent.retrieval import (
    grep as _grep,
)
from opentrace_agent.retrieval import (
    overview as _overview,
)
from opentrace_agent.retrieval import (
    provenance as _provenance,
)
from opentrace_agent.retrieval import (
    search as _search,
)
from opentrace_agent.retrieval.communities import (
    cross_community_bridges as _cross_community_bridges,
    god_nodes as _god_nodes,
    list_communities as _list_communities,
)
from opentrace_agent.store import GraphStore

logger = logging.getLogger(__name__)

MAX_RESULT_CHARS = 4000


def _truncate(text: str, limit: int = MAX_RESULT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n...[truncated, {len(text)} chars total]"


def _json_response(data: Any) -> str:
    return _truncate(json.dumps(data, default=str))


def _error_response(tool_name: str, e: Exception) -> str:
    tb = traceback.format_exception(e)
    logger.error("Error executing tool %s: %s\n%s", tool_name, e, "".join(tb))
    return json.dumps({"error": f"{type(e).__name__}: {e}"})


def _neighbour_summary(node: dict[str, Any]) -> str:
    """Return a short, agent-legible summary for a neighbour node.

    Prefer ``one_line_summary`` (set on WikiPage by the wiki compile pipeline);
    fall back to truncated ``summary`` (set on code nodes by the indexer);
    fall back to the node ``name``.
    """
    props = node.get("properties") or {}
    one_line = props.get("one_line_summary")
    if isinstance(one_line, str) and one_line.strip():
        return one_line.strip()
    summary = props.get("summary")
    if isinstance(summary, str) and summary.strip():
        text = summary.strip()
        return text if len(text) <= 200 else text[:197] + "..."
    return str(node.get("name") or node.get("id") or "")


NO_INDEX_MSG = json.dumps(
    {
        "status": "ok",
        "message": "No index available. Run 'opentraceai index' to create one.",
    }
)

# Source/page bodies legitimately exceed the 4 KB tool-response cap that
# ``_json_response`` applies to structured results. We still bound them so a
# pathological multi-MB file can't blow the response budget; an agent that
# needs more should request a narrower line range.
MAX_SOURCE_BODY_CHARS = 200_000


def _props(node: dict[str, Any]) -> dict[str, Any]:
    """Return a node's properties as a dict, tolerating a JSON-string column."""
    p = node.get("properties") or {}
    if isinstance(p, str):
        try:
            return json.loads(p)
        except Exception:
            return {}
    return p


def _to_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _dump_body_result(result: dict[str, Any]) -> str:
    """JSON-encode a read result, soft-capping an oversized ``body``.

    Bypasses ``_json_response``'s 4 KB truncation (page/source bodies run
    larger by design) but still bounds the payload.
    """
    body = result.get("body")
    if isinstance(body, str) and len(body) > MAX_SOURCE_BODY_CHARS:
        result = {
            **result,
            "body": body[:MAX_SOURCE_BODY_CHARS],
            "truncated": True,
            "totalChars": len(body),
        }
    return json.dumps(result, default=str)


def _resolve_repo_file(store: GraphStore, file_path: str):
    """Resolve a (possibly repo-relative) file path to an existing path on disk.

    Mirrors the CLI ``source-read`` resolution: absolute first, then each
    indexed repo's ``repoPath``, then cwd. Returns ``None`` if not found.
    """
    from pathlib import Path

    p = Path(file_path)
    if p.is_absolute() and p.exists():
        return p
    for entry in store.get_metadata():
        repo_path = entry.get("repoPath")
        if repo_path:
            candidate = Path(repo_path) / file_path
            if candidate.exists():
                return candidate
    cwd_candidate = Path.cwd() / file_path
    if cwd_candidate.exists():
        return cwd_candidate
    return None


def _read_file_slice(abs_path, start_line: int | None, end_line: int | None) -> dict[str, Any]:
    """Read a whole file or a 1-based inclusive line slice into a result dict."""
    from pathlib import Path

    path = Path(abs_path)
    if start_line is None:
        return {"path": str(abs_path), "body": path.read_text()}

    start_idx = max(1, start_line)
    selected: list[str] = []
    total = 0
    with path.open() as f:
        for lineno, raw in enumerate(f, start=1):
            total = lineno
            if lineno < start_idx:
                continue
            if end_line is not None and lineno > end_line:
                break
            selected.append(raw.rstrip("\n"))
    resolved_end = end_line if end_line is not None else total
    return {
        "path": str(abs_path),
        "lineRange": f"{start_idx}-{resolved_end}",
        "body": "\n".join(selected),
    }


def _parse_line_range(spec: str) -> tuple[int | None, int | None]:
    """Parse ``"10-25"`` / ``"10-"`` / ``"10"`` into ``(start, end)``."""
    spec = (spec or "").strip()
    if not spec:
        return None, None
    if "-" in spec:
        a, _, b = spec.partition("-")
        return (_to_int(a.strip()), _to_int(b.strip()))
    n = _to_int(spec)
    return n, n


def _load_code_source(
    store: GraphStore,
    node: dict[str, Any],
    node_id: str,
    start_line: int | None,
    end_line: int | None,
) -> dict[str, Any]:
    """Read source for a code-layer node from the repo checkout on disk."""
    props = _props(node)
    file_path = props.get("path")
    # Fall back to the node's own recorded range when no explicit range given.
    if start_line is None and end_line is None:
        start_line = _to_int(props.get("start_line") or props.get("startLine"))
        end_line = _to_int(props.get("end_line") or props.get("endLine"))

    # A symbol node (Function/Class/...) may carry no path itself; it's
    # DEFINED in a File node that does.
    if not file_path:
        try:
            for nb_node, _nb_rel in store._get_neighbors(node_id, "outgoing"):
                if nb_node.get("type") == "File":
                    fp = _props(nb_node).get("path")
                    if fp:
                        file_path = fp
                        break
        except Exception:
            pass

    # Last resort: the path is encoded in the node id (``repo/path::Symbol``).
    if not file_path and "::" in node_id:
        from opentrace_agent.cli.source_search import strip_repo_prefix

        candidate = node_id.split("::", 1)[0]
        repo_ids = sorted(store.list_repository_ids(), key=len, reverse=True)
        stripped = strip_repo_prefix(candidate, repo_ids)
        if stripped:
            file_path = stripped

    if not file_path:
        return {"error": f"node {node_id} (type={node.get('type')}) has no resolvable file path"}

    abs_path = _resolve_repo_file(store, file_path)
    if abs_path is None:
        return {"error": f"source file not found on disk: {file_path}"}

    result = _read_file_slice(abs_path, start_line, end_line)
    return {"nodeId": node_id, "type": node.get("type"), **result}


def _load_corpus_source(store: GraphStore, node: dict[str, Any], node_id: str) -> dict[str, Any]:
    """Read a ``Source`` node's body from the content-addressed corpus snapshot."""
    from pathlib import Path

    props = _props(node)
    corpus_rel = props.get("corpus_path")
    if not corpus_rel:
        return {"error": f"Source {node_id} has no corpus_path"}
    # corpus_path is always a repo-relative ``corpus/<sha>.md`` — reject anything
    # that tries to escape the DB directory.
    if ".." in corpus_rel or corpus_rel.startswith("/"):
        return {"error": f"invalid corpus_path: {corpus_rel}"}
    db_path = getattr(store, "db_path", None)
    if not db_path:
        return {"error": "store has no db_path; cannot locate corpus"}
    body_path = Path(str(db_path)).parent / corpus_rel
    if not body_path.exists():
        return {"error": f"corpus file not found: {body_path}"}
    return {
        "nodeId": node_id,
        "type": "Source",
        "filename": props.get("filename"),
        "sha256": props.get("sha256"),
        "contentType": props.get("content_type"),
        "body": body_path.read_text(encoding="utf-8"),
    }


def _read_wiki_page_body(store: GraphStore, node: dict[str, Any], node_id: str) -> dict[str, Any]:
    """Resolve and read a ``WikiPage`` node's markdown body from disk."""
    from pathlib import Path

    from opentrace_agent.wiki.paths import resolve_vault_scope

    props = _props(node)
    vault = props.get("vault")
    slug = props.get("slug")
    if not vault or not slug:
        return {"error": f"WikiPage {node_id} missing vault/slug properties"}
    # Slug is "<kind_dir>/<base>"; reject any traversal nonsense.
    if ".." in slug or slug.startswith(".") or slug.startswith("/") or slug.endswith("/") or slug.count("/") > 1:
        return {"error": f"invalid slug: {slug}"}

    db_path = Path(str(getattr(store, "db_path", "")))
    project_root = db_path.parent.parent if db_path.parent.name == ".opentrace" else None
    resolved = resolve_vault_scope(vault, project_root=project_root)
    if resolved is None:
        return {"error": f"vault '{vault}' not found on disk (local or global)"}
    scope, vault_dir_path = resolved
    page_path = vault_dir_path / "pages" / f"{slug}.md"
    if not page_path.exists():
        return {"error": f"page file not found: {page_path}"}
    return {
        "nodeId": node_id,
        "type": "WikiPage",
        "vault": vault,
        "slug": slug,
        "scope": scope,
        "body": page_path.read_text(),
    }


def create_mcp_server(store: GraphStore | None) -> FastMCP:
    """Create a FastMCP server with graph query tools backed by *store*.

    When *store* is ``None`` (no database found), every tool returns a
    friendly "no index" response instead of raising an error.
    """
    server = FastMCP("opentrace")

    @server.tool()
    def search_graph(
        query: str,
        limit: int = 25,
        nodeTypes: str = "",
        vaultScope: str = "",
    ) -> str:
        """Ranked FTS search across graph nodes.

        Returns ``{hits, count, query}`` where each hit is
        ``{id, type, name, snippet, score, vault, recency, confidence}``. The
        ``vault`` / ``recency`` / ``confidence`` fields are populated where
        the underlying property is set on the node; otherwise ``null``.
        Optional ``vaultScope`` restricts hits to a single vault by name.
        """
        if not store:
            logger.info("search_graph called but no index exists")
            return NO_INDEX_MSG
        logger.debug(
            "search_graph(query=%r, limit=%d, nodeTypes=%r, vaultScope=%r)",
            query,
            limit,
            nodeTypes,
            vaultScope,
        )
        try:
            node_types = [t.strip() for t in nodeTypes.split(",") if t.strip()] or None
            limit = min(limit, 200)
            scope = vaultScope.strip() or None
            result = _search(
                store,
                query,
                limit=limit,
                node_types=node_types,
                vault_scope=scope,
            )
            return _json_response(result)
        except Exception as e:
            return _error_response("search_graph", e)

    @server.tool()
    def list_nodes(type: str, limit: int = 50, filters: dict[str, Any] | None = None) -> str:
        """List nodes of a specific type.

        Valid types include: Repository, Class, Function, File, Directory,
        Package, Module, Service, Endpoint, Database.
        """
        if not store:
            logger.info("list_nodes called but no index exists")
            return NO_INDEX_MSG
        logger.debug("list_nodes(type=%r, limit=%d, filters=%r)", type, limit, filters)
        try:
            limit = min(limit, 1000)
            nodes = store.list_nodes(node_type=type, filters=filters, limit=limit)
            logger.debug("list_nodes → %d results", len(nodes))
            return _json_response(nodes)
        except Exception as e:
            return _error_response("list_nodes", e)

    @server.tool()
    def get_node(nodeId: str) -> str:
        """Get full details of a single node plus its immediate neighbours.

        Each neighbour entry includes a pre-summarised ``target_summary`` so
        the agent can decide whether to recurse without a follow-up fetch:
        ``one_line_summary`` for vault pages, truncated ``summary``/``name``
        for code nodes.
        """
        if not store:
            logger.info("get_node called but no index exists")
            return NO_INDEX_MSG
        logger.debug("get_node(nodeId=%r)", nodeId)
        try:
            node = store.get_node(nodeId)
            if node is None:
                return json.dumps({"error": f"Node not found: {nodeId}"})

            try:
                neighbors = store.traverse(nodeId, direction="both", max_depth=1)
            except ValueError:
                neighbors = []
            result = {
                "node": node,
                "neighbors": [
                    {
                        "node": n["node"],
                        "relationship": n["relationship"],
                        "target_summary": _neighbour_summary(n["node"]),
                    }
                    for n in neighbors
                ],
            }
            return _json_response(result)
        except Exception as e:
            return _error_response("get_node", e)

    @server.tool()
    def traverse_graph(
        nodeId: str,
        depth: int = 3,
        direction: str = "outgoing",
        relationship: str = "",
        edgeTypes: str = "",
        vaultScope: str = "",
        confidenceThreshold: float = 0.0,
    ) -> str:
        """Walk relationships from a starting node.

        Direction can be 'outgoing', 'incoming', or 'both'.

        Filter the walk by relationship type via either ``relationship`` (a
        single type, e.g. 'CALLS') or ``edgeTypes`` (a comma-separated set,
        e.g. 'CALLS,IMPORTS'). When both are given, ``edgeTypes`` wins.

        Optional ``vaultScope`` restricts traversal to nodes whose ``vault``
        property matches the given vault name. ``confidenceThreshold`` (0.0-1.0)
        skips relationships whose ``properties.confidence`` falls below the
        threshold; values <= 0 disable the filter.
        """
        if not store:
            logger.info("traverse_graph called but no index exists")
            return NO_INDEX_MSG
        logger.debug(
            "traverse_graph(nodeId=%r, depth=%d, direction=%r, relationship=%r, edgeTypes=%r)",
            nodeId,
            depth,
            direction,
            relationship,
            edgeTypes,
        )
        try:
            if direction not in ("outgoing", "incoming", "both"):
                return json.dumps(
                    {"error": f"Invalid direction: {direction}. Must be 'outgoing', 'incoming', or 'both'."}
                )
            depth = min(depth, 10)
            rel_types = [t.strip() for t in edgeTypes.split(",") if t.strip()] or None
            rel_type = relationship if (relationship and not rel_types) else None
            vault = vaultScope.strip() or None
            conf = confidenceThreshold if confidenceThreshold > 0 else None
            results = store.traverse(
                nodeId,
                direction=direction,
                max_depth=depth,
                relationship_type=rel_type,
                relationship_types=rel_types,
                vault_scope=vault,
                confidence_threshold=conf,
            )
            return _json_response(results)
        except ValueError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            return _error_response("traverse_graph", e)

    @server.tool(name="find_path")
    def find_path(
        startId: str,
        endId: str,
        maxHops: int = 5,
        edgeTypes: str = "",
    ) -> str:
        """Find the shortest path between two nodes via outgoing edges.

        Returns a list of {node, relationship, depth} steps from start to end,
        or {path: null} if no path exists within maxHops. Optionally filter
        the walk to specific edge types via a comma-separated edgeTypes list
        (e.g. "CALLS,IMPORTS").
        """
        if not store:
            logger.info("find_path called but no index exists")
            return NO_INDEX_MSG
        try:
            edge_list = [t.strip() for t in edgeTypes.split(",") if t.strip()] or None
            return _json_response(_find_path(store, startId, endId, max_hops=maxHops, edge_types=edge_list))
        except Exception as e:
            return _error_response("find_path", e)

    @server.tool(name="find_orphans")
    def find_orphans(
        nodeType: str,
        edgeType: str,
        direction: str = "incoming",
        limit: int = 1000,
    ) -> str:
        """Find nodes of a given type that have no edges of edgeType in the
        given direction. direction is 'incoming', 'outgoing', or 'both'.

        Use this to find unused functions ('Function', 'CALLS', 'incoming'),
        dangling wiki pages ('WikiPage', 'LINKS_TO', 'incoming'), etc.
        """
        if not store:
            logger.info("find_orphans called but no index exists")
            return NO_INDEX_MSG
        try:
            return _json_response(_find_orphans(store, nodeType, edgeType, direction=direction, limit=limit))
        except ValueError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            return _error_response("find_orphans", e)

    @server.tool(name="find_via_relationship_to_type")
    def find_via_relationship_to_type(
        startType: str,
        edgeType: str,
        targetType: str,
        limit: int = 100,
    ) -> str:
        """Find all (A, B) pairs where A is startType, B is targetType, and a
        relationship of edgeType points from A to B.

        Examples: Functions that CALL Endpoints, WikiPages that CITE Sources.
        """
        if not store:
            logger.info("find_via_relationship_to_type called but no index exists")
            return NO_INDEX_MSG
        try:
            return _json_response(_find_via_relationship_to_type(store, startType, edgeType, targetType, limit=limit))
        except Exception as e:
            return _error_response("find_via_relationship_to_type", e)

    @server.tool(name="count_by")
    def count_by(
        nodeType: str,
        parentId: str = "",
        parentEdge: str = "CONTAINS",
        maxHops: int = 3,
    ) -> str:
        """Count nodes of nodeType, optionally scoped to descendants of parentId
        reachable via parentEdge (e.g. CONTAINS) within maxHops.

        Without parentId: total count across the graph.
        With parentId: count of matching descendants under that parent.
        """
        if not store:
            logger.info("count_by called but no index exists")
            return NO_INDEX_MSG
        try:
            parent = parentId.strip() or None
            return _json_response(
                _count_by(
                    store,
                    nodeType,
                    parent_id=parent,
                    parent_edge=parentEdge,
                    max_hops=maxHops,
                )
            )
        except Exception as e:
            return _error_response("count_by", e)

    @server.tool(name="grep")
    def grep(
        pattern: str,
        scopeId: str,
        fileFilter: str = "",
        caseSensitive: bool = False,
        maxResults: int = 200,
    ) -> str:
        """Regex grep over the on-disk content reachable from a scope node.

        ``scopeId`` is a Repository (with local_path set) or WikiVault id.
        Returns matches with file_path, line_number, line_text, and
        structural_context. Falls back to a structured error when the scope
        has no on-disk content available; agent should then fall back to
        ``search_graph`` for FTS over indexed metadata.
        """
        if not store:
            logger.info("grep called but no index exists")
            return NO_INDEX_MSG
        try:
            return _json_response(
                _grep(
                    store,
                    pattern,
                    scope_id=scopeId,
                    file_filter=fileFilter or None,
                    case_sensitive=caseSensitive,
                    max_results=maxResults,
                )
            )
        except Exception as e:
            return _error_response("grep", e)

    @server.tool(name="provenance")
    def provenance(nodeId: str) -> str:
        """Return the trust chain for a node.

        For wiki pages: agent / model / session / confidence stamped at
        compile time, plus the CITES chain back through any file-summary
        pages to the original Source artefacts (sha256 + filename, no
        retained bytes).

        For code nodes: commit_sha + indexer_version from the per-repo
        IndexMetadata, plus file_path and line_range from the node itself.
        """
        if not store:
            logger.info("provenance called but no index exists")
            return NO_INDEX_MSG
        try:
            return _json_response(_provenance(store, nodeId))
        except Exception as e:
            return _error_response("provenance", e)

    @server.tool(name="overview")
    def overview(topN: int = 5, vaultScope: str = "") -> str:
        """Compact orientation of the indexed graph for agent session start.

        Returns counts by node type, the most-connected concepts, and the
        most recently updated entities. Targets <500 tokens. Optional
        ``vaultScope`` is reserved for the vault-graph rollout — currently
        no-op.
        """
        if not store:
            logger.info("overview called but no index exists")
            return NO_INDEX_MSG
        try:
            scope = vaultScope.strip() or None
            return _json_response(_overview(store, top_n=topN, vault_scope=scope))
        except Exception as e:
            return _error_response("overview", e)

    @server.tool()
    def get_communities(limit: int = 100) -> str:
        """List detected communities (Leiden/Louvain clusters) with cohesion and member counts.

        Run ``opentraceai cluster`` first to populate community membership.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            rows = _list_communities(store)[: min(limit, 1000)]
            return _json_response(rows)
        except Exception as e:
            return _error_response("get_communities", e)

    @server.tool()
    def get_god_nodes(limit: int = 20) -> str:
        """List top-degree non-internal nodes — the centrality hubs of the graph.

        Useful as the first thing to check when exploring an unfamiliar codebase.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            return _json_response(_god_nodes(store, limit=min(limit, 200)))
        except Exception as e:
            return _error_response("get_god_nodes", e)

    @server.tool()
    def get_bridges(limit: int = 50) -> str:
        """List edges whose endpoints belong to different communities.

        Cross-community edges are the bridges that hold otherwise distinct
        regions of the graph together — useful for orienting on which
        components are coupling concerns that look unrelated by name.
        Run ``opentraceai cluster`` first; empty until communities exist.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            return _json_response(_cross_community_bridges(store, limit=min(limit, 500)))
        except Exception as e:
            return _error_response("get_bridges", e)

    @server.tool()
    def get_stats() -> str:
        """Get graph statistics: total node count, total edge count, and node counts broken down by type.

        Use this as a first step to understand what has been indexed before running targeted queries.
        """
        if not store:
            logger.info("get_stats called but no index exists")
            return NO_INDEX_MSG
        logger.debug("get_stats()")
        try:
            stats = store.get_stats()
            logger.debug("get_stats → %d nodes, %d edges", stats["total_nodes"], stats["total_edges"])
            return _json_response(stats)
        except Exception as e:
            return _error_response("get_stats", e)

    @server.tool()
    def list_vaults() -> str:
        """List WikiVault nodes present in the current graph.

        Returns ``{vaults: [{name, scope, last_compiled_at, summary}]}``.
        Empty unless a vault has been compiled via ``opentraceai index
        --wiki`` or attached via ``opentraceai vault attach``.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            nodes = store.list_nodes(node_type="WikiVault", limit=1000)
            vaults = []
            for n in nodes:
                props = n.get("properties") or {}
                vaults.append(
                    {
                        "name": props.get("vault") or n.get("name"),
                        "scope": props.get("scope"),
                        "last_compiled_at": props.get("last_compiled_at"),
                        "summary": props.get("summary"),
                    }
                )
            return _json_response({"vaults": vaults})
        except Exception as e:
            return _error_response("list_vaults", e)

    @server.tool()
    def list_vault_pages(vault: str, kind: str = "", limit: int = 200) -> str:
        """List WikiPage nodes in a vault.

        Optional ``kind`` filter: ``"concept"`` or ``"file_summary"``
        (default: both). Returns ``{vault, count, pages}`` where each page
        carries ``{id, slug, title, kind, one_line_summary, revision,
        last_updated}``. Use ``read_vault_page`` with the returned ``id``
        to fetch the page body.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            filters: dict[str, Any] = {"vault": vault}
            if kind.strip():
                filters["kind"] = kind.strip()
            cap = min(limit, 1000)
            nodes = store.list_nodes(node_type="WikiPage", filters=filters, limit=cap)
            pages = []
            for n in nodes:
                props = n.get("properties") or {}
                pages.append(
                    {
                        "id": n.get("id"),
                        "slug": props.get("slug"),
                        "title": n.get("name"),
                        "kind": props.get("kind"),
                        "one_line_summary": props.get("one_line_summary"),
                        "revision": props.get("revision"),
                        "last_updated": props.get("last_updated"),
                    }
                )
            return _json_response({"vault": vault, "count": len(pages), "pages": pages})
        except Exception as e:
            return _error_response("list_vault_pages", e)

    @server.tool()
    def read_vault_page(nodeId: str) -> str:
        """Return the full markdown body of a WikiPage from disk.

        WikiPage bodies live at ``<vault_dir>/pages/<slug>.md`` (the graph
        node carries metadata only — LadybugDB caps STRING properties at
        ~4 KB, wiki pages run 5–20 KB). Resolves the vault's on-disk
        location via local-then-global scope lookup, rooted at the graph's
        project directory (the parent of ``.opentrace/``).

        Returns ``{nodeId, vault, slug, scope, body}``.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            node = store.get_node(nodeId)
            if not node:
                return json.dumps({"error": f"node not found: {nodeId}"})
            if node.get("type") != "WikiPage":
                return json.dumps({"error": f"node {nodeId} is not a WikiPage (type={node.get('type')})"})
            # Wiki page bodies are 5–20 KB by design; bypass the 4 KB
            # truncation in ``_json_response`` that would chop a page body.
            return _dump_body_result(_read_wiki_page_body(store, node, nodeId))
        except Exception as e:
            return _error_response("read_vault_page", e)

    @server.tool()
    def load_source(nodeId: str, lineRange: str = "") -> str:
        """Read the underlying content for a graph node, dispatching by type.

        One read primitive across every content layer — the node is the
        pointer, this tool returns the bytes:

        - **Code** nodes (``Function`` / ``Class`` / ``File`` / ``Variable`` /
          …) → source read from the indexed repo checkout. Defaults to the
          node's own recorded line range; pass ``lineRange`` (``"10-25"``,
          ``"10-"``, or ``"10"``) to override, or read a whole ``File``.
        - **Source** nodes (ingested docs) → the document body from the
          content-addressed corpus snapshot (``corpus/<sha>.md``), independent
          of the working tree.
        - **WikiPage** nodes → the compiled markdown page body (same as
          ``read_vault_page``).

        Returns ``{nodeId, type, body, …}``; ``body`` is soft-capped and
        flagged with ``truncated``/``totalChars`` when very large.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            node = store.get_node(nodeId)
            if not node:
                return json.dumps({"error": f"node not found: {nodeId}"})
            node_type = node.get("type")
            if node_type == "Source":
                return _dump_body_result(_load_corpus_source(store, node, nodeId))
            if node_type == "WikiPage":
                return _dump_body_result(_read_wiki_page_body(store, node, nodeId))
            start_line, end_line = _parse_line_range(lineRange)
            return _dump_body_result(_load_code_source(store, node, nodeId, start_line, end_line))
        except Exception as e:
            return _error_response("load_source", e)

    @server.tool()
    def find_pages_mentioning(entityId: str) -> str:
        """Find WikiPages whose body mentions a given entity, OR pages
        that discuss a given code symbol.

        MENTIONS edges only target the entity layer (``Idea`` / ``Service``
        / ``Module`` / ``Paper`` / ``Person`` / ``Event``). If you pass a
        code-layer node id (``Function`` / ``Class`` / ``Variable`` /
        ``File`` / …) directly and the literal traversal returns nothing,
        this tool falls back to a fuzzy entity lookup: it strips any
        trailing Python signature from the symbol name (so
        ``field_validator(str, …)`` becomes ``field_validator``) and then
        finds entities whose name *contains* the bare symbol name (e.g.
        ``"field_validator decorator"`` or ``"@field_validator"``). The
        MENTIONS pages from every match are unioned and returned — so
        "find pages about this function" works without manually chaining
        an entity lookup first.

        Returns ``{entityId, count, pages}``.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            pages = _find_pages_mentioning(store, entityId)
            # Trim each page to the agent-essential fields and bypass the
            # 4 KB truncation cap — find_pages_mentioning can legitimately
            # return 30+ pages whose unabbreviated property dicts overflow
            # the response budget and chop the JSON mid-string.
            trimmed = [
                {
                    "id": p.get("id"),
                    "name": p.get("name"),
                    "slug": (p.get("properties") or {}).get("slug"),
                    "kind": (p.get("properties") or {}).get("kind"),
                    "one_line_summary": (p.get("properties") or {}).get("one_line_summary"),
                }
                for p in pages
            ]
            return json.dumps(
                {"entityId": entityId, "count": len(trimmed), "pages": trimmed},
                default=str,
            )
        except Exception as e:
            return _error_response("find_pages_mentioning", e)

    @server.tool()
    def find_entities_mentioned_by(pageId: str) -> str:
        """Find entities mentioned by a given WikiPage.

        Forward-traverses MENTIONS edges. Returns
        ``{pageId, count, entities}``.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            entities = _find_entities_mentioned_by(store, pageId)
            return _json_response({"pageId": pageId, "count": len(entities), "entities": entities})
        except Exception as e:
            return _error_response("find_entities_mentioned_by", e)

    @server.tool()
    def find_cross_cutting_communities(min_domains: int = 2, limit: int = 50) -> str:
        """List Communities whose members span ≥``min_domains`` of the three
        domains (code / entity / page).

        Requires ``opentraceai cluster`` to have been run first; returns an
        empty list when no Community nodes exist.
        """
        if not store:
            return NO_INDEX_MSG
        try:
            cap = min(limit, 500)
            result = _find_communities_spanning_domains(store, min_domains=min_domains, limit=cap)
            return _json_response(result)
        except Exception as e:
            return _error_response("find_cross_cutting_communities", e)

    return server
