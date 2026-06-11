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


class TestHighlights:
    """REST endpoints backing the UI's KnowledgeHighlightsPanel."""

    def test_communities_empty_by_default(self, client):
        # Fixture store has no Community nodes — endpoint should return [].
        resp = client.get("/api/communities")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_communities_after_save(self, store, client):
        store.save_community("c1", "Auth", 1, 0.7, 5, is_god=True)
        resp = client.get("/api/communities")
        assert resp.status_code == 200
        rows = resp.json()
        assert len(rows) == 1
        assert rows[0]["name"] == "Auth"
        assert rows[0]["is_god"] is True

    def test_gods_returns_top_degree(self, client):
        # Fixture has 3 nodes with 2 edges; node-2 has degree 2.
        resp = client.get("/api/highlights/gods")
        assert resp.status_code == 200
        rows = resp.json()
        assert rows[0]["id"] == "node-2"
        assert rows[0]["degree"] == 2

    def test_gods_respects_limit(self, client):
        resp = client.get("/api/highlights/gods?limit=1")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    def test_gods_rejects_non_int_limit(self, client):
        resp = client.get("/api/highlights/gods?limit=abc")
        assert resp.status_code == 400

    def test_bridges_empty_without_communities(self, client):
        resp = client.get("/api/highlights/bridges")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_bridges_after_clustering(self, store, client):
        store.save_community("ca", "A", 1, 0.7, 1)
        store.save_community("cb", "B", 2, 0.7, 1)
        store.save_membership("m1", "node-1", "ca")
        store.save_membership("m2", "node-2", "cb")
        resp = client.get("/api/highlights/bridges")
        assert resp.status_code == 200
        rows = resp.json()
        assert any(r["source_id"] in ("node-1", "node-2") and r["target_id"] in ("node-1", "node-2") for r in rows)

    def test_questions_returns_strings(self, client):
        resp = client.get("/api/highlights/questions")
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list)
        # All entries are strings, even with no communities yet.
        assert all(isinstance(q, str) for q in body)


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


class TestVaultRoutes:
    """Project/Global views, attach/detach, and scope-aware delete."""

    def _make_vault(self, tmp_path, name, scope, *, project_root):
        from opentrace_agent.wiki.paths import ensure_vault_layout, metadata_path
        from opentrace_agent.wiki.vault import VaultMetadata, save_metadata

        ensure_vault_layout(name, scope=scope, project_root=project_root)
        mp = metadata_path(name, scope=scope, project_root=project_root)
        save_metadata(mp, VaultMetadata(name=name))

    def test_project_view_lists_locals_and_attached_globals(self, store, tmp_path, monkeypatch):
        # Project view = local vaults from cwd + global vaults whose
        # WikiVault row in the graph has scope="global".
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault(tmp_path, "local-only", "local", project_root=tmp_path)
        self._make_vault(tmp_path, "attached-glob", "global", project_root=tmp_path)
        self._make_vault(tmp_path, "loose-glob", "global", project_root=tmp_path)

        # Mark one global as attached by adding a WikiVault node with
        # scope=global. Locals are visible from disk so they don't need a
        # graph row to show up in the project view.
        store.add_node(
            "vault::attached-glob",
            "WikiVault",
            "attached-glob",
            {"vault": "attached-glob", "scope": "global"},
        )

        client = TestClient(create_app(store))
        data = client.get("/api/vaults?view=project").json()
        names = {(v["name"], v["scope"]) for v in data["vaults"]}
        assert ("local-only", "local") in names
        assert ("attached-glob", "global") in names
        assert ("loose-glob", "global") not in names
        # Project view: every entry is "attached" by definition.
        assert all(v["attached"] for v in data["vaults"])

    def test_global_view_marks_attached(self, store, tmp_path, monkeypatch):
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault(tmp_path, "g1", "global", project_root=tmp_path)
        self._make_vault(tmp_path, "g2", "global", project_root=tmp_path)
        store.add_node(
            "vault::g1",
            "WikiVault",
            "g1",
            {"vault": "g1", "scope": "global"},
        )

        client = TestClient(create_app(store))
        data = client.get("/api/vaults?view=global").json()
        rows = {v["name"]: v for v in data["vaults"]}
        assert rows["g1"]["attached"] is True
        assert rows["g2"]["attached"] is False
        assert all(v["scope"] == "global" for v in data["vaults"])

    def test_invalid_view(self, client):
        resp = client.get("/api/vaults?view=nonsense")
        assert resp.status_code == 400

    def test_detach_removes_mirror(self, store, tmp_path, monkeypatch):
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault(tmp_path, "g1", "global", project_root=tmp_path)
        store.add_node(
            "vault::g1",
            "WikiVault",
            "g1",
            {"vault": "g1", "scope": "global"},
        )

        client = TestClient(create_app(store))
        resp = client.post("/api/vaults/g1/detach")
        assert resp.status_code == 200
        # WikiVault row gone; disk vault still present.
        assert store.get_node("vault::g1") is None
        assert (tmp_path / "globals" / "g1" / ".vault.json").exists()

    def test_attach_mirrors_global_into_graph(self, store, tmp_path, monkeypatch):
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault(tmp_path, "g1", "global", project_root=tmp_path)

        client = TestClient(create_app(store))
        resp = client.post("/api/vaults/g1/attach")
        assert resp.status_code == 200
        node = store.get_node("vault::g1")
        assert node is not None
        assert (node.get("properties") or {}).get("scope") == "global"
