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
import shutil
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any, Optional

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


def create_app(store: GraphStore | None, *, db_path: Optional[str] = None) -> Starlette:
    """Create a Starlette ASGI app exposing *store* as a REST API.

    When *store* is ``None``, the graph routes (``/api/stats``,
    ``/api/graph``, etc.) are omitted; only ``/api/health`` and the vault
    routes are mounted. This is the vault-only mode used when no
    ``.opentrace/index.db`` is available.

    ``db_path`` enables the server-mode indexing endpoint (``POST
    /api/index-url``, Fix #6). When supplied, the agent can clone +
    index a remote repo and atomically swap the result into ``db_path``,
    reopening *store* so subsequent reads see the new data. When
    omitted, the indexing endpoints return 503 — read-only mode.
    """

    # True when this app was created with a graph store at all. Distinguishes
    # the permanent vault-only mode (no DB — graph work is skipped) from a
    # transient None in `store_ref` while the reindex worker swaps stores
    # (graph work returns 503-retry).
    has_graph = store is not None

    # Mutable cell so the indexing worker can swap in a freshly opened
    # store after a successful index swap-in-place. Read handlers
    # snapshot `store_ref["store"]` under the lock and call methods
    # outside the lock to avoid blocking concurrent readers.
    store_ref: dict[str, Optional[GraphStore]] = {"store": store}
    store_lock = threading.Lock()

    # In-memory job state for POST /api/index-url. Keyed by job_id; the
    # UI polls GET /api/index-progress/{job_id} every ~1.5s. Memory is
    # bounded by the lifetime of one `opentraceai serve` process; for
    # a long-running agent we trim oldest jobs after a soft cap.
    _INDEX_JOBS_MAX = 32
    index_jobs: dict[str, dict[str, Any]] = {}
    index_jobs_lock = threading.Lock()

    def _with_store(fn: Callable[[GraphStore], JSONResponse]) -> JSONResponse:
        """Run *fn* against the live store while holding ``store_lock``.

        Holding the lock for the whole operation closes the use-after-close
        race with the reindex worker, which closes the store under the same
        lock: previously a read handler snapshotted the store and called it
        *outside* the lock, so the worker could ``cur.close()`` mid-read and
        crash the LadybugDB C extension. Read handlers issue blocking store
        calls on the event loop (which already serializes them), so holding
        the lock adds only read-vs-swap exclusion, not read-vs-read
        contention. Returns 503 while the store is being swapped
        (``store_ref["store"]`` is None mid-reindex).
        """
        with store_lock:
            cur = store_ref["store"]
            if cur is None:
                return _error(503, "Server is reindexing; retry shortly")
            return fn(cur)

    def _with_writable_store(fn: Callable[[GraphStore], JSONResponse]) -> JSONResponse:
        """Run *fn* against a WRITABLE live store while holding ``store_lock``.

        `serve` opens its store read-only so other readers (MCP, a second
        serve) can coexist on the same DB file. Vault mutations (attach /
        detach / delete-mirror) need writes, so a read-only store is
        reopened writable for the duration of *fn* and restored to
        read-only afterwards. A store that is already writable (tests,
        post-index-url reopen) is used directly.
        """
        with store_lock:
            cur = store_ref["store"]
            if cur is None:
                return _error(503, "Server is reindexing; retry shortly")
            if not getattr(cur, "read_only", False):
                return fn(cur)
            path = cur.db_path
            cur.close()
            store_ref["store"] = None
            try:
                writable = GraphStore(path)
                try:
                    return fn(writable)
                finally:
                    writable.close()
            finally:
                store_ref["store"] = GraphStore(path, read_only=True)

    def _escalate_writable_for_stream() -> tuple[Optional[GraphStore], bool]:
        """Swap the live store for a writable one for a long-running writer.

        Used by the vault compile stream, which mirrors into the graph at
        the end of an LLM-long pipeline — holding ``store_lock`` for that
        long would block every read. Instead the writable store goes into
        ``store_ref`` (reads work fine against it) and the caller passes
        the returned flag to ``_restore_after_stream`` when done.
        """
        with store_lock:
            cur = store_ref["store"]
            if cur is None or not getattr(cur, "read_only", False):
                return cur, False
            path = cur.db_path
            cur.close()
            writable = GraphStore(path)
            store_ref["store"] = writable
            return writable, True

    def _restore_after_stream(swapped: bool) -> None:
        """Downgrade the live store back to read-only after a stream that
        escalated it. No-op when the escalation didn't swap."""
        if not swapped:
            return
        with store_lock:
            cur = store_ref["store"]
            if cur is None or getattr(cur, "read_only", False):
                return
            path = cur.db_path
            cur.close()
            store_ref["store"] = GraphStore(path, read_only=True)

    async def get_stats(request: Request) -> JSONResponse:
        """GET /api/stats"""
        return _with_store(lambda cur: JSONResponse(cur.get_stats()))

    async def fetch_graph(request: Request) -> JSONResponse:
        """GET /api/graph?query=&hops=&limit=&maxNodes=&maxEdges=

        When *query* is empty, returns all nodes and relationships capped at
        *maxNodes*/*maxEdges* (falling back to *limit*, default 10 000) so the
        UI can render the full graph on initial load.

        *maxNodes* and *maxEdges* are visualization caps threaded by the UI's
        ServerGraphStore. They must be positive integers when supplied.
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

        # maxNodes / maxEdges are optional. When provided they take precedence
        # over `limit`. Reject non-integer or non-positive values explicitly so
        # the UI surfaces a useful error instead of silently rendering nothing.
        def _parse_cap(name: str, fallback: int) -> int | JSONResponse:
            raw = request.query_params.get(name)
            if raw is None or raw == "":
                return fallback
            try:
                v = int(raw)
            except ValueError:
                return _error(400, f"Invalid parameter: {name} must be an integer")
            if v <= 0:
                return _error(400, f"Invalid parameter: {name} must be positive")
            return v

        max_nodes = _parse_cap("maxNodes", limit)
        if isinstance(max_nodes, JSONResponse):
            return max_nodes
        max_edges = _parse_cap("maxEdges", limit * 2)
        if isinstance(max_edges, JSONResponse):
            return max_edges

        def _do(cur: GraphStore) -> JSONResponse:
            if not query:
                # Return a stratified sample of nodes (across all types) and the
                # relationships among them. Allocate `max_nodes` across non-empty
                # types by ascending count: small types take their full count and
                # leave room for larger ones, leftover capacity is re-divided
                # among the remaining (bigger) types each iteration. This mirrors
                # the browser store (ui/src/store/ladybugStore.ts) and avoids a
                # biased sample dominated by whichever type the DB surfaces first.
                stats = cur.get_stats()
                type_counts = [
                    (ntype, int(count)) for ntype, count in stats.get("nodes_by_type", {}).items() if int(count) > 0
                ]
                type_counts.sort(key=lambda tc: tc[1])

                all_nodes: list[dict] = []
                remaining = max_nodes
                for i, (ntype, count) in enumerate(type_counts):
                    even_share = remaining // (len(type_counts) - i)
                    take = min(count, even_share)
                    if take <= 0:
                        continue
                    all_nodes.extend(cur.list_nodes(node_type=ntype, limit=take))
                    remaining -= take

                node_ids = {n["id"] for n in all_nodes}
                # list_relationships_for_nodes already caps at max_edges.
                all_rels = cur.list_relationships_for_nodes(node_ids, max_edges)
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

            nodes, relationships = cur.search_graph(query, hops=hops)
            # Search path: apply the same caps after the search returns.
            nodes = nodes[:max_nodes]
            node_ids = {n["id"] for n in nodes}
            capped_rels = [r for r in relationships if r["source_id"] in node_ids and r["target_id"] in node_ids][
                :max_edges
            ]
            links = [
                {
                    "source": r["source_id"],
                    "target": r["target_id"],
                    "type": r["type"],
                    "id": r["id"],
                    "properties": r.get("properties"),
                }
                for r in capped_rels
            ]
            return JSONResponse({"nodes": nodes, "links": links})

        return _with_store(_do)

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
        return _with_store(lambda cur: JSONResponse(cur.search_nodes(query, node_types=node_types, limit=limit)))

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
        return _with_store(lambda cur: JSONResponse(cur.list_nodes(node_type=node_type, filters=filters, limit=limit)))

    async def get_node(request: Request) -> JSONResponse:
        """GET /api/nodes/{node_id}"""
        node_id = request.path_params["node_id"]

        def _do(cur: GraphStore) -> JSONResponse:
            node = cur.get_node(node_id)
            if node is None:
                return _error(404, f"Node not found: {node_id}")
            return JSONResponse(node)

        return _with_store(_do)

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

        def _do(cur: GraphStore) -> JSONResponse:
            try:
                results = cur.traverse(
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

        return _with_store(_do)

    async def get_metadata(request: Request) -> JSONResponse:
        """GET /api/metadata"""
        return _with_store(lambda cur: JSONResponse(cur.get_metadata()))

    async def health(request: Request) -> JSONResponse:
        """GET /api/health"""
        return JSONResponse({"status": "ok"})

    def _get_store() -> Optional[GraphStore]:
        """Snapshot the live store. Vault-route reads use this; they wrap
        every store call in try/except, so the (rare) case of the reindex
        worker closing the snapshot mid-call degrades to a logged warning
        rather than needing the full ``_with_store`` lock."""
        with store_lock:
            return store_ref["store"]

    # --- Knowledge-graph highlights (communities / gods / bridges / questions) ---

    async def get_communities(request: Request) -> JSONResponse:
        """GET /api/communities — list detected communities."""
        return _with_store(lambda cur: JSONResponse(list_communities(cur)))

    async def get_god_nodes(request: Request) -> JSONResponse:
        """GET /api/highlights/gods?limit=N — top-degree non-internal nodes."""
        try:
            limit = int(request.query_params.get("limit", "20"))
        except ValueError:
            return _error(400, "Invalid parameter: limit must be an integer")
        return _with_store(lambda cur: JSONResponse(god_nodes(cur, limit=limit)))

    async def get_bridges(request: Request) -> JSONResponse:
        """GET /api/highlights/bridges?limit=N — cross-community edges."""
        try:
            limit = int(request.query_params.get("limit", "50"))
        except ValueError:
            return _error(400, "Invalid parameter: limit must be an integer")
        return _with_store(lambda cur: JSONResponse(cross_community_bridges(cur, limit=limit)))

    async def get_questions(request: Request) -> JSONResponse:
        """GET /api/highlights/questions — deterministic suggested questions.

        Seeded by the top god nodes + bridges. Replaced by LLM-generated
        questions once the extraction pipeline is wired in.
        """
        from opentrace_agent.cli.analyze_cmd import _suggested_questions

        def _do(cur: GraphStore) -> JSONResponse:
            gods = god_nodes(cur, limit=10)
            bridges = cross_community_bridges(cur, limit=10)
            return JSONResponse(_suggested_questions(gods, bridges))

        return _with_store(_do)

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
        return _with_store(
            lambda cur: JSONResponse(find_path(cur, start_id, end_id, max_hops=max_hops, edge_types=edge_types))
        )

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
        def _do(cur: GraphStore) -> JSONResponse:
            try:
                return JSONResponse(find_orphans(cur, node_type, edge_type, direction=direction, limit=limit))
            except ValueError as e:
                return _error(400, str(e))

        return _with_store(_do)

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
        return _with_store(
            lambda cur: JSONResponse(
                find_via_relationship_to_type(cur, start_type, edge_type, target_type, limit=limit)
            )
        )

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
        return _with_store(
            lambda cur: JSONResponse(
                grep(
                    cur,
                    pattern,
                    scope_id=scope_id,
                    file_filter=file_filter,
                    case_sensitive=case_sensitive,
                    max_results=max_results,
                )
            )
        )

    async def provenance_route(request: Request) -> JSONResponse:
        """POST /api/retrieval/provenance"""
        body = await _read_json(request) or {}
        node_id = body.get("nodeId")
        if not node_id:
            return _error(400, "missing required field: nodeId")
        return _with_store(lambda cur: JSONResponse(provenance(cur, node_id)))

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
        return _with_store(
            lambda cur: JSONResponse(
                search(
                    cur,
                    query,
                    limit=limit,
                    node_types=node_types,
                    vault_scope=vault_scope,
                )
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
        return _with_store(lambda cur: JSONResponse(overview(cur, top_n=top_n, vault_scope=vault_scope)))

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
        return _with_store(
            lambda cur: JSONResponse(
                count_by(
                    cur,
                    node_type,
                    parent_id=parent_id,
                    parent_edge=parent_edge,
                    max_hops=max_hops,
                )
            )
        )

    def _trim_index_jobs() -> None:
        # Soft cap: drop oldest done jobs once we exceed the limit.
        with index_jobs_lock:
            if len(index_jobs) <= _INDEX_JOBS_MAX:
                return
            done = [(jid, st) for jid, st in index_jobs.items() if st.get("done")]
            done.sort(key=lambda kv: kv[1].get("startedAt", 0))
            for jid, _ in done[: len(index_jobs) - _INDEX_JOBS_MAX]:
                index_jobs.pop(jid, None)

    def _run_index_url_job(
        job_id: str,
        body: dict[str, Any],
        target_db: str,
    ) -> None:
        """Background worker. Updates `index_jobs[job_id]` as it runs.

        Lifecycle (under failure, every step still writes a final state):
          1. Resolve repo metadata from `body`.
          2. If `reindex=True`, close the live store, delete the repo's
             rows, reopen.
          3. Clone (or update) the working tree under ~/.opentrace/repos.
          4. Close the live store (releases LadybugDB's file lock).
          5. Run the indexing pipeline — it writes to a staging DB and
             atomically renames over the live DB.
          6. Reopen the live store so subsequent reads see new data.
          7. Mark the job done.
        """

        def _update(**fields: Any) -> None:
            with index_jobs_lock:
                st = index_jobs.get(job_id)
                if st is not None:
                    st.update(fields)

        # Local imports — avoid forcing CLI dependencies on read-only
        # `serve` startups that never call this endpoint.
        from opentrace_agent.cli.main import (
            _do_clone,
            _run_indexing_pipeline,
            _update_existing_clone,
        )

        repo_url = body.get("repoUrl") or ""
        url_parts = repo_url.rstrip("/").split("/")
        inferred_name = url_parts[-1].removesuffix(".git") if url_parts else "repo"
        org = url_parts[-2] if len(url_parts) >= 2 else "unknown"
        repo_id = body.get("repoId") or inferred_name
        token = body.get("token")
        ref = body.get("ref")
        reindex = bool(body.get("reindex"))

        try:
            _update(phase="initializing", message=f"Preparing {repo_id}…")

            # Reindex: drop the existing repo before any clone work. A
            # failed clone afterward leaves the DB without the repo —
            # acceptable; the user can retry. (Mirrors the browser
            # pipeline's "delete after fetch succeeds" pattern in spirit
            # but happens earlier here because we can't easily roll back
            # a partial pipeline run.)
            if reindex:
                _update(phase="deleting", message=f"Removing existing data for {repo_id}…")
                with store_lock:
                    cur = store_ref["store"]
                    if cur is not None:
                        deleted = cur.delete_repo(repo_id)
                        _update(
                            message=(
                                f"Deleted {deleted['nodes_deleted']} nodes and "
                                f"{deleted['relationships_deleted']} relationships"
                            ),
                        )

            # Clone (or update) the working tree.
            _update(phase="fetching", message=f"Cloning {repo_url}…")
            clone_root = Path.home() / ".opentrace" / "repos" / org / inferred_name
            clone_root.parent.mkdir(parents=True, exist_ok=True)
            if clone_root.exists() and (clone_root / ".git").exists():
                _update_existing_clone(clone_root, ref)
                local_path = clone_root
            else:
                if clone_root.exists():
                    shutil.rmtree(clone_root)
                clone_root.mkdir(parents=True, exist_ok=True)
                local_path = _do_clone(repo_url, clone_root, ref, token)

            # Close the live store before the pipeline starts. The
            # pipeline uses a staging DB and atomically renames over
            # the live file at the end; holding the live store open
            # past that point would leave us reading the OLD inode.
            _update(phase="parsing", message="Indexing files (this may take a while)…")
            with store_lock:
                cur = store_ref["store"]
                if cur is not None:
                    cur.close()
                store_ref["store"] = None

            # Translate the pipeline's per-stage phases to the
            # vocabulary the UI knows. The phase strings here MUST
            # stay in sync with `phaseMap` in
            # ui/src/job/browserJobService.ts.
            pipeline_phase_to_ui = {
                "scanning": "fetching",
                "processing": "parsing",
                "resolving": "parsing",
                "submitting": "parsing",
            }
            counts = {"nodes": 0, "edges": 0}
            # Throttle state. The pipeline emits a STAGE_PROGRESS event
            # per file (and sometimes per symbol) — for tempo that's
            # 14k+ events. Routing all of them through `_update()` adds
            # Python overhead + lock churn that demonstrably slows the
            # indexing pipeline by a large factor. STAGE_START/STOP/
            # DONE/ERROR always fire (transitions matter for the UI);
            # STAGE_PROGRESS is throttled to ~5/sec which is plenty
            # for a polling UI that samples every 1.5 s anyway.
            from opentrace_agent.pipeline.types import EventKind

            last_progress_emit = [0.0]
            PROGRESS_MIN_INTERVAL = 0.2  # seconds — ~5 emits/sec

            def on_pipeline_event(event: object) -> None:
                kind = getattr(event, "kind", None)
                is_progress = kind == EventKind.STAGE_PROGRESS
                if is_progress:
                    now = time.monotonic()
                    if now - last_progress_emit[0] < PROGRESS_MIN_INTERVAL:
                        return
                    last_progress_emit[0] = now

                phase_obj = getattr(event, "phase", None)
                phase_str = getattr(phase_obj, "value", phase_obj) if phase_obj else None
                ui_phase = pipeline_phase_to_ui.get(phase_str, "parsing")

                detail = getattr(event, "detail", None)
                current = getattr(detail, "current", 0) if detail else 0
                total = getattr(detail, "total", 0) if detail else 0
                file_name = getattr(detail, "file_name", None) if detail else None

                # Any DONE / STAGE_STOP event with a result snapshots
                # the running cumulative counts.
                result = getattr(event, "result", None)
                if result is not None:
                    counts["nodes"] = getattr(result, "nodes_created", counts["nodes"])
                    counts["edges"] = getattr(result, "relationships_created", counts["edges"])

                fields: dict[str, Any] = {
                    "phase": ui_phase,
                    "phaseRaw": phase_str,
                    "message": getattr(event, "message", "") or "Indexing…",
                    "currentItems": current,
                    "totalItems": total,
                    "currentFile": file_name,
                    "nodesCreated": counts["nodes"],
                    "relationshipsCreated": counts["edges"],
                }
                _update(**fields)

            try:
                elapsed = _run_indexing_pipeline(
                    source_path=local_path,
                    repo_id=repo_id,
                    db_path=target_db,
                    batch_size=200,
                    verbose=False,
                    on_event=on_pipeline_event,
                )
            finally:
                # Always reopen, even on pipeline failure — otherwise
                # the read endpoints would be stuck at 503 forever.
                with store_lock:
                    store_ref["store"] = GraphStore(target_db)

            # Read final stats from the fresh store to send back to the UI.
            with store_lock:
                new_store = store_ref["store"]
                stats = new_store.get_stats() if new_store else {}

            _update(
                phase="done",
                done=True,
                message=f"Indexed in {elapsed:.1f}s",
                result={
                    "elapsedSeconds": elapsed,
                    "repoId": repo_id,
                    "totalNodes": stats.get("total_nodes", 0),
                    "totalEdges": stats.get("total_edges", 0),
                },
            )
        except Exception as exc:
            logger.exception("index-url job %s failed", job_id)
            # Make sure the store is reopened even on early failures
            # (clone errors, delete errors) so reads recover.
            with store_lock:
                if store_ref["store"] is None:
                    try:
                        store_ref["store"] = GraphStore(target_db)
                    except Exception:
                        logger.exception("failed to reopen store after index error")
            _update(
                phase="error",
                done=True,
                error=str(exc),
                message=f"Indexing failed: {exc}",
            )
        finally:
            _trim_index_jobs()

    async def index_url(request: Request) -> JSONResponse:
        """POST /api/index-url

        Body: ``{repoUrl, repoId?, token?, ref?, zipball?, reindex?}``.

        Spawns a background thread that clones the repo, runs the
        indexing pipeline, and reopens the live store after the atomic
        swap. Returns the job id immediately; the UI polls
        ``GET /api/index-progress/{jobId}`` for progress.

        Refuses with 409 Conflict when another index is already
        running — the underlying pipeline holds an exclusive flock on
        the DB, so a concurrent submission would fail anyway, but
        only several stages in. Failing fast at the HTTP boundary
        lets the UI surface a friendly message (Fix #12).
        """
        if db_path is None:
            return _error(503, "Server was started without --db; indexing is unavailable")
        body = await _read_json(request)
        if not body or not body.get("repoUrl"):
            return _error(400, "Missing required field: repoUrl")
        if not isinstance(body.get("repoUrl"), str):
            return _error(400, "Invalid field: repoUrl must be a string")

        # Atomic check-and-insert: hold the lock across both the active-job
        # guard and the new job's insertion. Releasing between the two would
        # let two concurrent requests both observe no active job and each
        # spawn an indexing thread (TOCTOU), wasting clone/parse work.
        job_id = uuid.uuid4().hex
        with index_jobs_lock:
            active = [jid for jid, st in index_jobs.items() if not st.get("done")]
            if active:
                return _error(
                    409,
                    "Another index is already running on this agent. Wait for it to finish before starting a new one.",
                )

            index_jobs[job_id] = {
                "jobId": job_id,
                "phase": "queued",
                "message": "Queued",
                "done": False,
                "error": None,
                "result": None,
                "startedAt": time.time(),
            }

        # daemon=True so the thread doesn't keep the process alive past
        # uvicorn shutdown (matters for cleanup; not for correctness).
        thread = threading.Thread(
            target=_run_index_url_job,
            args=(job_id, body, db_path),
            daemon=True,
            name=f"index-url-{job_id[:8]}",
        )
        thread.start()
        return JSONResponse({"jobId": job_id, "status": "queued"}, status_code=202)

    async def index_progress(request: Request) -> JSONResponse:
        """GET /api/index-progress/{jobId}"""
        job_id = request.path_params["job_id"]
        with index_jobs_lock:
            state = index_jobs.get(job_id)
            if state is None:
                return _error(404, f"Unknown job: {job_id}")
            # Snapshot — return a copy so the caller can't mutate.
            return JSONResponse(dict(state))

    async def index_active(request: Request) -> JSONResponse:
        """GET /api/index-active — return the active index job, or null.

        Used by the SPA on mount to resume polling after a page
        reload (Fix #14). Without this, a long-running server-side
        index becomes invisible to the UI the moment the page is
        refreshed; the user lands on the "Add Repository" screen
        even though work is in flight.

        Returns the newest job whose `done` is False, or `null` when
        nothing is running. We pick the newest by `startedAt` so a
        rare race where two jobs coexist briefly (shouldn't happen
        post-Fix-#12 but defensive) still returns the right one.
        """
        with index_jobs_lock:
            active = [st for st in index_jobs.values() if not st.get("done") and st.get("kind") != "clear"]
            if not active:
                return JSONResponse(None)
            active.sort(key=lambda s: s.get("startedAt", 0), reverse=True)
            return JSONResponse(dict(active[0]))

    async def clear_database(request: Request) -> JSONResponse:
        """POST /api/clear — drop every node and relationship.

        Used by the UI's Settings → "Clear Database" button in server
        mode (Fix #11). Closes the live store, removes the underlying
        LadybugDB files, then opens a fresh empty store and swaps it
        back in. The atomic file-replace is simpler and safer than
        iterating every repo through `delete_repo()` — and matches
        the spirit of what the user clicked ("delete everything").

        Refuses while an `/api/index-url` job is running because that
        worker also writes to the on-disk DB; clearing under its feet
        would corrupt the staging swap.
        """
        if db_path is None:
            return _error(503, "Server was started without --db; clear is unavailable")

        # Atomically reserve exclusivity against index-url: check that no job
        # is active AND register a sentinel under the SAME lock acquisition.
        # Without this, a concurrent index-url could pass its own guard
        # between our check and our unlink, then have its pipeline swap a
        # staging DB over the files we're deleting (clear-vs-index TOCTOU).
        # The index-vs-index hole is already closed by index_url's atomic
        # check-and-insert; this extends the same guard to clear.
        clear_job_id = uuid.uuid4().hex
        with index_jobs_lock:
            active = [jid for jid, st in index_jobs.items() if not st.get("done")]
            if active:
                return _error(
                    409,
                    "An index job is currently running — wait for it to finish before clearing the database.",
                )
            index_jobs[clear_job_id] = {
                "jobId": clear_job_id,
                "kind": "clear",
                "phase": "clearing",
                "message": "Clearing database",
                "done": False,
                "error": None,
                "result": None,
                "startedAt": time.time(),
            }

        from pathlib import Path as _Path

        try:
            with store_lock:
                cur = store_ref["store"]
                if cur is not None:
                    try:
                        cur.close()
                    except Exception:
                        logger.warning("Failed to close store cleanly before clear", exc_info=True)
                store_ref["store"] = None

                # Drop the on-disk artifacts. Mirrors what `opentraceai
                # index` does when it swaps staging into place — same set
                # of files to remove. Cleared in this order so a partial
                # failure doesn't leave a half-removed DB that fails to
                # reopen.
                for suffix in ("", ".wal"):
                    p = _Path(db_path + suffix)
                    if p.exists():
                        try:
                            p.unlink()
                        except OSError as exc:
                            logger.warning("Failed to remove %s: %s", p, exc)

                try:
                    store_ref["store"] = GraphStore(db_path)
                except Exception:
                    logger.exception("Failed to reopen empty store after clear")
                    return _error(500, "Database cleared but could not reopen — restart the agent.")

            return JSONResponse({"status": "ok"})
        finally:
            # Release the exclusivity sentinel so index-url can run again.
            with index_jobs_lock:
                job = index_jobs.get(clear_job_id)
                if job is not None:
                    job["done"] = True

    routes: list[Route] = [Route("/api/health", health, methods=["GET"])]
    if has_graph:
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
                Route("/api/index-url", index_url, methods=["POST"]),
                Route("/api/index-progress/{job_id}", index_progress, methods=["GET"]),
                Route("/api/index-active", index_active, methods=["GET"]),
                Route("/api/clear", clear_database, methods=["POST"]),
            ]
        )
    routes.extend(
        _vault_routes(
            get_store=_get_store,
            has_graph=has_graph,
            with_writable_store=_with_writable_store,
            escalate_writable=_escalate_writable_for_stream,
            restore_writable=_restore_after_stream,
        )
    )

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


def _vault_routes(
    *,
    get_store: "Callable[[], GraphStore | None]",
    has_graph: bool,
    with_writable_store: "Callable[[Callable[[GraphStore], JSONResponse]], JSONResponse]",
    escalate_writable: "Callable[[], tuple[GraphStore | None, bool]]",
    restore_writable: "Callable[[bool], None]",
) -> list[Route]:
    """Vault routes, wired to the live-store helpers from ``create_app``.

    The store can be swapped or closed at any time by the reindex worker,
    and `serve` opens it read-only — so reads snapshot via *get_store* and
    graph mutations go through *with_writable_store* (short ops) or the
    *escalate_writable*/*restore_writable* pair (the LLM-long compile
    stream). *has_graph* is False in vault-only mode (no index DB): graph
    mirroring is skipped entirely rather than 503ing.
    """

    def _attached_global_names() -> set[str]:
        """Return names of WikiVault nodes in the graph with scope=='global'.

        The serve process is the only consumer of the project's graph; we
        treat WikiVault rows whose ``scope`` property is ``"global"`` as the
        set of globals attached to this project. Local WikiVault rows
        always belong to this project so we don't need to track them here.
        """
        store = get_store()
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
            #
            # Local compiles mirror into the graph at the end of the
            # pipeline, which needs a writable store — escalate for the
            # stream's duration (reads keep working against the writable
            # handle) and restore read-only in the finally below.
            mirror_target: GraphStore | None = None
            swapped = False
            if scope == "local":
                mirror_target, swapped = escalate_writable()
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
            finally:
                restore_writable(swapped)

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
        if not has_graph:
            return JSONResponse({"deleted": name, "nodes_deleted": 0})

        def _do(cur: GraphStore) -> JSONResponse:
            try:
                graph_stats = delete_vault_from_graph(cur, name)
            except Exception as e:  # noqa: BLE001
                logger.warning("graph delete failed for vault %s: %s", name, e)
                return JSONResponse(
                    {
                        "deleted": name,
                        "graph_warning": f"{type(e).__name__}: {e}",
                    }
                )
            return JSONResponse({"deleted": name, **graph_stats})

        return with_writable_store(_do)

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

        if not has_graph:
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

        def _do(cur: GraphStore) -> JSONResponse:
            try:
                stats = write_vault_to_graph(
                    cur,
                    meta,
                    page_bodies,
                    normalized=normalized_stubs,
                    scope="global",
                )
            except Exception as e:  # noqa: BLE001
                logger.exception("attach failed for vault %s", name)
                return _error(500, f"{type(e).__name__}: {e}")
            return JSONResponse({"attached": name, **stats})

        return with_writable_store(_do)

    async def detach_vault_route(request: Request) -> JSONResponse:
        """Remove a vault's mirror from the graph without touching disk."""
        from opentrace_agent.wiki.ingest.graph_writer import delete_vault_from_graph

        if not has_graph:
            return _error(503, "no graph store available — serve was started without a graph DB")

        name = request.path_params["vault"]

        def _do(cur: GraphStore) -> JSONResponse:
            try:
                stats = delete_vault_from_graph(cur, name)
            except Exception as e:  # noqa: BLE001
                logger.exception("detach failed for vault %s", name)
                return _error(500, f"{type(e).__name__}: {e}")
            return JSONResponse({"detached": name, **stats})

        return with_writable_store(_do)

    return [
        Route("/api/vaults", list_vaults_route, methods=["GET"]),
        Route("/api/vaults/{vault}/pages", list_pages_route, methods=["GET"]),
        Route("/api/vaults/{vault}/pages/{slug:path}", get_page_route, methods=["GET"]),
        Route("/api/vaults/{vault}/compile", compile_route, methods=["POST"]),
        Route("/api/vaults/{vault}/attach", attach_vault_route, methods=["POST"]),
        Route("/api/vaults/{vault}/detach", detach_vault_route, methods=["POST"]),
        Route("/api/vaults/{vault}", delete_vault_route, methods=["DELETE"]),
    ]
