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


class TestGetSource:
    """GET /api/source/{id} — serves a CorpusDoc's on-disk body so the UI can
    read a source document by selecting its node, like a code file."""

    def _add_corpus_doc(self, store, tmp_path, body="# Title\n\nHello."):
        # corpus_path is relative to the .opentrace dir (the DB's parent).
        (tmp_path / "corpus").mkdir(exist_ok=True)
        (tmp_path / "corpus" / "abc123.md").write_text(body, encoding="utf-8")
        store.add_node(
            "corpus::abc123",
            "KnowledgeDoc",
            "readme.md",
            {"corpus_path": "corpus/abc123.md", "filename": "readme.md", "sha256": "abc123"},
        )

    def test_corpus_doc_body(self, store, tmp_path):
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        self._add_corpus_doc(store, tmp_path)
        client = TestClient(create_app(store))
        resp = client.get("/api/source/corpus::abc123")
        assert resp.status_code == 200
        data = resp.json()
        assert data["content"] == "# Title\n\nHello."
        assert data["path"] == "readme.md"
        assert data["language"] == "markdown"

    def test_node_without_corpus_path_404s(self, client):
        # A Class node has no on-disk body in server mode.
        resp = client.get("/api/source/node-1")
        assert resp.status_code == 404

    def test_missing_node_404s(self, client):
        resp = client.get("/api/source/nonexistent")
        assert resp.status_code == 404

    def test_corpus_path_traversal_rejected(self, store, tmp_path):
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        store.add_node(
            "corpus::evil",
            "KnowledgeDoc",
            "evil",
            {"corpus_path": "../../etc/passwd"},
        )
        client = TestClient(create_app(store))
        resp = client.get("/api/source/corpus::evil")
        assert resp.status_code == 400


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
        # Vault row in the graph has scope="global".
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault(tmp_path, "local-only", "local", project_root=tmp_path)
        self._make_vault(tmp_path, "attached-glob", "global", project_root=tmp_path)
        self._make_vault(tmp_path, "loose-glob", "global", project_root=tmp_path)

        # Mark one global as attached by adding a Vault node with
        # scope=global. Locals are visible from disk so they don't need a
        # graph row to show up in the project view.
        store.add_node(
            "vault::attached-glob",
            "KnowledgeVault",
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

    def test_project_view_resolves_locals_from_db_root_not_cwd(self, tmp_path, monkeypatch):
        """A local vault compiled by ``index --wiki`` lives at
        ``<project>/.opentrace/vaults`` where ``<project>`` holds the index DB.
        `serve` must find it regardless of the process cwd — otherwise a serve
        started from elsewhere (or from ``~``, where the local root collides
        with the global root) surfaces project vaults as globals or hides them.
        """
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app
        from opentrace_agent.store import GraphStore

        # Canonical on-disk layout: <project>/.opentrace/index.db + a local vault.
        project_root = tmp_path / "proj"
        (project_root / ".opentrace").mkdir(parents=True)
        store = GraphStore(str(project_root / ".opentrace" / "index.db"))
        self._make_vault(project_root, "proj-local", "local", project_root=project_root)

        # Point the global root somewhere empty and run serve from an unrelated
        # cwd — the pre-fix code read locals from cwd/.opentrace/vaults.
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        monkeypatch.chdir(elsewhere)

        try:
            client = TestClient(create_app(store))
            data = client.get("/api/vaults?view=project").json()
            names = {(v["name"], v["scope"]) for v in data["vaults"]}
            assert ("proj-local", "local") in names
            # And it must NOT leak into the global view.
            gdata = client.get("/api/vaults?view=global").json()
            assert "proj-local" not in {v["name"] for v in gdata["vaults"]}
        finally:
            store.close()

    def test_global_view_marks_attached(self, store, tmp_path, monkeypatch):
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault(tmp_path, "g1", "global", project_root=tmp_path)
        self._make_vault(tmp_path, "g2", "global", project_root=tmp_path)
        store.add_node(
            "vault::g1",
            "KnowledgeVault",
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

    def test_compile_route_streams_via_sync_generator(self, store, tmp_path, monkeypatch):
        """The compile stream body is a *sync* generator so Starlette runs the
        blocking pipeline in a threadpool (keeping reads responsive). Smoke-test
        that the route still drives run_compile and streams its NDJSON events,
        exercising the _LockedStore wrapper on the mirror target.
        """
        import json

        from starlette.testclient import TestClient

        import opentrace_agent.wiki as wiki_mod
        from opentrace_agent.cli.serve import create_app
        from opentrace_agent.wiki.ingest.types import WikiEventKind, WikiPhase, WikiPipelineEvent

        seen_store = {}

        def fake_run_compile(name, inputs, **kwargs):
            seen_store["graph_store"] = kwargs.get("graph_store")
            seen_store["project_root"] = kwargs.get("project_root")
            yield WikiPipelineEvent(kind=WikiEventKind.STAGE_START, phase=WikiPhase.ACQUIRING, message="go")
            yield WikiPipelineEvent(kind=WikiEventKind.DONE, phase=WikiPhase.PERSISTING, message="done")

        monkeypatch.setattr(wiki_mod, "run_compile", fake_run_compile)

        client = TestClient(create_app(store))
        resp = client.post(
            "/api/vaults/smoke/compile",
            data={"scope": "local", "provider": "anthropic", "api_key": "k"},
            files=[("files", ("a.md", b"# hi", "text/markdown"))],
        )
        assert resp.status_code == 200
        lines = [line for line in resp.text.splitlines() if line.strip()]
        kinds = [json.loads(line)["kind"] for line in lines]
        assert kinds == ["stage_start", "done"]
        # Local compile mirrors into the graph through the lock-guarding proxy.
        assert type(seen_store["graph_store"]).__name__ == "_LockedStore"

    def test_compile_new_suffixes_on_name_collision(self, tmp_path, monkeypatch):
        """on_conflict=suffix renames a new-vault compile (flask → flask-1) when
        the name already exists in either scope; the resolved name is reported."""
        import json

        from starlette.testclient import TestClient

        import opentrace_agent.wiki as wiki_mod
        from opentrace_agent.cli.serve import create_app
        from opentrace_agent.store import GraphStore
        from opentrace_agent.wiki.ingest.types import WikiEventKind, WikiPhase, WikiPipelineEvent

        # Canonical layout so serve's project root resolves; pre-create a local
        # "flask" so a new "flask" must suffix.
        project_root = tmp_path / "proj"
        (project_root / ".opentrace").mkdir(parents=True)
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))
        from opentrace_agent.wiki.paths import ensure_vault_layout, metadata_path

        ensure_vault_layout("flask", scope="local", project_root=project_root)
        metadata_path("flask", scope="local", project_root=project_root).write_text("{}")

        store = GraphStore(str(project_root / ".opentrace" / "index.db"))

        compiled_name = {}

        def fake_run_compile(name, inputs, **kwargs):
            compiled_name["name"] = name
            yield WikiPipelineEvent(kind=WikiEventKind.DONE, phase=WikiPhase.PERSISTING, message="done")

        monkeypatch.setattr(wiki_mod, "run_compile", fake_run_compile)

        try:
            client = TestClient(create_app(store))
            resp = client.post(
                "/api/vaults/flask/compile",
                data={"scope": "local", "provider": "anthropic", "api_key": "k", "on_conflict": "suffix"},
                files=[("files", ("a.md", b"# hi", "text/markdown"))],
            )
            assert resp.status_code == 200
            assert compiled_name["name"] == "flask-1"
            done = json.loads([ln for ln in resp.text.splitlines() if ln.strip()][-1])
            assert done["vault_name"] == "flask-1"
        finally:
            store.close()

    def test_detach_removes_mirror(self, store, tmp_path, monkeypatch):
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault(tmp_path, "g1", "global", project_root=tmp_path)
        store.add_node(
            "vault::g1",
            "KnowledgeVault",
            "g1",
            {"vault": "g1", "scope": "global"},
        )

        client = TestClient(create_app(store))
        resp = client.post("/api/vaults/g1/detach")
        assert resp.status_code == 200
        # Vault row gone; disk vault still present.
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

    def test_promote_moves_local_to_global(self, store, tmp_path, monkeypatch):
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault(tmp_path, "v1", "local", project_root=tmp_path)
        # A local vault carries a scope="local" Vault row in the graph.
        store.add_node("vault::v1", "KnowledgeVault", "v1", {"vault": "v1", "scope": "local"})

        client = TestClient(create_app(store))
        resp = client.post("/api/vaults/v1/promote")
        assert resp.status_code == 200
        body = resp.json()
        assert body["promoted"] == "v1"
        assert body["scope"] == "global"
        # Disk dir moved out of the project into the global root.
        assert not (tmp_path / ".opentrace" / "vaults" / "v1").exists()
        assert (tmp_path / "globals" / "v1" / ".vault.json").exists()
        # Graph row re-stamped global → now shows in the project's Global tab.
        node = store.get_node("vault::v1")
        assert (node.get("properties") or {}).get("scope") == "global"

    def test_promote_rejects_already_global(self, store, tmp_path, monkeypatch):
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault(tmp_path, "g1", "global", project_root=tmp_path)

        client = TestClient(create_app(store))
        resp = client.post("/api/vaults/g1/promote")
        assert resp.status_code == 400

    def test_promote_conflicts_when_global_name_taken(self, store, tmp_path, monkeypatch):
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault(tmp_path, "dup", "local", project_root=tmp_path)
        self._make_vault(tmp_path, "dup", "global", project_root=tmp_path)

        client = TestClient(create_app(store))
        resp = client.post("/api/vaults/dup/promote")
        assert resp.status_code == 409
        # Local dir untouched on conflict.
        assert (tmp_path / ".opentrace" / "vaults" / "dup" / ".vault.json").exists()

    def test_demote_moves_global_to_local(self, store, tmp_path, monkeypatch):
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault(tmp_path, "g1", "global", project_root=tmp_path)
        store.add_node("vault::g1", "KnowledgeVault", "g1", {"vault": "g1", "scope": "global"})

        client = TestClient(create_app(store))
        resp = client.post("/api/vaults/g1/demote")
        assert resp.status_code == 200
        body = resp.json()
        assert body["demoted"] == "g1"
        assert body["scope"] == "local"
        # Disk dir moved into the project's local root.
        assert not (tmp_path / "globals" / "g1").exists()
        assert (tmp_path / ".opentrace" / "vaults" / "g1" / ".vault.json").exists()
        # Graph row re-stamped local.
        node = store.get_node("vault::g1")
        assert (node.get("properties") or {}).get("scope") == "local"

    def test_demote_rejects_already_local(self, store, tmp_path, monkeypatch):
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault(tmp_path, "v1", "local", project_root=tmp_path)

        client = TestClient(create_app(store))
        resp = client.post("/api/vaults/v1/demote")
        assert resp.status_code == 400

    def test_demote_conflicts_when_local_name_taken(self, store, tmp_path, monkeypatch):
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault(tmp_path, "dup", "local", project_root=tmp_path)
        self._make_vault(tmp_path, "dup", "global", project_root=tmp_path)

        client = TestClient(create_app(store))
        # Force the global scope so the resolver targets the global "dup"
        # (local-first resolution would otherwise pick the local one).
        resp = client.post("/api/vaults/dup/demote?scope=global")
        assert resp.status_code == 409
        # Global dir untouched on conflict.
        assert (tmp_path / "globals" / "dup" / ".vault.json").exists()

    def _make_vault_with_content(self, tmp_path, name, scope, *, project_root):
        """A vault with one source + a corpus body, so the graph re-mirror
        actually iterates sources (empty vaults hide writer bugs)."""
        from opentrace_agent.sources.markdown import (
            corpus_dir_for_scope,
            write_corpus_markdown_to,
        )
        from opentrace_agent.wiki.paths import ensure_vault_layout, metadata_path
        from opentrace_agent.wiki.vault import (
            IngestedSource,
            VaultMetadata,
            save_metadata,
        )

        ensure_vault_layout(name, scope=scope, project_root=project_root)
        sha = "a" * 64
        meta = VaultMetadata(name=name)
        meta.sources[sha] = IngestedSource(
            sha256=sha,
            original_name="doc.md",
            ingested_at="2026-01-01T00:00:00Z",
            title="Doc",
            one_line_summary="a doc",
        )
        save_metadata(metadata_path(name, scope=scope, project_root=project_root), meta)
        cdir = corpus_dir_for_scope(scope, project_root=project_root)
        write_corpus_markdown_to(cdir, sha, "# Doc\n\nraw body")

    def test_demote_with_content_mirrors_without_warning(self, store, tmp_path, monkeypatch):
        # Regression: the graph re-mirror on scope-move passed lightweight
        # source stubs (sha256 + corpus_path) to write_vault_to_graph, which
        # read `.title`/`.markdown` directly and crashed on a non-empty vault.
        # Empty-vault tests missed it; demote (real global→local corpus copy)
        # exposed it as a silent graph_warning.
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault_with_content(tmp_path, "gv", "global", project_root=tmp_path)
        store.add_node("vault::gv", "KnowledgeVault", "gv", {"vault": "gv", "scope": "global"})

        client = TestClient(create_app(store))
        resp = client.post("/api/vaults/gv/demote")
        assert resp.status_code == 200
        body = resp.json()
        assert "graph_warning" not in body, body
        assert body["scope"] == "local"
        # CorpusDoc mirrored with the label carried from .vault.json.
        doc = store.get_node("corpus::" + "a" * 64)
        assert doc is not None
        assert (doc.get("properties") or {}).get("title") == "Doc"

    def test_promote_with_content_mirrors_without_warning(self, store, tmp_path, monkeypatch):
        # Same writer fix, exercised through promote (local→global).
        from starlette.testclient import TestClient

        from opentrace_agent.cli.serve import create_app

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))

        self._make_vault_with_content(tmp_path, "lv", "local", project_root=tmp_path)
        store.add_node("vault::lv", "KnowledgeVault", "lv", {"vault": "lv", "scope": "local"})

        client = TestClient(create_app(store))
        resp = client.post("/api/vaults/lv/promote")
        assert resp.status_code == 200
        assert "graph_warning" not in resp.json(), resp.json()
