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
    page_node_id,
    source_node_id,
    write_vault_to_graph,
)
from opentrace_agent.wiki.vault import IngestedSource, PageMeta, VaultMetadata  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    s = GraphStore(str(tmp_path / "provdb"))
    yield s
    s.close()


# ---------------------------------------------------------------------------
# Wiki provenance
# ---------------------------------------------------------------------------


def _make_meta_and_bodies():
    meta = VaultMetadata.empty(name="kb")
    meta.last_compiled_at = "2026-05-01T00:00:00+00:00"
    meta.sources = {
        "sha1": IngestedSource(sha256="sha1", original_name="report.pdf", ingested_at="2026-05-01T00:00:00"),
    }
    meta.pages = {
        "source-summary-report-pdf": PageMeta(
            slug="source-summary-report-pdf",
            title="report.pdf",
            one_line_summary="Q4 financial report summary.",
            source_shas=["sha1"],
            last_updated="2026-05-01T00:00:00",
            revision=1,
            kind="source_summary",
        ),
        "revenue": PageMeta(
            slug="revenue",
            title="Revenue",
            one_line_summary="Aggregated revenue topic.",
            source_shas=["sha1"],
            last_updated="2026-05-01T00:00:00",
            revision=1,
            kind="concept",
        ),
    }
    bodies = {
        "source-summary-report-pdf": "Summary of report.pdf — see [[Revenue]].",
        "revenue": "Concept revenue uses [[report.pdf]].",
    }
    return meta, bodies


class TestWikiProvenance:
    def test_concept_chain_to_source(self, store):
        meta, bodies = _make_meta_and_bodies()
        write_vault_to_graph(
            store,
            meta,
            bodies,
            provenance={
                "agent": "opentrace-wiki-compiler",
                "model": "claude-opus-4-7",
                "session": "session-uuid",
                "confidence": 0.0,
            },
            compiled_slugs={"source-summary-report-pdf", "revenue"},
        )
        result = provenance(store, page_node_id("kb", "revenue"))
        assert result["kind"] == "wiki"
        assert result["wiki"]["agent"] == "opentrace-wiki-compiler"
        assert result["wiki"]["model"] == "claude-opus-4-7"
        assert result["wiki"]["session"] == "session-uuid"
        assert result["wiki"]["confidence"] == 0.0
        # Chain should include the source-summary page and the source.
        kinds = [c["kind"] for c in result["wiki"]["chain"]]
        assert "wiki_page" in kinds
        assert "source" in kinds
        # The Source entry should carry sha256 + filename.
        source_entry = next(c for c in result["wiki"]["chain"] if c["kind"] == "source")
        assert source_entry["sha256"] == "sha1"
        assert source_entry["filename"] == "report.pdf"

    def test_source_node_returns_self_chain(self, store):
        meta, bodies = _make_meta_and_bodies()
        write_vault_to_graph(store, meta, bodies)
        result = provenance(store, source_node_id("sha1"))
        assert result["kind"] == "wiki"
        assert result["wiki"]["chain"][0]["kind"] == "source"
        assert result["wiki"]["chain"][0]["sha256"] == "sha1"

    def test_unchanged_pages_keep_existing_provenance(self, store):
        """A second compile run that didn't touch a page must NOT clear its
        previously-stamped provenance."""
        meta, bodies = _make_meta_and_bodies()
        first = {
            "agent": "opentrace-wiki-compiler",
            "model": "claude-opus-4-7",
            "session": "first-run",
            "confidence": 0.0,
        }
        write_vault_to_graph(
            store,
            meta,
            bodies,
            provenance=first,
            compiled_slugs={"source-summary-report-pdf", "revenue"},
        )

        # Second pass marks ONLY the summary page as compiled — concept page
        # keeps `first-run` session.
        second = {**first, "session": "second-run"}
        write_vault_to_graph(
            store,
            meta,
            bodies,
            provenance=second,
            compiled_slugs={"source-summary-report-pdf"},
        )

        revenue = provenance(store, page_node_id("kb", "revenue"))
        assert revenue["wiki"]["session"] == "first-run"

        ss = provenance(store, page_node_id("kb", "source-summary-report-pdf"))
        assert ss["wiki"]["session"] == "second-run"

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
