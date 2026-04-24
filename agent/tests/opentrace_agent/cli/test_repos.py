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

"""Tests for ``opentrace repos`` subcommand.

The command emits one JSON object per Repository node in the graph,
merging the full per-repo metadata shape from ``store.get_metadata()``.
These tests exercise the merge rules, match-by-id behavior, and
graceful degradation when metadata is missing — all via a mocked
GraphStore so no real DB is needed.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from opentrace_agent.cli.main import _REPOS_METADATA_FIELDS, app


def _mock_conn_result(rows: list[tuple[str, str, str]]) -> MagicMock:
    """Return a MagicMock shaped like store._conn.execute(...)'s result."""
    idx = [0]
    m = MagicMock()
    m.has_next.side_effect = lambda: idx[0] < len(rows)

    def _next():
        row = rows[idx[0]]
        idx[0] += 1
        return row

    m.get_next.side_effect = _next
    return m


def _run_repos(store: MagicMock, tmp_path) -> dict:
    """Invoke the `repos` command with a patched GraphStore and parse output."""
    with patch("opentrace_agent.store.GraphStore", return_value=store), patch(
        "opentrace_agent.cli.main._resolve_db",
        return_value=str(tmp_path / "fake.db"),
    ):
        result = CliRunner().invoke(app, ["repos"])
    assert result.exit_code == 0, result.output
    return json.loads(result.output)


class TestReposFullMerge:
    def test_metadata_populates_all_fields(self, tmp_path) -> None:
        """A node with a matching metadata entry surfaces every metadata field."""
        store = MagicMock()
        store._conn.execute.return_value = _mock_conn_result([
            ("click", "click", "{}"),
        ])
        store.get_metadata.return_value = [
            {
                "repoId": "click",
                "sourceUri": "https://github.com/pallets/click",
                "branch": "main",
                "commitSha": "04ef3a6f",
                "commitMessage": "update dev deps",
                "repoPath": "/home/user/.opentrace/repos/pallets/click",
                "indexedAt": "2026-04-14T17:17:39Z",
                "durationSeconds": 13.16,
                "nodesCreated": 4301,
                "relationshipsCreated": 8451,
                "filesProcessed": 96,
                "classesExtracted": 129,
                "functionsExtracted": 947,
                "opentraceaiVersion": "0.4.0",
            }
        ]

        output = _run_repos(store, tmp_path)

        assert len(output) == 1
        entry = output[0]
        assert entry["id"] == "click"
        assert entry["name"] == "click"
        assert entry["sourceUri"] == "https://github.com/pallets/click"
        assert entry["branch"] == "main"
        assert entry["commitSha"] == "04ef3a6f"
        assert entry["commitMessage"] == "update dev deps"
        assert entry["repoPath"] == "/home/user/.opentrace/repos/pallets/click"
        assert entry["indexedAt"] == "2026-04-14T17:17:39Z"
        assert entry["durationSeconds"] == 13.16
        assert entry["nodesCreated"] == 4301
        assert entry["relationshipsCreated"] == 8451
        assert entry["filesProcessed"] == 96
        assert entry["classesExtracted"] == 129
        assert entry["functionsExtracted"] == 947
        assert entry["opentraceaiVersion"] == "0.4.0"

    def test_all_metadata_fields_keyed_even_when_missing(self, tmp_path) -> None:
        """Shape must be stable: every metadata field key present, nullable."""
        store = MagicMock()
        store._conn.execute.return_value = _mock_conn_result([
            ("solo", "solo", "{}"),
        ])
        store.get_metadata.return_value = []  # no metadata at all

        output = _run_repos(store, tmp_path)

        assert len(output) == 1
        entry = output[0]
        assert entry["id"] == "solo"
        assert entry["name"] == "solo"
        for field in _REPOS_METADATA_FIELDS:
            assert field in entry, f"{field} missing from output shape"
            assert entry[field] is None, f"{field} should be null when metadata absent"


class TestReposMatchByIdNotName:
    def test_metadata_matched_by_id(self, tmp_path) -> None:
        """Match uses the node id, not the name — previously fragile on divergence."""
        store = MagicMock()
        # Node id is 'opentrace-agent', but name is 'agent' (sub-path index).
        store._conn.execute.return_value = _mock_conn_result([
            ("opentrace-agent", "agent", "{}"),
        ])
        store.get_metadata.return_value = [
            {
                "repoId": "opentrace-agent",
                "sourceUri": "https://github.com/opentrace/opentrace",
                "branch": "main",
            }
        ]

        output = _run_repos(store, tmp_path)

        assert output[0]["sourceUri"] == "https://github.com/opentrace/opentrace"
        assert output[0]["branch"] == "main"

    def test_metadata_with_mismatched_id_is_orphan(self, tmp_path) -> None:
        """Metadata whose repoId doesn't match any node is excluded entirely."""
        store = MagicMock()
        store._conn.execute.return_value = _mock_conn_result([
            ("existing", "existing", "{}"),
        ])
        store.get_metadata.return_value = [
            {"repoId": "never-indexed-here", "sourceUri": "https://x"},
        ]

        output = _run_repos(store, tmp_path)

        # Only the graph-node repo appears; orphan metadata is not surfaced
        # (repos reports what's in the graph, not index history).
        assert len(output) == 1
        assert output[0]["id"] == "existing"
        assert output[0]["sourceUri"] is None


class TestReposGraphPropsFallback:
    def test_graph_properties_used_when_metadata_absent(self, tmp_path) -> None:
        """If a future indexer writes sourceUri/etc. to the node instead of
        metadata, those values must still reach the output."""
        store = MagicMock()
        store._conn.execute.return_value = _mock_conn_result([
            (
                "legacy-repo",
                "legacy-repo",
                json.dumps({
                    "sourceUri": "https://legacy.git/repo",
                    "branch": "trunk",
                    "commitSha": "abcdef01",
                    "repoPath": "/var/src/legacy-repo",
                }),
            ),
        ])
        store.get_metadata.return_value = []

        output = _run_repos(store, tmp_path)

        entry = output[0]
        assert entry["sourceUri"] == "https://legacy.git/repo"
        assert entry["branch"] == "trunk"
        assert entry["commitSha"] == "abcdef01"
        assert entry["repoPath"] == "/var/src/legacy-repo"

    def test_metadata_wins_over_graph_properties(self, tmp_path) -> None:
        """When both sources carry a value, metadata takes precedence."""
        store = MagicMock()
        store._conn.execute.return_value = _mock_conn_result([
            (
                "dual-source",
                "dual-source",
                json.dumps({"branch": "stale-from-graph"}),
            ),
        ])
        store.get_metadata.return_value = [
            {"repoId": "dual-source", "branch": "fresh-from-metadata"}
        ]

        output = _run_repos(store, tmp_path)

        assert output[0]["branch"] == "fresh-from-metadata"


class TestReposEmpty:
    def test_no_repositories_in_graph(self, tmp_path) -> None:
        """Empty graph → empty JSON array, exit 0."""
        store = MagicMock()
        store._conn.execute.return_value = _mock_conn_result([])
        store.get_metadata.return_value = []

        output = _run_repos(store, tmp_path)

        assert output == []

    def test_malformed_properties_json_does_not_crash(self, tmp_path) -> None:
        """A node with un-parseable properties should be surfaced without its
        graph-props fallbacks — not raise."""
        store = MagicMock()
        store._conn.execute.return_value = _mock_conn_result([
            ("broken", "broken", "{not valid json"),
        ])
        store.get_metadata.return_value = []

        output = _run_repos(store, tmp_path)

        assert output[0]["id"] == "broken"
        # All metadata fields null because properties unparseable + no metadata.
        for field in _REPOS_METADATA_FIELDS:
            assert output[0][field] is None
