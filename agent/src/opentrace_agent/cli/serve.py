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

from opentrace_agent.retrieval import (
    count_by,
    cross_community_bridges,
    find_orphans,
    find_path,
    find_via_relationship_to_type,
    god_nodes,
    grep,
    list_communities,
    overview,
    provenance,
    search,
)
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
        rel_types = body.get("relTypes") or None
        if rel_types is not None and not isinstance(rel_types, list):
            return _error(400, "relTypes must be a list of strings")
        vault_scope = body.get("vaultScope") or None
        conf_raw = body.get("confidenceThreshold")
        try:
            conf = float(conf_raw) if conf_raw is not None else None
        except (ValueError, TypeError):
            return _error(400, "confidenceThreshold must be a number")
        if direction not in ("outgoing", "incoming", "both"):
            return _error(400, f"Invalid direction: {direction}")
        try:
            results = store.traverse(
                node_id,
                direction=direction,
                max_depth=max_depth,
                relationship_type=rel_type,
                relationship_types=rel_types,
                vault_scope=vault_scope,
                confidence_threshold=conf,
            )
        except ValueError as e:
            return _error(404, str(e))
        return JSONResponse(results)

    async def get_metadata(request: Request) -> JSONResponse:
        """GET /api/metadata"""
        return JSONResponse(store.get_metadata())

    async def health(request: Request) -> JSONResponse:
        """GET /api/health"""
        return JSONResponse({"status": "ok"})

    # --- Knowledge-graph highlights (communities / gods / bridges / questions) ---

    async def get_communities(request: Request) -> JSONResponse:
        """GET /api/communities — list detected communities."""
        return JSONResponse(list_communities(store))

    async def get_god_nodes(request: Request) -> JSONResponse:
        """GET /api/highlights/gods?limit=N — top-degree non-internal nodes."""
        try:
            limit = int(request.query_params.get("limit", "20"))
        except ValueError:
            return _error(400, "Invalid parameter: limit must be an integer")
        return JSONResponse(god_nodes(store, limit=limit))

    async def get_bridges(request: Request) -> JSONResponse:
        """GET /api/highlights/bridges?limit=N — cross-community edges."""
        try:
            limit = int(request.query_params.get("limit", "50"))
        except ValueError:
            return _error(400, "Invalid parameter: limit must be an integer")
        return JSONResponse(cross_community_bridges(store, limit=limit))

    async def get_questions(request: Request) -> JSONResponse:
        """GET /api/highlights/questions — deterministic suggested questions.

        Seeded by the top god nodes + bridges. Replaced by LLM-generated
        questions once the extraction pipeline is wired in.
        """
        from opentrace_agent.cli.analyze_cmd import _suggested_questions

        gods = god_nodes(store, limit=10)
        bridges = cross_community_bridges(store, limit=10)
        return JSONResponse(_suggested_questions(gods, bridges))

    # --- OT-1732 retrieval primitives ---

    async def find_path_route(request: Request) -> JSONResponse:
        """POST /api/retrieval/find_path"""
        body = await _read_json(request) or {}
        start_id = body.get("startId")
        end_id = body.get("endId")
        if not start_id or not end_id:
            return _error(400, "missing required fields: startId, endId")
        try:
            max_hops = int(body.get("maxHops", 5))
        except (ValueError, TypeError):
            return _error(400, "maxHops must be an integer")
        edge_types = body.get("edgeTypes") or None
        if edge_types is not None and not isinstance(edge_types, list):
            return _error(400, "edgeTypes must be a list of strings")
        return JSONResponse(find_path(store, start_id, end_id, max_hops=max_hops, edge_types=edge_types))

    async def find_orphans_route(request: Request) -> JSONResponse:
        """POST /api/retrieval/find_orphans"""
        body = await _read_json(request) or {}
        node_type = body.get("nodeType")
        edge_type = body.get("edgeType")
        if not node_type or not edge_type:
            return _error(400, "missing required fields: nodeType, edgeType")
        direction = body.get("direction", "incoming")
        try:
            limit = int(body.get("limit", 1000))
        except (ValueError, TypeError):
            return _error(400, "limit must be an integer")
        try:
            return JSONResponse(find_orphans(store, node_type, edge_type, direction=direction, limit=limit))
        except ValueError as e:
            return _error(400, str(e))

    async def find_via_route(request: Request) -> JSONResponse:
        """POST /api/retrieval/find_via_relationship_to_type"""
        body = await _read_json(request) or {}
        start_type = body.get("startType")
        edge_type = body.get("edgeType")
        target_type = body.get("targetType")
        if not start_type or not edge_type or not target_type:
            return _error(400, "missing required fields: startType, edgeType, targetType")
        try:
            limit = int(body.get("limit", 100))
        except (ValueError, TypeError):
            return _error(400, "limit must be an integer")
        return JSONResponse(find_via_relationship_to_type(store, start_type, edge_type, target_type, limit=limit))

    async def grep_route(request: Request) -> JSONResponse:
        """POST /api/retrieval/grep"""
        body = await _read_json(request) or {}
        pattern = body.get("pattern")
        scope_id = body.get("scopeId")
        if not pattern or not scope_id:
            return _error(400, "missing required fields: pattern, scopeId")
        file_filter = body.get("fileFilter") or None
        case_sensitive = bool(body.get("caseSensitive", False))
        try:
            max_results = int(body.get("maxResults", 200))
        except (ValueError, TypeError):
            return _error(400, "maxResults must be an integer")
        return JSONResponse(
            grep(
                store,
                pattern,
                scope_id=scope_id,
                file_filter=file_filter,
                case_sensitive=case_sensitive,
                max_results=max_results,
            )
        )

    async def provenance_route(request: Request) -> JSONResponse:
        """POST /api/retrieval/provenance"""
        body = await _read_json(request) or {}
        node_id = body.get("nodeId")
        if not node_id:
            return _error(400, "missing required field: nodeId")
        return JSONResponse(provenance(store, node_id))

    async def search_route(request: Request) -> JSONResponse:
        """POST /api/retrieval/search"""
        body = await _read_json(request) or {}
        query = body.get("query")
        if not query:
            return _error(400, "missing required field: query")
        try:
            limit = int(body.get("limit", 25))
        except (ValueError, TypeError):
            return _error(400, "limit must be an integer")
        node_types = body.get("nodeTypes") or None
        if node_types is not None and not isinstance(node_types, list):
            return _error(400, "nodeTypes must be a list of strings")
        vault_scope = body.get("vaultScope") or None
        return JSONResponse(
            search(
                store,
                query,
                limit=limit,
                node_types=node_types,
                vault_scope=vault_scope,
            )
        )

    async def overview_route(request: Request) -> JSONResponse:
        """POST /api/retrieval/overview"""
        body = await _read_json(request) or {}
        try:
            top_n = int(body.get("topN", 5))
        except (ValueError, TypeError):
            return _error(400, "topN must be an integer")
        vault_scope = body.get("vaultScope") or None
        return JSONResponse(overview(store, top_n=top_n, vault_scope=vault_scope))

    async def count_by_route(request: Request) -> JSONResponse:
        """POST /api/retrieval/count_by"""
        body = await _read_json(request) or {}
        node_type = body.get("nodeType")
        if not node_type:
            return _error(400, "missing required field: nodeType")
        parent_id = body.get("parentId") or None
        parent_edge = body.get("parentEdge", "CONTAINS")
        try:
            max_hops = int(body.get("maxHops", 3))
        except (ValueError, TypeError):
            return _error(400, "maxHops must be an integer")
        return JSONResponse(
            count_by(
                store,
                node_type,
                parent_id=parent_id,
                parent_edge=parent_edge,
                max_hops=max_hops,
            )
        )

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
                Route("/api/retrieval/find_path", find_path_route, methods=["POST"]),
                Route("/api/retrieval/find_orphans", find_orphans_route, methods=["POST"]),
                Route(
                    "/api/retrieval/find_via_relationship_to_type",
                    find_via_route,
                    methods=["POST"],
                ),
                Route("/api/retrieval/count_by", count_by_route, methods=["POST"]),
                Route("/api/retrieval/overview", overview_route, methods=["POST"]),
                Route("/api/retrieval/search", search_route, methods=["POST"]),
                Route("/api/retrieval/provenance", provenance_route, methods=["POST"]),
                Route("/api/retrieval/grep", grep_route, methods=["POST"]),
                Route("/api/communities", get_communities, methods=["GET"]),
                Route("/api/highlights/gods", get_god_nodes, methods=["GET"]),
                Route("/api/highlights/bridges", get_bridges, methods=["GET"]),
                Route("/api/highlights/questions", get_questions, methods=["GET"]),
            ]
        )
    routes.extend(_vault_routes(store))

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


def _vault_routes(store: GraphStore | None) -> list[Route]:
    def _attached_global_names() -> set[str]:
        """Return names of WikiVault nodes in the graph with scope=='global'.

        The serve process is the only consumer of the project's graph; we
        treat WikiVault rows whose ``scope`` property is ``"global"`` as the
        set of globals attached to this project. Local WikiVault rows
        always belong to this project so we don't need to track them here.
        """
        if store is None:
            return set()
        out: set[str] = set()
        try:
            for v in store.list_nodes("WikiVault", limit=10_000):
                props = v.get("properties") or {}
                if (props.get("scope") or "global") == "global":
                    nm = props.get("vault") or v.get("name")
                    if nm:
                        out.add(nm)
        except Exception as e:  # noqa: BLE001
            logger.warning("list_nodes(WikiVault) failed: %s", e)
        return out

    def _resolve_scope_for(name: str, scope_q: str | None):
        """Resolve a vault's scope from the optional query param, else by
        local-first lookup. Returns ``(scope, error_response)`` — exactly
        one of the two will be truthy."""
        from opentrace_agent.wiki.paths import (
            InvalidVaultName,
            resolve_vault_scope,
        )

        try:
            if scope_q in ("local", "global"):
                found = resolve_vault_scope(name, prefer=scope_q)
            else:
                found = resolve_vault_scope(name)
        except InvalidVaultName as e:
            return None, _error(400, str(e))
        if found is None:
            return None, _error(404, f"Vault not found: {name}")
        return found[0], None

    async def list_vaults_route(request: Request) -> JSONResponse:
        from opentrace_agent.wiki.paths import list_vaults

        view = request.query_params.get("view") or "project"
        if view not in ("project", "global"):
            return _error(400, f"invalid view: {view!r} (expected 'project' or 'global')")

        attached_globals = _attached_global_names()

        if view == "global":
            entries = [
                {"name": n, "scope": "global", "attached": n in attached_globals} for n in list_vaults(scope="global")
            ]
            return JSONResponse({"vaults": entries})

        # view == "project": local vaults from cwd + globals attached to graph.
        entries = [{"name": n, "scope": "local", "attached": True} for n in list_vaults(scope="local")]
        # Sort attached globals stably for deterministic UI ordering.
        for n in sorted(attached_globals):
            entries.append({"name": n, "scope": "global", "attached": True})
        return JSONResponse({"vaults": entries})

    def _load_vault_meta(name: str, scope):
        """Load a vault's metadata for the given scope."""
        from opentrace_agent.wiki.paths import metadata_path
        from opentrace_agent.wiki.vault import load_metadata

        return load_metadata(metadata_path(name, scope=scope), name=name)

    async def list_pages_route(request: Request) -> JSONResponse:
        name = request.path_params["vault"]
        scope, err = _resolve_scope_for(name, request.query_params.get("scope"))
        if err is not None:
            return err
        meta = _load_vault_meta(name, scope)
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

        from opentrace_agent.wiki.paths import pages_dir

        name = request.path_params["vault"]
        slug = request.path_params["slug"]
        # Slugs are now ``<kind_dir>/<base>``; the single slash is expected.
        # Reject traversal markers, leading dots, and any deeper nesting so
        # a stray "/" can't be used to escape the vault's pages directory.
        if ".." in slug or slug.startswith(".") or slug.startswith("/") or slug.endswith("/") or slug.count("/") > 1:
            return _error(400, f"invalid slug: {slug}")
        scope, err = _resolve_scope_for(name, request.query_params.get("scope"))
        if err is not None:
            return err
        # Migrate a legacy flat-layout vault so the slug → file mapping
        # holds even when no list-pages call ran first to do the fixup.
        _load_vault_meta(name, scope)
        pd = pages_dir(name, scope=scope)
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
        base_url = (form.get("base_url") or "").strip() or None
        scope = (form.get("scope") or "local").strip() or "local"
        if scope not in ("local", "global"):
            return _error(400, f"invalid scope: {scope!r} (expected 'local' or 'global')")
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
            # Compiling a global vault produces a disk-only artifact —
            # users explicitly attach it to this project via the Global
            # tab's "+" button (POST /api/vaults/{name}/attach). Mirroring
            # at compile time would conflate "I made this vault on this
            # machine" with "I want it in this project's graph".
            mirror_target = store if scope == "local" else None
            try:
                for event in run_compile(
                    name,
                    inputs,
                    provider=provider,
                    api_key=api_key,
                    model=model,
                    base_url=base_url,
                    scope=scope,
                    graph_store=mirror_target,
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
        from opentrace_agent.wiki.ingest.graph_writer import delete_vault_from_graph
        from opentrace_agent.wiki.paths import (
            delete_vault as _delete_vault,
        )

        name = request.path_params["vault"]
        scope, err = _resolve_scope_for(name, request.query_params.get("scope"))
        if err is not None:
            return err
        existed = _delete_vault(name, scope=scope)
        if not existed:
            return _error(404, f"Vault not found: {name}")

        # Mirror the disk delete to the graph. Best-effort: if the graph
        # write fails the disk vault is already gone, so we surface the
        # failure but don't reverse the disk delete.
        graph_stats = {"nodes_deleted": 0}
        if store is not None:
            try:
                graph_stats = delete_vault_from_graph(store, name)
            except Exception as e:  # noqa: BLE001
                logger.warning("graph delete failed for vault %s: %s", name, e)
                return JSONResponse(
                    {
                        "deleted": name,
                        "graph_warning": f"{type(e).__name__}: {e}",
                    }
                )

        return JSONResponse({"deleted": name, **graph_stats})

    async def attach_vault_route(request: Request) -> JSONResponse:
        """Mirror a global disk vault into the current project's graph.

        No LLM cost — just reads ``.vault.json`` + page bodies and writes
        WikiVault/WikiPage/Source nodes. Symmetric counterpart of the
        ``vault attach`` CLI command.
        """
        from types import SimpleNamespace

        from opentrace_agent.sources.markdown import copy_corpus_between_scopes
        from opentrace_agent.wiki.ingest.graph_writer import write_vault_to_graph
        from opentrace_agent.wiki.paths import metadata_path, pages_dir
        from opentrace_agent.wiki.vault import load_metadata

        if store is None:
            return _error(503, "no graph store available — serve was started without a graph DB")

        name = request.path_params["vault"]
        # Attach is for globals — locals are auto-mirrored at compile time
        # and don't need a separate attach step.
        scope, err = _resolve_scope_for(name, "global")
        if err is not None:
            return err
        if scope != "global":  # defensive — _resolve_scope_for should already enforce
            return _error(400, "attach is only valid for global vaults")

        meta_path = metadata_path(name, scope="global")
        meta = load_metadata(meta_path, name=name)
        pages_path = pages_dir(name, scope="global")

        page_bodies: dict[str, str] = {}
        for slug in meta.pages.keys():
            body_path = pages_path / f"{slug}.md"
            try:
                page_bodies[slug] = body_path.read_text()
            except OSError:
                page_bodies[slug] = ""

        # Copy the global vault's corpus into this project's corpus dir
        # (sha-keyed, idempotent) so Source.corpus_path resolves locally
        # and source-body retrieval works after attach. project_root is
        # implicit cwd here — the serve process always runs from one.
        try:
            corpus_map = copy_corpus_between_scopes(
                list(meta.sources.keys()),
                from_scope="global",
                to_scope="local",
            )
        except OSError as e:
            logger.warning("corpus copy failed for vault %s: %s", name, e)
            corpus_map = {}
        normalized_stubs = [SimpleNamespace(sha256=sha, corpus_path=path) for sha, path in corpus_map.items()]

        try:
            stats = write_vault_to_graph(
                store,
                meta,
                page_bodies,
                normalized=normalized_stubs,
                scope="global",
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("attach failed for vault %s", name)
            return _error(500, f"{type(e).__name__}: {e}")
        return JSONResponse({"attached": name, **stats})

    async def detach_vault_route(request: Request) -> JSONResponse:
        """Remove a vault's mirror from the graph without touching disk."""
        from opentrace_agent.wiki.ingest.graph_writer import delete_vault_from_graph

        if store is None:
            return _error(503, "no graph store available — serve was started without a graph DB")

        name = request.path_params["vault"]
        try:
            stats = delete_vault_from_graph(store, name)
        except Exception as e:  # noqa: BLE001
            logger.exception("detach failed for vault %s", name)
            return _error(500, f"{type(e).__name__}: {e}")
        return JSONResponse({"detached": name, **stats})

    return [
        Route("/api/vaults", list_vaults_route, methods=["GET"]),
        Route("/api/vaults/{vault}/pages", list_pages_route, methods=["GET"]),
        Route("/api/vaults/{vault}/pages/{slug:path}", get_page_route, methods=["GET"]),
        Route("/api/vaults/{vault}/compile", compile_route, methods=["POST"]),
        Route("/api/vaults/{vault}/attach", attach_vault_route, methods=["POST"]),
        Route("/api/vaults/{vault}/detach", detach_vault_route, methods=["POST"]),
        Route("/api/vaults/{vault}", delete_vault_route, methods=["DELETE"]),
    ]
