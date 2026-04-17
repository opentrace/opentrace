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


NO_INDEX_MSG = json.dumps(
    {
        "status": "ok",
        "message": "No index available. Run 'opentraceai index' to create one.",
    }
)


def create_mcp_server(store: GraphStore | None) -> FastMCP:
    """Create a FastMCP server with graph query tools backed by *store*.

    When *store* is ``None`` (no database found), every tool returns a
    friendly "no index" response instead of raising an error.
    """
    server = FastMCP("opentrace")

    @server.tool()
    def search_graph(query: str, limit: int = 50, nodeTypes: str = "") -> str:
        """Full-text search across graph nodes by name or properties.

        Returns matching nodes with their types and properties.
        """
        if not store:
            logger.info("search_graph called but no index exists")
            return NO_INDEX_MSG
        logger.debug("search_graph(query=%r, limit=%d, nodeTypes=%r)", query, limit, nodeTypes)
        try:
            node_types = [t.strip() for t in nodeTypes.split(",") if t.strip()] or None
            limit = min(limit, 1000)
            nodes = store.search_nodes(query, node_types=node_types, limit=limit)
            logger.debug("search_graph → %d results", len(nodes))
            return _json_response(nodes)
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
        """Get full details of a single node by its ID, including all properties and immediate neighbors."""
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
                "neighbors": [{"node": n["node"], "relationship": n["relationship"]} for n in neighbors],
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
    ) -> str:
        """Walk relationships from a starting node.

        Direction can be 'outgoing', 'incoming', or 'both'.
        Optionally filter by relationship type (e.g. 'CALLS', 'DEFINES', 'CONTAINS').
        """
        if not store:
            logger.info("traverse_graph called but no index exists")
            return NO_INDEX_MSG
        logger.debug(
            "traverse_graph(nodeId=%r, depth=%d, direction=%r, relationship=%r)",
            nodeId,
            depth,
            direction,
            relationship,
        )
        try:
            if direction not in ("outgoing", "incoming", "both"):
                return json.dumps(
                    {"error": f"Invalid direction: {direction}. Must be 'outgoing', 'incoming', or 'both'."}
                )
            depth = min(depth, 10)
            rel_type = relationship if relationship else None
            results = store.traverse(
                nodeId,
                direction=direction,
                max_depth=depth,
                relationship_type=rel_type,
            )
            return _json_response(results)
        except ValueError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            return _error_response("traverse_graph", e)

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

    return server
