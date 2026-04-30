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
from starlette.responses import JSONResponse, StreamingResponse
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


def create_app(store: GraphStore | None) -> Starlette:
    """Create a Starlette ASGI app exposing *store* as a REST API.

    When *store* is ``None``, the graph routes (``/api/stats``,
    ``/api/graph``, etc.) are omitted; only ``/api/health`` and the vault
    routes are mounted. This is the vault-only mode used when no
    ``.opentrace/index.db`` is available.
    """

    async def get_stats(request: Request) -> JSONResponse:
        """GET /api/stats"""
        data = store.get_stats()
        return JSONResponse(data)

    async def fetch_graph(request: Request) -> JSONResponse:
        """GET /api/graph?query=&hops=&limit=

        When *query* is empty, returns all nodes and relationships (capped by
        *limit*, default 10 000) so the UI can render the full graph on initial load.
        """
        query = request.query_params.get("query", "")
        try:
            hops = int(request.query_params.get("hops", "2"))
        except ValueError:
            return _error(400, "Invalid parameter: hops must be an integer")
        try:
            limit = int(request.query_params.get("limit", "10000"))
        except ValueError:
            return _error(400, "Invalid parameter: limit must be an integer")

        if not query:
            # Return all nodes (across all types) and their relationships
            all_nodes: list[dict] = []
            stats = store.get_stats()
            for ntype in stats.get("nodes_by_type", {}):
                all_nodes.extend(store.list_nodes(node_type=ntype, limit=limit))
                if len(all_nodes) >= limit:
                    break
            all_nodes = all_nodes[:limit]

            node_ids = {n["id"] for n in all_nodes}
            all_rels = store.list_relationships_for_nodes(node_ids, limit * 2)
            links = [
                {
                    "source": r["source_id"],
                    "target": r["target_id"],
                    "type": r["type"],
                    "id": r["id"],
                    "properties": r.get("properties"),
                }
                for r in all_rels
            ]
            return JSONResponse({"nodes": all_nodes, "links": links})

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
        try:
            limit = int(request.query_params.get("limit", "50"))
        except ValueError:
            return _error(400, "Invalid parameter: limit must be an integer")
        node_types_param = request.query_params.get("nodeTypes", "")
        node_types = [t.strip() for t in node_types_param.split(",") if t.strip()] or None
        results = store.search_nodes(query, node_types=node_types, limit=limit)
        return JSONResponse(results)

    async def list_nodes(request: Request) -> JSONResponse:
        """GET /api/nodes/list?type=&limit=&filters="""
        node_type = request.query_params.get("type", "")
        if not node_type:
            return _error(400, "Missing required parameter: type")
        try:
            limit = int(request.query_params.get("limit", "50"))
            filters_param = request.query_params.get("filters", "")
            filters = json.loads(filters_param) if filters_param else None
        except (ValueError, json.JSONDecodeError) as e:
            return _error(400, f"Invalid parameter: {e}")
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
        try:
            max_depth = int(body.get("maxDepth", 3))
        except (ValueError, TypeError):
            return _error(400, "Invalid field: maxDepth must be an integer")
        rel_type = body.get("relType") or None
        if direction not in ("outgoing", "incoming", "both"):
            return _error(400, f"Invalid direction: {direction}")
        try:
            results = store.traverse(node_id, direction=direction, max_depth=max_depth, relationship_type=rel_type)
        except ValueError as e:
            return _error(404, str(e))
        return JSONResponse(results)

    async def get_metadata(request: Request) -> JSONResponse:
        """GET /api/metadata"""
        return JSONResponse(store.get_metadata())

    async def health(request: Request) -> JSONResponse:
        """GET /api/health"""
        return JSONResponse({"status": "ok"})

    routes: list[Route] = [Route("/api/health", health, methods=["GET"])]
    if store is not None:
        routes.extend(
            [
                Route("/api/stats", get_stats, methods=["GET"]),
                Route("/api/metadata", get_metadata, methods=["GET"]),
                Route("/api/graph", fetch_graph, methods=["GET"]),
                Route("/api/nodes/search", search_nodes, methods=["GET"]),
                Route("/api/nodes/list", list_nodes, methods=["GET"]),
                Route("/api/nodes/{node_id:path}", get_node, methods=["GET"]),
                Route("/api/traverse", traverse, methods=["POST"]),
            ]
        )
    routes.extend(_vault_routes())

    middleware = [
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["*"],
            allow_headers=["*"],
        ),
    ]

    return Starlette(routes=routes, middleware=middleware)


# ---------------------------------------------------------------------------
# Vault routes (knowledge compilation v1, OT-1733)
# ---------------------------------------------------------------------------


def _vault_routes() -> list[Route]:
    async def list_vaults_route(request: Request) -> JSONResponse:
        from opentrace_agent.wiki.paths import list_vaults

        return JSONResponse({"vaults": list_vaults()})

    async def list_pages_route(request: Request) -> JSONResponse:
        from opentrace_agent.wiki.paths import metadata_path
        from opentrace_agent.wiki.paths import InvalidVaultName
        from opentrace_agent.wiki.vault import load_metadata

        name = request.path_params["vault"]
        try:
            mp = metadata_path(name)
        except InvalidVaultName as e:
            return _error(400, str(e))
        if not mp.exists():
            return _error(404, f"Vault not found: {name}")
        meta = load_metadata(mp, name=name)
        pages = [
            {
                "slug": p.slug,
                "title": p.title,
                "one_line_summary": p.one_line_summary,
                "revision": p.revision,
                "last_updated": p.last_updated,
                "kind": p.kind,
            }
            for p in meta.pages.values()
        ]
        pages.sort(key=lambda p: (p["title"].lower(), p["slug"]))
        return JSONResponse(
            {
                "name": meta.name,
                "last_compiled_at": meta.last_compiled_at,
                "pages": pages,
            }
        )

    async def get_page_route(request: Request) -> JSONResponse:
        from starlette.responses import PlainTextResponse

        from opentrace_agent.wiki.paths import InvalidVaultName, pages_dir

        name = request.path_params["vault"]
        slug = request.path_params["slug"]
        # Slug must look like a slug — no separators.
        if "/" in slug or ".." in slug or slug.startswith("."):
            return _error(400, f"invalid slug: {slug}")
        try:
            pd = pages_dir(name)
        except InvalidVaultName as e:
            return _error(400, str(e))
        page_path = pd / f"{slug}.md"
        if not page_path.exists():
            return _error(404, f"Page not found: {slug}")
        return PlainTextResponse(page_path.read_text(), media_type="text/markdown")

    async def compile_route(request: Request) -> "StreamingResponse | JSONResponse":
        from opentrace_agent.wiki import SourceInput, run_compile
        from opentrace_agent.wiki.ingest.types import WikiEventKind
        from opentrace_agent.wiki.paths import InvalidVaultName, validate_vault_name

        name = request.path_params["vault"]
        try:
            validate_vault_name(name)
        except InvalidVaultName as e:
            return _error(400, str(e))

        form = await request.form()
        api_key = (form.get("api_key") or "").strip() or None
        provider = (form.get("provider") or "anthropic").strip() or "anthropic"
        model = (form.get("model") or "").strip() or None
        files = (
            form.getlist("files") if hasattr(form, "getlist") else [v for k, v in form.multi_items() if k == "files"]
        )
        if not files:
            return _error(400, "no files uploaded")

        inputs: list[SourceInput] = []
        for f in files:
            if hasattr(f, "read"):
                data = await f.read()
                fname = getattr(f, "filename", "uploaded") or "uploaded"
                inputs.append(SourceInput(name=fname, data=data))

        async def event_stream():
            # Wrap the entire pipeline so any exception (LLM failures, OS
            # errors, validation) becomes a final NDJSON line instead of a
            # silently-truncated stream. Without this, an unhandled raise
            # tears the chunked transfer down with ERR_INCOMPLETE_CHUNKED_ENCODING.
            try:
                for event in run_compile(
                    name,
                    inputs,
                    provider=provider,
                    api_key=api_key,
                    model=model,
                ):
                    payload = {
                        "kind": event.kind.value,
                        "phase": event.phase.value,
                        "message": event.message,
                        "current": event.current,
                        "total": event.total,
                        "file_name": event.file_name,
                        "detail": event.detail,
                        "errors": event.errors,
                    }
                    yield json.dumps(payload) + "\n"
                    if event.kind == WikiEventKind.DONE:
                        return
            except Exception as e:
                logger.exception("compile pipeline failed")
                yield (
                    json.dumps(
                        {
                            "kind": "error",
                            "phase": "executing",
                            "message": f"{type(e).__name__}: {e}",
                        }
                    )
                    + "\n"
                )

        return StreamingResponse(event_stream(), media_type="application/x-ndjson")

    async def delete_vault_route(request: Request) -> JSONResponse:
        from opentrace_agent.wiki.paths import (
            InvalidVaultName,
            delete_vault as _delete_vault,
        )

        name = request.path_params["vault"]
        try:
            existed = _delete_vault(name)
        except InvalidVaultName as e:
            return _error(400, str(e))
        if not existed:
            return _error(404, f"Vault not found: {name}")
        return JSONResponse({"deleted": name})

    return [
        Route("/api/vaults", list_vaults_route, methods=["GET"]),
        Route("/api/vaults/{vault}/pages", list_pages_route, methods=["GET"]),
        Route("/api/vaults/{vault}/pages/{slug}", get_page_route, methods=["GET"]),
        Route("/api/vaults/{vault}/compile", compile_route, methods=["POST"]),
        Route("/api/vaults/{vault}", delete_vault_route, methods=["DELETE"]),
    ]
