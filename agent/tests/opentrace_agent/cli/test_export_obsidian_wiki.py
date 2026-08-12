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

"""Tests for the Obsidian + wiki exporters."""

from __future__ import annotations

import pytest

pytest.importorskip("real_ladybug")
pytest.importorskip("networkx")

from click.testing import CliRunner  # noqa: E402

from opentrace_agent.cli.export_graph import _slugify, export_graph_app  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402


def _cluster_names(db_path: str) -> dict[int, str]:
    """Map cluster id → its derived label and exported slug.

    Labels are derived from each cluster's top members rather than stored, so
    the tests resolve them from the store instead of hardcoding a name the
    fixture no longer sets.
    """
    from opentrace_agent.retrieval.clusters import list_clusters

    with GraphStore(db_path) as s:
        return {c["id"]: c["name"] for c in list_clusters(s)}


def _seed(db_path: str) -> None:
    """Two clusters of two nodes each, with a bridge edge."""
    with GraphStore(db_path) as s:
        for i in range(2):
            s.add_node(f"a{i}", "Function", f"alpha-{i}")
            s.add_node(f"b{i}", "Function", f"beta-{i}")
        s.add_relationship("ea", "CALLS", "a0", "a1")
        s.add_relationship("eb", "CALLS", "b0", "b1")
        s.add_relationship("ebridge", "CALLS", "a0", "b0")
        s.assign_clusters({"a0": 1, "a1": 1, "b0": 2, "b1": 2})


class TestSlugify:
    def test_basic(self):
        assert _slugify("Hello World") == "hello-world"

    def test_punctuation_stripped(self):
        assert _slugify("Foo / Bar (v2)") == "foo-bar-v2"

    def test_empty_falls_back(self):
        assert _slugify("") == "node"


class TestObsidianExport:
    def test_creates_one_file_per_node(self, tmp_path):
        db = str(tmp_path / "db")
        _seed(db)
        out = tmp_path / "vault"
        runner = CliRunner()
        result = runner.invoke(export_graph_app, ["obsidian", "--db", db, "--output", str(out)])
        assert result.exit_code == 0, result.output
        md_files = list(out.rglob("*.md"))
        # 4 source nodes → 4 .md files. Clusters live in folder names, not separate files.
        assert len(md_files) == 4

    def test_cluster_folder_structure(self, tmp_path):
        db = str(tmp_path / "db")
        _seed(db)
        out = tmp_path / "vault"
        runner = CliRunner()
        runner.invoke(export_graph_app, ["obsidian", "--db", db, "--output", str(out)])
        # Each cluster's derived label slugifies into a folder.
        names = _cluster_names(db)
        assert (out / _slugify(names[1])).is_dir()
        assert (out / _slugify(names[2])).is_dir()

    def test_wikilinks_in_node_files(self, tmp_path):
        db = str(tmp_path / "db")
        _seed(db)
        out = tmp_path / "vault"
        runner = CliRunner()
        runner.invoke(export_graph_app, ["obsidian", "--db", db, "--output", str(out)])
        a0 = out / _slugify(_cluster_names(db)[1]) / "alpha-0.md"
        text = a0.read_text()
        # a0 has outgoing edges to a1 + bridge to b0 → wikilinks for both.
        assert "[[alpha-1]]" in text
        assert "[[beta-0]]" in text

    def test_yaml_frontmatter_present(self, tmp_path):
        db = str(tmp_path / "db")
        _seed(db)
        out = tmp_path / "vault"
        runner = CliRunner()
        runner.invoke(export_graph_app, ["obsidian", "--db", db, "--output", str(out)])
        a0 = out / _slugify(_cluster_names(db)[1]) / "alpha-0.md"
        text = a0.read_text()
        assert text.startswith("---\n")
        assert 'id: "a0"' in text
        assert "type: Function" in text

    def test_uncategorised_nodes_get_their_own_folder(self, tmp_path):
        """A node without a cluster membership lands in _uncategorised/."""
        db = str(tmp_path / "db")
        with GraphStore(db) as s:
            s.add_node("orphan", "Function", "orphan")
        out = tmp_path / "vault"
        runner = CliRunner()
        result = runner.invoke(export_graph_app, ["obsidian", "--db", db, "--output", str(out)])
        assert result.exit_code == 0
        assert (out / "_uncategorised" / "orphan.md").exists()


class TestWikiExport:
    def test_writes_index_and_cluster_files(self, tmp_path):
        db = str(tmp_path / "db")
        _seed(db)
        out = tmp_path / "wiki"
        runner = CliRunner()
        result = runner.invoke(export_graph_app, ["report", "--db", db, "--output", str(out)])
        assert result.exit_code == 0, result.output
        assert (out / "index.md").exists()
        names = _cluster_names(db)
        assert (out / "clusters" / f"{_slugify(names[1])}.md").exists()
        assert (out / "clusters" / f"{_slugify(names[2])}.md").exists()
        assert (out / "gods").is_dir()

    def test_index_links_to_clusters(self, tmp_path):
        db = str(tmp_path / "db")
        _seed(db)
        out = tmp_path / "wiki"
        runner = CliRunner()
        runner.invoke(export_graph_app, ["report", "--db", db, "--output", str(out)])
        index = (out / "index.md").read_text()
        names = _cluster_names(db)
        assert f"clusters/{_slugify(names[1])}.md" in index
        assert f"clusters/{_slugify(names[2])}.md" in index
        assert "## God Nodes" in index

    def test_cluster_article_lists_members(self, tmp_path):
        db = str(tmp_path / "db")
        _seed(db)
        out = tmp_path / "wiki"
        runner = CliRunner()
        runner.invoke(export_graph_app, ["report", "--db", db, "--output", str(out)])
        alpha = (out / "clusters" / f"{_slugify(_cluster_names(db)[1])}.md").read_text()
        assert "alpha-0" in alpha
        assert "alpha-1" in alpha
        # Cross-cluster connections should surface the bridge edge.
        assert "beta-0" in alpha

    def test_god_article_shows_degree(self, tmp_path):
        db = str(tmp_path / "db")
        _seed(db)
        out = tmp_path / "wiki"
        runner = CliRunner()
        runner.invoke(export_graph_app, ["report", "--db", db, "--output", str(out)])
        gods = list((out / "gods").iterdir())
        assert gods, "expected at least one god article"
        text = gods[0].read_text()
        assert "**Degree**:" in text
        assert "**Type**:" in text

    def test_empty_db_still_emits_index(self, tmp_path):
        db = str(tmp_path / "db")
        with GraphStore(db):
            pass
        out = tmp_path / "wiki"
        runner = CliRunner()
        result = runner.invoke(export_graph_app, ["report", "--db", db, "--output", str(out)])
        assert result.exit_code == 0
        assert (out / "index.md").exists()
        assert (out / "bridges.md").exists()


def _seed_rich(db_path: str) -> None:
    """The base two-cluster seed plus index metadata."""
    _seed(db_path)
    with GraphStore(db_path) as s:
        s.save_metadata(
            {
                "repoId": "demo",
                "commitSha": "abcdef1234567890",
                "branch": "main",
                "indexedAt": "2026-06-10T00:00:00+00:00",
                "opentraceaiVersion": "1.2.3",
            }
        )


class TestReportDashboard:
    def test_index_carries_provenance_header(self, tmp_path):
        db = str(tmp_path / "db")
        _seed_rich(db)
        out = tmp_path / "wiki"
        CliRunner().invoke(export_graph_app, ["report", "--db", db, "--output", str(out)])
        index = (out / "index.md").read_text()
        assert "Indexed from `demo` @ abcdef12 (main)" in index
        assert "opentraceai 1.2.3" in index

    def test_index_renders_mermaid_cluster_map(self, tmp_path):
        db = str(tmp_path / "db")
        _seed_rich(db)
        out = tmp_path / "wiki"
        CliRunner().invoke(export_graph_app, ["report", "--db", db, "--output", str(out)])
        index = (out / "index.md").read_text()
        assert "```mermaid" in index
        assert f'c1["{_cluster_names(db)[1]} (2)"]' in index
        # One bridge edge between the two clusters.
        assert "c1 ---|1| c2" in index

    def test_bridges_page_lists_cross_cluster_edges(self, tmp_path):
        db = str(tmp_path / "db")
        _seed_rich(db)
        out = tmp_path / "wiki"
        CliRunner().invoke(export_graph_app, ["report", "--db", db, "--output", str(out)])
        bridges = (out / "bridges.md").read_text()
        assert "## Cross-cluster" in bridges
        assert "alpha-0" in bridges and "beta-0" in bridges

    def test_cluster_page_groups_connections_by_target(self, tmp_path):
        db = str(tmp_path / "db")
        _seed_rich(db)
        out = tmp_path / "wiki"
        CliRunner().invoke(export_graph_app, ["report", "--db", db, "--output", str(out)])
        names = _cluster_names(db)
        alpha = (out / "clusters" / f"{_slugify(names[1])}.md").read_text()
        assert "## Connections to other clusters" in alpha
        assert f"[{names[2]}]({_slugify(names[2])}.md): 1 edge" in alpha
        assert "alpha-0 → beta-0 (CALLS)" in alpha
