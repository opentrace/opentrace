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

"""API contract tests — response shapes, CORS headers, and error contracts.

Fixtures (store, client) are provided by conftest.py in this directory.
"""

from __future__ import annotations


class TestCORSHeaders:
    """Verify CORS middleware is configured correctly."""

    def test_cors_on_get(self, client):
        resp = client.get("/api/health", headers={"Origin": "http://localhost:5173"})
        assert resp.headers.get("access-control-allow-origin") == "*"

    def test_cors_preflight(self, client):
        resp = client.options(
            "/api/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert resp.status_code == 200
        assert "access-control-allow-origin" in resp.headers


class TestErrorContract:
    """All error responses follow {"error": "..."} shape."""

    def test_list_nodes_missing_type(self, client):
        resp = client.get("/api/nodes/list")
        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body
        assert isinstance(body["error"], str)

    def test_traverse_empty_json(self, client):
        resp = client.post("/api/traverse", json={})
        assert resp.status_code == 400
        assert "error" in resp.json()

    def test_traverse_missing_body(self, client):
        resp = client.post("/api/traverse")
        assert resp.status_code == 400
        assert "error" in resp.json()

    def test_traverse_invalid_direction(self, client):
        resp = client.post("/api/traverse", json={"nodeId": "node-1", "direction": "sideways"})
        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body
        assert isinstance(body["error"], str)

    def test_get_missing_node(self, client):
        resp = client.get("/api/nodes/nonexistent")
        assert resp.status_code == 404
        body = resp.json()
        assert "error" in body
        assert isinstance(body["error"], str)

    def test_graph_invalid_hops(self, client):
        resp = client.get("/api/graph", params={"hops": "abc"})
        assert resp.status_code == 400
        assert "error" in resp.json()


class TestResponseShape:
    """Verify response JSON structure matches the API contract."""

    def test_health_shape(self, client):
        data = client.get("/api/health").json()
        assert data == {"status": "ok"}

    def test_stats_shape(self, client):
        data = client.get("/api/stats").json()
        assert "total_nodes" in data
        assert "total_edges" in data
        assert "nodes_by_type" in data
        assert isinstance(data["nodes_by_type"], dict)

    def test_graph_shape(self, client):
        data = client.get("/api/graph").json()
        assert isinstance(data["nodes"], list)
        assert isinstance(data["links"], list)
        # Verify link shape
        for link in data["links"]:
            assert "source" in link
            assert "target" in link
            assert "type" in link
            assert "id" in link

    def test_graph_node_shape(self, client):
        data = client.get("/api/graph").json()
        for node in data["nodes"]:
            assert "id" in node
            assert "name" in node
            assert "type" in node

    def test_search_returns_list(self, client):
        data = client.get("/api/nodes/search", params={"query": "user"}).json()
        assert isinstance(data, list)
        for node in data:
            assert "id" in node
            assert "name" in node

    def test_list_returns_list(self, client):
        data = client.get("/api/nodes/list", params={"type": "Class"}).json()
        assert isinstance(data, list)
        for node in data:
            assert "id" in node
            assert "name" in node
            assert "type" in node

    def test_get_node_shape(self, client):
        data = client.get("/api/nodes/node-1").json()
        assert "id" in data
        assert "name" in data
        assert "type" in data

    def test_traverse_shape(self, client):
        data = client.post("/api/traverse", json={"nodeId": "node-1"}).json()
        assert isinstance(data, list)
        for entry in data:
            assert "node" in entry
            assert "id" in entry["node"]
