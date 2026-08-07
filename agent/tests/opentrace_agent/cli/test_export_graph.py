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

"""Tests for the GraphML exporter."""

from __future__ import annotations

import pytest

pytest.importorskip("networkx")
pytest.importorskip("real_ladybug")

from click.testing import CliRunner  # noqa: E402

from opentrace_agent.cli.export_graph import _build_export_graph, export_graph_app  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402


def _seed(db_path: str) -> None:
    with GraphStore(db_path) as s:
        s.add_node("f1", "Function", "alpha")
        s.add_node("f2", "Function", "beta")
        s.add_relationship("r1", "CALLS", "f1", "f2")
        # Cluster output: a partition stamped onto the members themselves.
        s.assign_communities({"f1": 1, "f2": 1})
        # Metadata that should be excluded.
        s.save_metadata({"repoId": "test", "indexedAt": "2026-05-14"})


class TestBuildExportGraph:
    def test_carries_community_attr_and_excludes_metadata(self, tmp_path):
        db = str(tmp_path / "db")
        _seed(db)
        with GraphStore(db) as store:
            g = _build_export_graph(store)
        assert "f1" in g.nodes
        # IndexMetadata id starts with `_meta:index:`
        assert not any(str(n).startswith("_meta:index:") for n in g.nodes)
        # The partition is an attribute, so Gephi can colour by it without
        # a community node or a membership edge existing to render.
        assert g.nodes["f1"]["community"] == 1
        assert g.nodes["f2"]["community"] == 1
        assert g.number_of_nodes() == 2

    def test_unassigned_node_gets_sentinel_community(self, tmp_path):
        db = str(tmp_path / "db")
        with GraphStore(db) as s:
            s.add_node("lonely", "Function", "lonely")
        with GraphStore(db) as store:
            g = _build_export_graph(store)
        assert g.nodes["lonely"]["community"] == -1

    def test_node_attrs_are_primitive_strings(self, tmp_path):
        db = str(tmp_path / "db")
        _seed(db)
        with GraphStore(db) as store:
            g = _build_export_graph(store)
        for _node_id, attrs in g.nodes(data=True):
            for v in attrs.values():
                # GraphML rejects None — verify we coerced.
                assert v is not None


class TestGraphmlCmd:
    def test_writes_file_with_correct_contents(self, tmp_path):
        db = str(tmp_path / "db")
        _seed(db)
        out = tmp_path / "out.graphml"
        runner = CliRunner()
        result = runner.invoke(
            export_graph_app,
            ["graphml", "--db", db, "--output", str(out)],
        )
        assert result.exit_code == 0, result.output
        assert out.exists()
        text = out.read_text()
        assert text.startswith("<?xml")
        assert "graphml" in text
        # Node IDs should appear in the export.
        assert "f1" in text
        assert "f2" in text
        # The community rides as a node attribute — GraphML declares a key for
        # it — so Gephi can colour by community with no community node present.
        assert 'attr.name="community"' in text

    def test_requires_existing_db(self, tmp_path):
        out = tmp_path / "out.graphml"
        runner = CliRunner()
        result = runner.invoke(
            export_graph_app,
            ["graphml", "--db", str(tmp_path / "missing.db"), "--output", str(out)],
        )
        assert result.exit_code != 0

    def test_creates_parent_directory(self, tmp_path):
        db = str(tmp_path / "db")
        _seed(db)
        out = tmp_path / "subdir" / "out.graphml"
        runner = CliRunner()
        result = runner.invoke(
            export_graph_app,
            ["graphml", "--db", db, "--output", str(out)],
        )
        assert result.exit_code == 0, result.output
        assert out.exists()
