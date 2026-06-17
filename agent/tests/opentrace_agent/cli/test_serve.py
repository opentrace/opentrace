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

"""Tests for the HTTP serve endpoint.

Fixtures (store, client) are provided by conftest.py in this directory.
"""

from __future__ import annotations

import threading
import time

from starlette.testclient import TestClient

from opentrace_agent.cli.serve import create_app


def _wait_for_finish(client: TestClient, job_id: str, timeout: float = 5.0) -> dict:
    """Poll an index job until it leaves the 'running' state."""
    deadline = time.monotonic() + timeout
    data: dict = {}
    while time.monotonic() < deadline:
        data = client.get(f"/api/index/{job_id}").json()
        if data["status"] != "running":
            return data
        time.sleep(0.02)
    raise AssertionError(f"index job did not finish in time: {data}")


class TestHealth:
    def test_health(self, client):
        resp = client.get("/api/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


class TestStats:
    def test_returns_counts(self, client):
        data = client.get("/api/stats").json()
        assert data["total_nodes"] == 3
        assert data["total_edges"] == 2
        assert "Class" in data["nodes_by_type"]
        assert "Function" in data["nodes_by_type"]


class TestFetchGraph:
    def test_empty_query_returns_all(self, client):
        """Empty query returns all nodes and their relationships."""
        data = client.get("/api/graph").json()
        assert len(data["nodes"]) == 3
        assert len(data["links"]) == 2

    def test_search_returns_matches(self, client):
        data = client.get("/api/graph", params={"query": "UserService", "hops": "1"}).json()
        assert len(data["nodes"]) > 0
        names = [n["name"] for n in data["nodes"]]
        assert "UserService" in names


class TestSearchNodes:
    def test_empty_query(self, client):
        assert client.get("/api/nodes/search").json() == []

    def test_finds_by_name(self, client):
        data = client.get("/api/nodes/search", params={"query": "user"}).json()
        assert len(data) > 0
        ids = [n["id"] for n in data]
        assert "node-1" in ids or "node-2" in ids


class TestListNodes:
    def test_missing_type(self, client):
        resp = client.get("/api/nodes/list")
        assert resp.status_code == 400

    def test_list_by_type(self, client):
        data = client.get("/api/nodes/list", params={"type": "Class"}).json()
        assert len(data) == 2
        names = {n["name"] for n in data}
        assert names == {"UserService", "OrderService"}


class TestGetNode:
    def test_existing_node(self, client):
        data = client.get("/api/nodes/node-1").json()
        assert data["id"] == "node-1"
        assert data["name"] == "UserService"

    def test_missing_node(self, client):
        resp = client.get("/api/nodes/nonexistent")
        assert resp.status_code == 404


class TestTraverse:
    def test_outgoing(self, client):
        resp = client.post("/api/traverse", json={"nodeId": "node-1", "direction": "outgoing"})
        data = resp.json()
        assert len(data) > 0
        target_ids = [r["node"]["id"] for r in data]
        assert "node-2" in target_ids

    def test_missing_node(self, client):
        resp = client.post("/api/traverse", json={"nodeId": "nope"})
        assert resp.status_code == 404

    def test_invalid_direction(self, client):
        resp = client.post("/api/traverse", json={"nodeId": "node-1", "direction": "sideways"})
        assert resp.status_code == 400

    def test_missing_body(self, client):
        resp = client.post("/api/traverse")
        assert resp.status_code == 400


class TestIndexEndpoint:
    def _client(self, store, runner):
        app = create_app(store, db_path="/tmp/opentrace-test.db", index_runner=runner)
        return TestClient(app)

    def test_missing_path_or_url(self, client):
        resp = client.post("/api/index", json={})
        assert resp.status_code == 400

    def test_nonexistent_local_path_rejected(self, client):
        # Bad target is rejected synchronously before any subprocess spawns,
        # so the default runner is never invoked.
        resp = client.post("/api/index", json={"pathOrUrl": "/no/such/dir/xyz"})
        assert resp.status_code == 400
        assert "does not exist" in resp.json()["error"]

    def test_start_and_complete(self, store):
        captured: dict = {}

        def runner(job, cmd, token):
            captured["cmd"] = cmd
            captured["token"] = token
            job.add_line("Scanning directory tree")
            job.add_line("Saved 5 nodes, 3 relationships")
            job.finish(0, None)

        client = self._client(store, runner)
        resp = client.post(
            "/api/index",
            json={"pathOrUrl": "https://github.com/owner/repo", "ref": "main"},
        )
        assert resp.status_code == 202
        job_id = resp.json()["jobId"]

        data = _wait_for_finish(client, job_id)
        assert data["status"] == "done"
        assert data["exitCode"] == 0
        assert any("Saved 5 nodes" in line for line in data["lines"])

        # URL routed to fetch-and-index, targeting the server's DB.
        assert captured["cmd"][:2] == ["opentraceai", "fetch-and-index"]
        assert "--ref" in captured["cmd"] and "main" in captured["cmd"]
        assert "--db" in captured["cmd"]

    def test_failure_reports_error(self, store):
        def runner(job, cmd, token):
            job.add_line("boom")
            job.finish(2, "Indexer exited with code 2")

        client = self._client(store, runner)
        job_id = client.post("/api/index", json={"pathOrUrl": "git@github.com:o/r.git"}).json()["jobId"]
        data = _wait_for_finish(client, job_id)
        assert data["status"] == "error"
        assert data["exitCode"] == 2
        assert "code 2" in data["error"]

    def test_concurrent_index_rejected(self, store):
        release = threading.Event()

        def runner(job, cmd, token):
            release.wait(timeout=5.0)
            job.finish(0, None)

        client = self._client(store, runner)
        first = client.post("/api/index", json={"pathOrUrl": "https://github.com/o/r"})
        assert first.status_code == 202

        second = client.post("/api/index", json={"pathOrUrl": "https://github.com/o/r2"})
        assert second.status_code == 409

        release.set()
        _wait_for_finish(client, first.json()["jobId"])

    def test_unknown_job_404(self, client):
        resp = client.get("/api/index/deadbeef")
        assert resp.status_code == 404
