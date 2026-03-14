"""MCP server exposing KuzuStore as graph tools.

Mirrors the Go MCP tools in ``api/pkg/mcp/tools.go`` — same tool names,
same parameter schemas, same response shapes.
"""

from __future__ import annotations

import json
from typing import Any

from mcp.server.fastmcp import FastMCP

from opentrace_agent.store.constants import VALID_NODE_TYPES
from opentrace_agent.store.kuzu_store import KuzuStore


def create_mcp_server(store: KuzuStore) -> FastMCP:
    """Build a FastMCP server with graph tools backed by *store*."""
    mcp = FastMCP("opentrace")

    @mcp.tool()
    def query_graph(
        query: str | None = None,
        nodeType: str | None = None,
        filters: dict[str, Any] | None = None,
        limit: int = 50,
    ) -> str:
        """Search or list nodes in the OpenTrace knowledge graph.

        Provide 'query' for text search, or 'nodeType' to list by type.
        """
        limit = _clamp(limit, 1, 1000, 50)

        if nodeType and nodeType not in VALID_NODE_TYPES:
            valid = ", ".join(sorted(VALID_NODE_TYPES))
            return json.dumps({
                "error": f"invalid nodeType {nodeType!r} — valid: {valid}",
            })

        # Text search path
        if query:
            node_types = [nodeType] if nodeType else None
            nodes = store.search_nodes(query, node_types=node_types, limit=limit)
            return _to_json({"results": nodes, "count": len(nodes)})

        # List-by-type path
        if nodeType:
            nodes = store.list_nodes(nodeType, filters=filters, limit=limit)
            return _to_json({"results": nodes, "count": len(nodes)})

        return json.dumps({
            "error": "provide either 'query' or 'nodeType'",
        })

    @mcp.tool()
    def get_node(node_id: str) -> str:
        """Fetch a node by ID with its immediate neighbors."""
        node = store.get_node(node_id)
        if node is None:
            return json.dumps({"error": f"node not found: {node_id}"})

        try:
            neighbors = store.traverse(node_id, direction="both", max_depth=1)
        except Exception:
            neighbors = []

        return _to_json({"node": node, "neighbors": neighbors})

    @mcp.tool()
    def traverse_graph(
        node_id: str,
        direction: str = "outgoing",
        max_depth: int = 3,
        relationship_type: str | None = None,
    ) -> str:
        """Walk the graph from a starting node up to a given depth."""
        max_depth = _clamp(max_depth, 1, 10, 3)
        if direction not in ("outgoing", "incoming", "both"):
            direction = "outgoing"

        try:
            results = store.traverse(
                node_id,
                direction=direction,
                max_depth=max_depth,
                relationship_type=relationship_type or "",
            )
        except ValueError as exc:
            return json.dumps({"error": str(exc)})

        return _to_json({
            "start_node": node_id,
            "direction": direction,
            "max_depth": max_depth,
            "results": results,
            "count": len(results),
        })

    @mcp.tool()
    def search_graph(
        query: str,
        hops: int = 2,
        node_types: str | None = None,
        limit: int = 50,
    ) -> str:
        """Search nodes by name and return a subgraph with their relationships.

        Use hops to expand the neighborhood around matches.
        """
        hops = _clamp(hops, 0, 5, 2)
        limit = _clamp(limit, 1, 1000, 50)

        nodes, rels = store.search_graph(query, hops=hops, limit=limit)

        # Apply optional node type filter
        if node_types:
            type_set = {t.strip() for t in node_types.split(",") if t.strip()}
            if type_set:
                nodes = [n for n in nodes if n["type"] in type_set]

        return _to_json({
            "nodes": nodes,
            "relationships": rels,
            "node_count": len(nodes),
            "relationship_count": len(rels),
        })

    return mcp


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _clamp(value: int, lo: int, hi: int, default: int) -> int:
    if value < lo or value > hi:
        return default
    return value


def _to_json(obj: Any) -> str:
    return json.dumps(obj, default=str)
