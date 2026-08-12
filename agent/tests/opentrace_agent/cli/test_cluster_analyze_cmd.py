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

"""End-to-end smoke for ``opentraceai cluster`` and ``opentraceai analyze``."""

from __future__ import annotations

import json

import pytest

pytest.importorskip("networkx")
pytest.importorskip("real_ladybug")

from opentrace_agent.cli.analyze_cmd import run_analyze_cli  # noqa: E402
from opentrace_agent.cli.cluster_cmd import run_cluster_cli  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402


def _seed(db_path: str) -> None:
    with GraphStore(db_path) as s:
        for i in range(4):
            s.add_node(f"a{i}", "Function", f"a{i}")
            s.add_node(f"b{i}", "Function", f"b{i}")
        rel_id = 0
        for prefix in ("a", "b"):
            for i in range(4):
                for j in range(i + 1, 4):
                    s.add_relationship(f"r{rel_id}", "CALLS", f"{prefix}{i}", f"{prefix}{j}")
                    rel_id += 1
        s.add_relationship("rbridge", "CALLS", "a0", "b0")


class TestClusterCmd:
    def test_text_output(self, tmp_path, capsys):
        db = str(tmp_path / "db")
        _seed(db)
        run_cluster_cli(db, output_json=False)
        out = capsys.readouterr().out
        assert "Clustered 8 nodes" in out
        assert "clusters" in out

    def test_json_output(self, tmp_path, capsys):
        db = str(tmp_path / "db")
        _seed(db)
        run_cluster_cli(db, output_json=True)
        payload = json.loads(capsys.readouterr().out)
        assert payload["nodes"] == 8
        assert payload["clusters"] >= 2

    def test_empty_db_friendly_message(self, tmp_path, capsys):
        db = str(tmp_path / "db")
        with GraphStore(db):
            pass  # creates an empty schema
        run_cluster_cli(db, output_json=False)
        assert "No nodes" in capsys.readouterr().out


class TestAnalyzeCmd:
    def test_reports_gods_and_bridges(self, tmp_path, capsys):
        db = str(tmp_path / "db")
        _seed(db)
        run_cluster_cli(db, output_json=False)
        capsys.readouterr()  # discard cluster output
        run_analyze_cli(db, output_json=False)
        out = capsys.readouterr().out
        assert "God nodes" in out
        assert "Cross-cluster bridges" in out
        assert "Suggested questions" in out

    def test_json_includes_questions(self, tmp_path, capsys):
        db = str(tmp_path / "db")
        _seed(db)
        run_cluster_cli(db, output_json=False)
        capsys.readouterr()
        run_analyze_cli(db, output_json=True)
        payload = json.loads(capsys.readouterr().out)
        assert "gods" in payload
        assert "bridges" in payload
        assert "questions" in payload
        assert isinstance(payload["questions"], list)

    def test_no_clusters_means_no_bridges(self, tmp_path, capsys):
        # Pre-cluster state: god nodes are still reported, bridges are empty.
        db = str(tmp_path / "db")
        _seed(db)
        run_analyze_cli(db, output_json=True)
        payload = json.loads(capsys.readouterr().out)
        assert payload["gods"], "expected at least one god node"
        assert payload["bridges"] == []

    def test_clustering_does_not_alter_god_ranking(self, tmp_path, capsys):
        """Clustering output must not feed back into the god-node ranking.

        Storing the partition as node metadata rather than as Community nodes
        and membership edges is what makes this hold: there is no synthetic
        node to rank and no membership edge to inflate a degree, so no
        consumer has to remember to exclude anything.

        Compared as an id -> degree mapping, not list-wise: the seed graph
        has six nodes tied at the same degree and ``ORDER BY degree`` leaves
        ties in storage order.
        """
        db = str(tmp_path / "db")
        _seed(db)

        run_analyze_cli(db, output_json=True)
        before = json.loads(capsys.readouterr().out)["gods"]

        run_cluster_cli(db, output_json=False)
        capsys.readouterr()  # discard cluster output
        run_analyze_cli(db, output_json=True)
        after = json.loads(capsys.readouterr().out)["gods"]

        assert not any(g["type"] == "Community" for g in after)
        assert {g["id"]: g["degree"] for g in after} == {g["id"]: g["degree"] for g in before}
