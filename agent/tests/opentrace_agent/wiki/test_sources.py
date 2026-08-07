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

"""Tests for the Acquire stage — doc-status classification and sha dedup."""

from __future__ import annotations

from opentrace_agent.wiki.ingest.sources import AcquiredSource, acquire, classify_doc_status
from opentrace_agent.wiki.ingest.types import SourceInput
from opentrace_agent.wiki.vault import VaultMetadata


class TestClassifyDocStatus:
    def test_regular_docs_are_authoritative(self):
        assert classify_doc_status("README.md") == "authoritative"
        assert classify_doc_status("docs/AGENT-SETUP.md") == "authoritative"
        assert classify_doc_status("docs/concepts/performance.md") == "authoritative"

    def test_design_trees_are_design_history(self):
        # Active proposals count too — a proposal is intent regardless of
        # whether it has shipped (benchmark: the wrong thresholds came from an
        # ACTIVE openspec copy).
        assert classify_doc_status("openspec/changes/foo/proposal.md") == "design_history"
        assert classify_doc_status("docs/adr/0001-storage.md") == "design_history"
        assert classify_doc_status("rfcs/2026-search.md") == "design_history"
        assert classify_doc_status("design-docs/sync.md") == "design_history"

    def test_archived_design_history(self):
        assert (
            classify_doc_status("openspec/changes/archive/2026-04-24-conflicts/proposal.md")
            == "design_history_archived"
        )

    def test_changelog_is_design_history(self):
        assert classify_doc_status("CHANGELOG.md") == "design_history"
        assert classify_doc_status("pkg/CHANGELOG.rst") == "design_history"

    def test_dir_match_is_component_exact_not_substring(self):
        # "exchanges" contains "changes" but is not a design-history dir.
        assert classify_doc_status("exchanges/rates.md") == "authoritative"

    def test_archive_outside_design_tree_is_authoritative(self):
        # An archive of ordinary docs isn't design history.
        assert classify_doc_status("docs/archive/old-guide.md") == "authoritative"

    def test_case_insensitive(self):
        assert classify_doc_status("OpenSpec/Changes/foo/Design.md") == "design_history"


class TestAcquireStatus:
    def test_status_copied_onto_acquired_source(self):
        out: list[AcquiredSource] = []
        src = SourceInput(name="openspec/p.md", data=b"body", status="design_history")
        list(acquire([src], VaultMetadata(name="v"), out))
        assert len(out) == 1
        assert out[0].status == "design_history"

    def test_status_defaults_to_authoritative(self):
        out: list[AcquiredSource] = []
        list(acquire([SourceInput(name="a.md", data=b"body")], VaultMetadata(name="v"), out))
        assert out[0].status == "authoritative"
