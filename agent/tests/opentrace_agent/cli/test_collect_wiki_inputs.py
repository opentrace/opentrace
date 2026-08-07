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

"""Tests for the --wiki doc-file walk: status stamping + design-history exclusion."""

from __future__ import annotations

from opentrace_agent.cli.main import _collect_wiki_inputs


def _repo(tmp_path):
    (tmp_path / "docs").mkdir()
    (tmp_path / "openspec" / "changes" / "archive").mkdir(parents=True)
    (tmp_path / "README.md").write_text("# Readme")
    (tmp_path / "docs" / "guide.md").write_text("# Guide")
    (tmp_path / "openspec" / "changes" / "proposal.md").write_text("# Proposal")
    (tmp_path / "openspec" / "changes" / "archive" / "old.md").write_text("# Old")
    return tmp_path


def test_walk_stamps_status_per_path(tmp_path):
    inputs = {i.name: i.status for i in _collect_wiki_inputs(_repo(tmp_path))}
    assert inputs["README.md"] == "authoritative"
    assert inputs["docs/guide.md"] == "authoritative"
    assert inputs["openspec/changes/proposal.md"] == "design_history"
    assert inputs["openspec/changes/archive/old.md"] == "design_history_archived"


def test_exclude_design_history_drops_them(tmp_path):
    inputs = _collect_wiki_inputs(_repo(tmp_path), exclude_design_history=True)
    names = {i.name for i in inputs}
    assert names == {"README.md", "docs/guide.md"}


def test_status_override_stamps_every_input(tmp_path):
    inputs = _collect_wiki_inputs(_repo(tmp_path), status_override="design_history")
    assert len(inputs) == 4
    assert {i.status for i in inputs} == {"design_history"}


def test_status_override_with_exclusion_drops_then_forces(tmp_path):
    """Exclusion uses the path heuristic; the override applies to survivors —
    "drop the ADR trees, force the rest"."""
    inputs = _collect_wiki_inputs(_repo(tmp_path), exclude_design_history=True, status_override="design_history")
    assert {i.name for i in inputs} == {"README.md", "docs/guide.md"}
    assert {i.status for i in inputs} == {"design_history"}


def test_status_override_applies_to_single_file(tmp_path):
    f = tmp_path / "note.md"
    f.write_text("# Note")
    (single,) = _collect_wiki_inputs(f, status_override="design_history_archived")
    assert single.status == "design_history_archived"
