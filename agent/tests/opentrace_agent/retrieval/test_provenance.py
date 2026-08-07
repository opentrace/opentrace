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

"""Tests for the OT-1732 Phase 5 Provenance retrieval primitive."""

from __future__ import annotations

import pytest

ladybug = pytest.importorskip("real_ladybug")

from opentrace_agent.retrieval import provenance  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402
from opentrace_agent.wiki.ingest.graph_writer import (  # noqa: E402
    corpus_doc_node_id,
    write_vault_to_graph,
)
from opentrace_agent.wiki.vault import IngestedSource, VaultMetadata  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    s = GraphStore(str(tmp_path / "provdb"))
    yield s
    s.close()


# ---------------------------------------------------------------------------
# Wiki provenance
# ---------------------------------------------------------------------------


def _make_meta() -> VaultMetadata:
    meta = VaultMetadata.empty(name="kb")
    meta.last_compiled_at = "2026-05-01T00:00:00+00:00"
    meta.sources = {
        "sha1": IngestedSource(sha256="sha1", original_name="report.pdf", ingested_at="2026-05-01T00:00:00"),
    }
    return meta


class TestWikiProvenance:
    def test_doc_chain_is_its_own_identity(self, store):
        """A document IS its own provenance. The chain used to be a ``CITES``
        walk from a concept page back to the documents it restated; nothing
        restates a document since 2026-08-04, so the chain is one entry."""
        write_vault_to_graph(store, _make_meta())
        result = provenance(store, corpus_doc_node_id("sha1"))
        assert result["kind"] == "wiki"
        assert [c["kind"] for c in result["wiki"]["chain"]] == ["knowledge_doc"]
        entry = result["wiki"]["chain"][0]
        assert entry["sha256"] == "sha1"
        assert entry["filename"] == "report.pdf"

    def test_corpus_doc_chain_includes_mirrored_file(self, store):
        """A repo-walked doc's chain entry carries the File twin via MIRRORS."""
        write_vault_to_graph(store, _make_meta())
        store.add_node("myrepo/docs/report.pdf", "File", "report.pdf", {"path": "docs/report.pdf"})
        store.add_relationship("m1", "MIRRORS", corpus_doc_node_id("sha1"), "myrepo/docs/report.pdf")
        result = provenance(store, corpus_doc_node_id("sha1"))
        assert result["wiki"]["chain"][0]["file"] == "myrepo/docs/report.pdf"

    def test_vault_node_has_empty_chain(self, store):
        """A vault has no body of its own, so nothing to trace."""
        write_vault_to_graph(store, _make_meta())
        result = provenance(store, "vault::kb")
        assert result["kind"] == "wiki"
        assert result["wiki"]["chain"] == []
        assert result["wiki"]["vault"] == "kb"

    def test_missing_node(self, store):
        result = provenance(store, "nope")
        assert result["kind"] == "unknown"
        assert "not found" in result["error"]


# ---------------------------------------------------------------------------
# Code provenance
# ---------------------------------------------------------------------------


class TestCodeProvenance:
    def test_function_node_resolves_repo_metadata(self, store):
        # Seed a repo with index metadata.
        store.add_node("test/repo", "Repository", "repo", {})
        store.save_metadata(
            {
                "repoId": "test/repo",
                "indexedAt": "2026-04-30T12:00:00",
                "commitSha": "abc1234",
                "opentraceaiVersion": "0.4.0",
                "branch": "main",
            }
        )
        # Add a code node.
        store.add_node(
            "test/repo/src/main.py::greet",
            "Function",
            "greet",
            {"path": "src/main.py", "start_line": 10, "end_line": 20},
        )

        result = provenance(store, "test/repo/src/main.py::greet")
        assert result["kind"] == "code"
        code = result["code"]
        assert code["commit_sha"] == "abc1234"
        assert code["indexer_version"] == "0.4.0"
        assert code["file_path"] == "src/main.py"
        assert code["line_range"] == [10, 20]
        assert code["repo_id"] == "test/repo"

    def test_no_metadata_returns_null_chain(self, store):
        store.add_node("test/repo", "Repository", "repo", {})
        store.add_node(
            "test/repo/src/foo.py::foo",
            "Function",
            "foo",
            {"path": "src/foo.py", "start_line": 1, "end_line": 5},
        )
        result = provenance(store, "test/repo/src/foo.py::foo")
        assert result["kind"] == "code"
        assert result["code"]["commit_sha"] is None
        assert result["code"]["file_path"] == "src/foo.py"
        assert result["code"]["line_range"] == [1, 5]
