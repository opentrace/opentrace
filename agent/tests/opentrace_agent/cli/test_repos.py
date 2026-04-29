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

from click.testing import CliRunner

from opentrace_agent.cli.main import _REPOS_METADATA_FIELDS, app


def _repo(id_: str, name: str | None = None, **properties) -> dict:
    """Build a fake ``store.list_repositories()`` row.

    Mirrors the GraphStore helper's contract: ``properties`` is always
    a dict (never ``None`` or a raw JSON string), so the command never
    has to think about parsing.
    """
    return {"id": id_, "name": name or id_, "properties": dict(properties)}


def _run_repos(store: MagicMock, tmp_path) -> list:
    """Invoke the `repos` command with a patched GraphStore and parse output."""
    with (
        patch("opentrace_agent.store.GraphStore", return_value=store),
        patch(
            "opentrace_agent.cli.main._resolve_db",
            return_value=str(tmp_path / "fake.db"),
        ),
    ):
        result = CliRunner().invoke(app, ["repos"])
    assert result.exit_code == 0, result.output
    return json.loads(result.output)


class TestReposFullMerge:
    def test_metadata_populates_all_fields(self, tmp_path) -> None:
        """A node with a matching metadata entry surfaces every metadata field."""
        store = MagicMock()
        store.list_repositories.return_value = [_repo("click")]
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
        store.list_repositories.return_value = [_repo("solo")]
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
        store.list_repositories.return_value = [_repo("opentrace-agent", name="agent")]
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
        store.list_repositories.return_value = [_repo("existing")]
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
        store.list_repositories.return_value = [
            _repo(
                "legacy-repo",
                sourceUri="https://legacy.git/repo",
                branch="trunk",
                commitSha="abcdef01",
                repoPath="/var/src/legacy-repo",
            ),
        ]
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
        store.list_repositories.return_value = [_repo("dual-source", branch="stale-from-graph")]
        store.get_metadata.return_value = [{"repoId": "dual-source", "branch": "fresh-from-metadata"}]

        output = _run_repos(store, tmp_path)

        assert output[0]["branch"] == "fresh-from-metadata"


class TestReposEmpty:
    def test_no_repositories_in_graph(self, tmp_path) -> None:
        """Empty graph → empty JSON array, exit 0."""
        store = MagicMock()
        store.list_repositories.return_value = []
        store.get_metadata.return_value = []

        output = _run_repos(store, tmp_path)

        assert output == []

    def test_malformed_properties_default_to_empty_dict(self, tmp_path) -> None:
        """``store.list_repositories`` is contractually responsible for
        coercing un-parseable properties into ``{}`` (see
        graph_store.list_repositories docstring), so the command sees a
        clean dict and surfaces the row without its graph-props
        fallbacks."""
        store = MagicMock()
        store.list_repositories.return_value = [_repo("broken")]  # properties={}
        store.get_metadata.return_value = []

        output = _run_repos(store, tmp_path)

        assert output[0]["id"] == "broken"
        # All metadata fields null because properties empty + no metadata.
        for field in _REPOS_METADATA_FIELDS:
            assert output[0][field] is None


class TestReposDbResolution:
    def test_missing_db_path_exits_nonzero_with_message(self, tmp_path) -> None:
        """An explicit ``--db`` pointing at a non-existent file must
        surface ``_resolve_db``'s usage error rather than crashing
        deeper inside the store layer."""
        bogus_db = tmp_path / "does-not-exist" / "index.db"

        result = CliRunner().invoke(app, ["repos", "--db", str(bogus_db)])

        assert result.exit_code != 0
        assert "Database not found" in result.output
        assert str(bogus_db) in result.output
