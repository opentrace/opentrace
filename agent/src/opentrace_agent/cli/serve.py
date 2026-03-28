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

"""HTTP server exposing the LadybugDB graph store as a REST API.

Replaces the in-browser WASM LadybugDB with a server-backed store.
The UI can point at this endpoint instead of loading the WASM engine.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from opentrace_agent.store import GraphStore

logger = logging.getLogger(__name__)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


async def _read_json(request: Request) -> Any:
    try:
        return await request.json()
    except Exception:
        return None


def create_app(store: GraphStore) -> Starlette:
    """Create a Starlette ASGI app exposing *store* as a REST API."""

    async def get_stats(request: Request) -> JSONResponse:
        """GET /api/stats"""
        data = store.get_stats()
        return JSONResponse(data)

    async def fetch_graph(request: Request) -> JSONResponse:
        """GET /api/graph?query=&hops="""
        query = request.query_params.get("query", "")
        hops = int(request.query_params.get("hops", "2"))
        if not query:
            return JSONResponse({"nodes": [], "links": []})
        nodes, relationships = store.search_graph(query, hops=hops)
        links = [
            {
                "source": r["source_id"],
                "target": r["target_id"],
                "type": r["type"],
                "id": r["id"],
                "properties": r.get("properties"),
            }
            for r in relationships
        ]
        return JSONResponse({"nodes": nodes, "links": links})

    async def search_nodes(request: Request) -> JSONResponse:
        """GET /api/nodes/search?query=&limit=&nodeTypes="""
        query = request.query_params.get("query", "")
        if not query:
            return JSONResponse([])
        limit = int(request.query_params.get("limit", "50"))
        node_types_param = request.query_params.get("nodeTypes", "")
        node_types = [t.strip() for t in node_types_param.split(",") if t.strip()] or None
        results = store.search_nodes(query, node_types=node_types, limit=limit)
        return JSONResponse(results)

    async def list_nodes(request: Request) -> JSONResponse:
        """GET /api/nodes/list?type=&limit=&filters="""
        node_type = request.query_params.get("type", "")
        if not node_type:
            return _error(400, "Missing required parameter: type")
        limit = int(request.query_params.get("limit", "50"))
        filters_param = request.query_params.get("filters", "")
        filters = json.loads(filters_param) if filters_param else None
        results = store.list_nodes(node_type=node_type, filters=filters, limit=limit)
        return JSONResponse(results)

    async def get_node(request: Request) -> JSONResponse:
        """GET /api/nodes/{node_id}"""
        node_id = request.path_params["node_id"]
        node = store.get_node(node_id)
        if node is None:
            return _error(404, f"Node not found: {node_id}")
        return JSONResponse(node)

    async def traverse(request: Request) -> JSONResponse:
        """POST /api/traverse"""
        body = await _read_json(request)
        if not body or "nodeId" not in body:
            return _error(400, "Missing required field: nodeId")
        node_id = body["nodeId"]
        direction = body.get("direction", "outgoing")
        max_depth = int(body.get("maxDepth", 3))
        rel_type = body.get("relType") or None
        if direction not in ("outgoing", "incoming", "both"):
            return _error(400, f"Invalid direction: {direction}")
        try:
            results = store.traverse(
                node_id, direction=direction, max_depth=max_depth, relationship_type=rel_type
            )
        except ValueError as e:
            return _error(404, str(e))
        return JSONResponse(results)

    async def health(request: Request) -> JSONResponse:
        """GET /api/health"""
        return JSONResponse({"status": "ok"})

    routes = [
        Route("/api/health", health, methods=["GET"]),
        Route("/api/stats", get_stats, methods=["GET"]),
        Route("/api/graph", fetch_graph, methods=["GET"]),
        Route("/api/nodes/search", search_nodes, methods=["GET"]),
        Route("/api/nodes/list", list_nodes, methods=["GET"]),
        Route("/api/nodes/{node_id:path}", get_node, methods=["GET"]),
        Route("/api/traverse", traverse, methods=["POST"]),
    ]

    middleware = [
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["*"],
            allow_headers=["*"],
        ),
    ]

    return Starlette(routes=routes, middleware=middleware)
