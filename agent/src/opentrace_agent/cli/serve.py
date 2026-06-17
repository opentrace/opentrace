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
import os
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any, Callable

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from opentrace_agent.store import GraphStore

logger = logging.getLogger(__name__)

# Keep at most this many stdout lines per job so a long index can't grow
# the in-memory buffer without bound.
_MAX_JOB_LINES = 2000


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


async def _read_json(request: Request) -> Any:
    try:
        return await request.json()
    except Exception:
        return None


class _IndexJob:
    """In-memory record of a single background index run."""

    def __init__(self, job_id: str, target: str) -> None:
        self.id = job_id
        self.target = target
        self.status = "running"  # running | done | error
        self.lines: list[str] = []
        self.exit_code: int | None = None
        self.error: str | None = None
        self._lock = threading.Lock()

    def add_line(self, line: str) -> None:
        with self._lock:
            self.lines.append(line)
            if len(self.lines) > _MAX_JOB_LINES:
                del self.lines[: len(self.lines) - _MAX_JOB_LINES]

    def finish(self, exit_code: int | None, error: str | None) -> None:
        with self._lock:
            self.exit_code = exit_code
            self.error = error
            self.status = "done" if (exit_code == 0 and error is None) else "error"

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "jobId": self.id,
                "status": self.status,
                "lines": list(self.lines),
                "exitCode": self.exit_code,
                "error": self.error,
            }


# A runner takes (job, cmd, token) and drives the subprocess to completion.
IndexRunner = Callable[["_IndexJob", list[str], str], None]


class _IndexJobManager:
    """Runs `opentraceai index` / `fetch-and-index` subprocesses out-of-band.

    The REST server holds a read-only handle on the live DB. Writes must not
    go through that handle — instead they are delegated to a short-lived
    subprocess that writes a staging file and atomically renames it over the
    live DB (the same pattern the MCP `repo_index` tool uses). The server's
    `_ReloadableStore` wrapper then reopens the new file on the next query.

    Only one index runs at a time; a concurrent request gets a 409. Each run
    streams its stdout into the job's ``lines`` so the UI can show progress.
    """

    def __init__(self, db_path: str | None, runner: IndexRunner | None = None) -> None:
        self._db_path = db_path
        self._jobs: dict[str, _IndexJob] = {}
        self._active: str | None = None
        self._lock = threading.Lock()
        self._runner = runner or self._default_runner

    def get(self, job_id: str) -> _IndexJob | None:
        return self._jobs.get(job_id)

    def start(self, path_or_url: str, repo_id: str = "", ref: str = "", token: str = "") -> _IndexJob:
        """Validate, register, and launch an index job. Returns the job.

        Raises ``ValueError`` for a bad target and ``RuntimeError`` if an
        index is already running.
        """
        with self._lock:
            active = self._jobs.get(self._active) if self._active else None
            if active is not None and active.status == "running":
                raise RuntimeError("An index job is already running")
            cmd = self._build_cmd(path_or_url, repo_id, ref)  # may raise ValueError
            job_id = uuid.uuid4().hex
            job = _IndexJob(job_id, path_or_url)
            self._jobs[job_id] = job
            self._active = job_id

        thread = threading.Thread(target=self._runner, args=(job, cmd, token), daemon=True)
        thread.start()
        return job

    def _build_cmd(self, path_or_url: str, repo_id: str, ref: str) -> list[str]:
        is_url = path_or_url.startswith(("https://", "http://", "git@"))
        if is_url:
            cmd = ["opentraceai", "fetch-and-index", path_or_url]
            if repo_id:
                cmd += ["--repo-id", repo_id]
            if ref:
                cmd += ["--ref", ref]
            if self._db_path:
                cmd += ["--db", self._db_path]
            return cmd

        try:
            target = Path(path_or_url).expanduser().resolve()
        except Exception as e:
            raise ValueError(f"Invalid path: {e}")
        if not target.exists():
            raise ValueError(f"Path does not exist: {target}")
        if not target.is_dir():
            raise ValueError(f"Path is not a directory: {target}")
        cmd = ["opentraceai", "index", str(target)]
        if self._db_path:
            cmd += ["--db", self._db_path]
        if repo_id:
            cmd += ["--repo-id", repo_id]
        return cmd

    def _default_runner(self, job: _IndexJob, cmd: list[str], token: str) -> None:
        env = os.environ.copy()
        if token:
            # fetch-and-index resolves a clone token from these env vars when
            # one isn't already configured server-side.
            env.setdefault("OPENTRACE_GIT_TOKEN", token)
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env=env,
            )
        except FileNotFoundError:
            job.finish(None, "opentraceai not found on PATH — install with `pip install opentraceai`")
            return
        except Exception as e:  # pragma: no cover - defensive
            job.finish(None, str(e))
            return

        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            if line:
                job.add_line(line)
        proc.wait()
        if proc.returncode == 0:
            job.finish(0, None)
        else:
            job.finish(proc.returncode, f"Indexer exited with code {proc.returncode}")


def create_app(
    store: GraphStore,
    db_path: str | None = None,
    index_runner: IndexRunner | None = None,
) -> Starlette:
    """Create a Starlette ASGI app exposing *store* as a REST API.

    *db_path* is the live database path; it is passed to indexer subprocesses
    so they write to the same DB the server reads. *index_runner* overrides the
    subprocess runner (used in tests). When *db_path* is ``None`` the indexer
    falls back to its own DB discovery.
    """
    jobs = _IndexJobManager(db_path, runner=index_runner)

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

    async def start_index(request: Request) -> JSONResponse:
        """POST /api/index — index a local path or remote git URL.

        Body: ``{"pathOrUrl": str, "repoId"?: str, "ref"?: str, "token"?: str}``.
        Runs the indexer in a background subprocess (staging file + atomic
        rename) and returns a job id immediately; poll ``GET /api/index/{id}``
        for progress. Indexing happens out-of-band so it never contends with
        the server's read-only DB handle.

        Security: this clones/indexes arbitrary URLs and local paths. The
        server has no auth and should stay bound to loopback.
        """
        body = await _read_json(request)
        if not body or not body.get("pathOrUrl"):
            return _error(400, "Missing required field: pathOrUrl")
        try:
            job = jobs.start(
                str(body["pathOrUrl"]),
                repo_id=str(body.get("repoId") or ""),
                ref=str(body.get("ref") or ""),
                token=str(body.get("token") or ""),
            )
        except ValueError as e:
            return _error(400, str(e))
        except RuntimeError as e:
            return _error(409, str(e))
        return JSONResponse({"jobId": job.id, "status": job.status}, status_code=202)

    async def index_status(request: Request) -> JSONResponse:
        """GET /api/index/{job_id} — poll a running or finished index job."""
        job = jobs.get(request.path_params["job_id"])
        if job is None:
            return _error(404, "Unknown index job")
        return JSONResponse(job.snapshot())

    routes = [
        Route("/api/health", health, methods=["GET"]),
        Route("/api/stats", get_stats, methods=["GET"]),
        Route("/api/metadata", get_metadata, methods=["GET"]),
        Route("/api/graph", fetch_graph, methods=["GET"]),
        Route("/api/nodes/search", search_nodes, methods=["GET"]),
        Route("/api/nodes/list", list_nodes, methods=["GET"]),
        Route("/api/nodes/{node_id:path}", get_node, methods=["GET"]),
        Route("/api/traverse", traverse, methods=["POST"]),
        Route("/api/index", start_index, methods=["POST"]),
        Route("/api/index/{job_id}", index_status, methods=["GET"]),
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
