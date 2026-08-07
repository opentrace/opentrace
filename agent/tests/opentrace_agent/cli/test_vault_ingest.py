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

"""End-to-end tests for ``opentraceai vault ingest <folder>``.

The bare-folder ingestion path: no git repo, no File twins, no MIRRORS — a
folder of exported doc files becomes labelled KnowledgeDoc nodes with
folder-relative ``path`` stamps and the authors' own doc→doc LINKS_TO edges.
"""

from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("real_ladybug")

from click.testing import CliRunner  # noqa: E402

from opentrace_agent.cli.vault_cmd import vault  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402


class FakeLLM:
    """Minimal scriptable fake (mirrors tests/opentrace_agent/wiki/conftest.py).

    Pops one scripted ``(tool_name, response)`` per call; raises loudly on an
    unexpected tool or when exhausted — so a test scripted with zero responses
    doubles as an assertion that no LLM call happened at all.
    """

    def __init__(self, scripted: list[tuple[str, dict[str, Any]]]):
        from opentrace_agent.wiki.llm import UsageTally

        self.scripted = list(scripted)
        self.calls: list[str] = []
        self._lock = threading.Lock()
        # A real tally, like real clients carry, so these CLI tests exercise
        # the billed-actuals line in the ingest summary end to end.
        self.usage = UsageTally()

    def call_tool(self, *, system, user, tool_name, tool_schema, max_tokens: int = 4096):
        with self._lock:
            if not self.scripted:
                raise AssertionError(f"FakeLLM called for {tool_name!r} but no responses left")
            expected, response = self.scripted.pop(0)
            if expected != tool_name:
                raise AssertionError(f"FakeLLM expected {expected!r}, got {tool_name!r}")
            self.calls.append(tool_name)
            self.usage.add(480, 55)
            return response


def _extraction(summary: str = "A document.") -> tuple[str, dict]:
    payload: dict[str, Any] = {"one_line_summary": summary}
    return ("emit_extraction", payload)


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


@pytest.fixture(autouse=True)
def _wiki_env(monkeypatch):
    monkeypatch.setenv("OT_WIKI_CONCURRENCY", "1")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")


@pytest.fixture()
def project(tmp_path):
    """A project dir with an `.opentrace/` for the graph DB to live in."""
    proj = tmp_path / "proj"
    (proj / ".opentrace").mkdir(parents=True)
    return proj


@pytest.fixture()
def export(tmp_path):
    """A fake docs export: nested folders, relative cross-links, one dead link."""
    folder = tmp_path / "export"
    (folder / "sub").mkdir(parents=True)
    (folder / "a.md").write_text("# Alpha\nSee [beta](sub/b.md) for the details. Plenty of content here.")
    (folder / "sub" / "b.md").write_text("# Beta\nBack to [alpha](../a.md). And a [dead link](missing.md).")
    return folder


def _patch_llm(monkeypatch, responses: list[tuple[str, dict]]) -> FakeLLM:
    llm = FakeLLM(responses)
    monkeypatch.setattr("opentrace_agent.wiki.ingest.pipeline.make_llm", lambda *a, **k: llm)
    return llm


def _ingest(project: Path, export: Path, *extra_args: str) -> Any:
    db = project / ".opentrace" / "index.db"
    return CliRunner().invoke(
        vault,
        ["ingest", str(export), "--db", str(db), *extra_args],
        catch_exceptions=False,
    )


def _open(project: Path) -> GraphStore:
    return GraphStore(str(project / ".opentrace" / "index.db"))


def _vault_meta(project: Path, name: str = "export") -> dict:
    return json.loads((project / ".opentrace" / "vaults" / name / ".vault.json").read_text())


class TestIngestEndToEnd:
    def test_docs_land_labelled_with_paths_and_no_file_twins(self, project, export, monkeypatch):
        _patch_llm(monkeypatch, [_extraction("Alpha doc."), _extraction("Beta doc.")])
        result = _ingest(project, export)
        assert result.exit_code == 0, result.output

        store = _open(project)
        try:
            docs = store.list_nodes("KnowledgeDoc")
            by_path = {d["properties"].get("path"): d for d in docs}
            assert set(by_path) == {"a.md", "sub/b.md"}
            for doc in docs:
                props = doc["properties"]
                assert props["status"] == "authoritative"
                assert props.get("title")
                assert props.get("one_line_summary") or props.get("summary")
            # The whole point of the bare-folder path: the KnowledgeDoc IS the
            # document — no File twins, no MIRRORS, no repo DOCUMENTS edge.
            assert store.list_nodes("File") == []
            for doc in docs:
                mirrors = store.traverse(doc["id"], direction="outgoing", max_depth=1, relationship_type="MIRRORS")
                assert mirrors == []
        finally:
            store.close()

        # Corpus bodies written next to the DB so load_source resolves.
        corpus = list((project / ".opentrace" / "corpus").glob("*.md"))
        assert len(corpus) == 2

    def test_doc_to_doc_links_resolve_folder_relative(self, project, export, monkeypatch):
        _patch_llm(monkeypatch, [_extraction(), _extraction()])
        assert _ingest(project, export).exit_code == 0

        store = _open(project)
        try:
            a_id = f"corpus::{_sha(export / 'a.md')}"
            b_id = f"corpus::{_sha(export / 'sub' / 'b.md')}"
            a_out = store.traverse(a_id, direction="outgoing", max_depth=1, relationship_type="LINKS_TO")
            assert [r["node"]["id"] for r in a_out] == [b_id]
            b_out = store.traverse(b_id, direction="outgoing", max_depth=1, relationship_type="LINKS_TO")
            # ../a.md resolves against sub/; missing.md finds no doc and drops.
            assert [r["node"]["id"] for r in b_out] == [a_id]
        finally:
            store.close()

    def test_status_override_survives_post_compile_stamp(self, project, export, monkeypatch):
        """--status must beat the path heuristic in BOTH writes: the pipeline
        (via SourceInput.status) and the post-compile stamp_doc_paths pass,
        which would otherwise re-derive 'authoritative' from the paths."""
        _patch_llm(monkeypatch, [_extraction(), _extraction()])
        assert _ingest(project, export, "--status", "design_history").exit_code == 0

        store = _open(project)
        try:
            statuses = {d["properties"].get("status") for d in store.list_nodes("KnowledgeDoc")}
            assert statuses == {"design_history"}
        finally:
            store.close()

    def test_summary_names_the_payoff(self, project, export, monkeypatch):
        _patch_llm(monkeypatch, [_extraction(), _extraction()])
        out = _ingest(project, export).output
        assert "✓ local vault 'export'" in out
        assert "on disk:" in out
        assert "Next:" in out

    def test_summary_reports_billed_actuals(self, project, export, monkeypatch):
        """The estimate prints before spending; the summary must print what was
        actually billed after, so a stale estimate assumption gets contradicted
        on the very next run (ours ran 6.5x stale with nothing to contradict it)."""
        _patch_llm(monkeypatch, [_extraction(), _extraction()])
        out = _ingest(project, export).output
        assert "llm: 960 in / 110 out across 2 call(s)" in out
        assert "billed" in out  # dollar conversion at extraction-tier rates

    def test_no_actuals_line_when_nothing_was_billed(self, project, export, monkeypatch):
        _patch_llm(monkeypatch, [_extraction(), _extraction()])
        assert _ingest(project, export).exit_code == 0
        # All-duplicate re-run: zero LLM calls, so no actuals line.
        _patch_llm(monkeypatch, [])
        out = _ingest(project, export).output
        assert "llm:" not in out


class TestReingest:
    def test_second_run_reuses_vault_and_calls_no_llm(self, project, export, monkeypatch):
        _patch_llm(monkeypatch, [_extraction(), _extraction()])
        assert _ingest(project, export).exit_code == 0

        # Zero scripted responses: any LLM call on the re-run raises.
        _patch_llm(monkeypatch, [])
        result = _ingest(project, export)
        assert result.exit_code == 0, result.output

        vaults = sorted(p.name for p in (project / ".opentrace" / "vaults").iterdir() if p.is_dir())
        assert vaults == ["export"], "re-ingest must update in place, not mint 'export-1'"
        meta = _vault_meta(project)
        assert meta["spawned_from"] == f"dir::{export.resolve()}"
        assert len(meta["sources"]) == 2

    def test_deleted_doc_is_pruned_from_graph_and_meta(self, project, export, monkeypatch):
        _patch_llm(monkeypatch, [_extraction(), _extraction()])
        assert _ingest(project, export).exit_code == 0
        b = export / "sub" / "b.md"
        b_sha = _sha(b)

        store = _open(project)
        try:
            assert store.get_node(f"corpus::{b_sha}") is not None
        finally:
            store.close()

        b.unlink()
        _patch_llm(monkeypatch, [])
        result = _ingest(project, export)
        assert result.exit_code == 0, result.output

        store = _open(project)
        try:
            assert store.get_node(f"corpus::{b_sha}") is None
        finally:
            store.close()
        assert b_sha not in _vault_meta(project)["sources"], "meta prune stops the next mirror resurrecting it"

    def test_no_prune_preserves_deleted_docs(self, project, export, monkeypatch):
        _patch_llm(monkeypatch, [_extraction(), _extraction()])
        assert _ingest(project, export).exit_code == 0
        b = export / "sub" / "b.md"
        b_sha = _sha(b)
        b.unlink()

        _patch_llm(monkeypatch, [])
        assert _ingest(project, export, "--no-prune").exit_code == 0

        store = _open(project)
        try:
            assert store.get_node(f"corpus::{b_sha}") is not None
        finally:
            store.close()
        assert b_sha in _vault_meta(project)["sources"]


class TestCoverage:
    def test_json_is_ingested_and_survives_reingest_prune(self, project, tmp_path, monkeypatch):
        """.json is data-as-docs for folder ingests (like .csv). The prune walk
        must see the same extension set — under DOC_EXTENSIONS alone, the
        re-run's keep-set misses the json doc and deletes it as 'removed'."""
        folder = tmp_path / "data-export"
        folder.mkdir()
        (folder / "fleet-inventory.json").write_text(
            '{"trailers": [{"id": "T-2207", "class": "T", "tempguard": true}]}'
        )
        _patch_llm(monkeypatch, [_extraction("Fleet inventory.")])
        result = _ingest(project, folder)
        assert result.exit_code == 0, result.output

        store = _open(project)
        try:
            docs = store.list_nodes("KnowledgeDoc")
            assert {d["properties"].get("path") for d in docs} == {"fleet-inventory.json"}
        finally:
            store.close()

        _patch_llm(monkeypatch, [])
        assert _ingest(project, folder).exit_code == 0
        store = _open(project)
        try:
            assert len(store.list_nodes("KnowledgeDoc")) == 1, "re-ingest prune must not eat the json doc"
        finally:
            store.close()

    def test_unsupported_files_are_reported_not_silent(self, project, export, monkeypatch):
        """A file the walker skips must show up in the summary — '14 docs' over
        a 15-file folder reads as complete coverage when it isn't."""
        (export / "fleet.xyz").write_text("some unsupported format")
        _patch_llm(monkeypatch, [_extraction(), _extraction()])
        out = _ingest(project, export).output
        assert "not walked (unsupported type): 1 × .xyz (fleet.xyz)" in out


class TestScopesAndPreflight:
    def test_fresh_docs_dir_needs_no_repo_and_no_existing_project(self, tmp_path, export, monkeypatch):
        """The standalone story: cd into a dir with docs, run ingest, done.
        No git repo, no prior `opentraceai index` — a docs-only graph DB is
        created on the spot so the vault is searchable immediately."""
        workdir = tmp_path / "fresh"
        workdir.mkdir()
        monkeypatch.chdir(workdir)
        _patch_llm(monkeypatch, [_extraction(), _extraction()])

        result = CliRunner().invoke(vault, ["ingest", str(export)], catch_exceptions=False)
        assert result.exit_code == 0, result.output
        assert "created a docs-only graph" in result.output

        db = workdir / ".opentrace" / "index.db"
        assert db.exists()
        store = GraphStore(str(db))
        try:
            docs = store.list_nodes("KnowledgeDoc")
            assert {d["properties"].get("path") for d in docs} == {"a.md", "sub/b.md"}
            assert store.list_nodes("File") == []  # docs-only graph, no code walk
        finally:
            store.close()

    def test_global_scope_is_disk_only_with_attach_hint(self, tmp_path, export, monkeypatch):
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "globals"))
        monkeypatch.chdir(tmp_path)
        _patch_llm(monkeypatch, [_extraction(), _extraction()])

        result = CliRunner().invoke(vault, ["ingest", str(export), "--scope", "global"], catch_exceptions=False)
        assert result.exit_code == 0, result.output
        assert (tmp_path / "globals" / "export" / ".vault.json").exists()
        assert "vault attach" in result.output
        # Disk-only: nothing indexed into any project graph here.
        assert not (tmp_path / ".opentrace").exists()

    def test_explicit_db_creates_missing_parent_dirs(self, tmp_path, export, monkeypatch):
        """--db into a not-yet-existing dir must work — the auto-create path
        mkdirs its parent, and an explicit path deserves the same treatment
        (hit live: a benchmark arm dir made fresh, then --db into it)."""
        _patch_llm(monkeypatch, [_extraction(), _extraction()])
        db = tmp_path / "fresh-proj" / ".opentrace" / "index.db"
        result = CliRunner().invoke(vault, ["ingest", str(export), "--db", str(db)], catch_exceptions=False)
        assert result.exit_code == 0, result.output
        assert db.exists()

    def test_missing_llm_key_fails_before_touching_disk(self, project, export, monkeypatch):
        keys = (
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "OPENAI_API_KEY",
            "KIMI_API_KEY",
            "OLLAMA_BASE_URL",
            "OT_LOCAL_LLM_URL",
        )
        for var in keys:
            monkeypatch.delenv(var, raising=False)
        result = _ingest(project, export)
        assert result.exit_code != 0
        assert "No LLM backend configured" in result.output
        assert not (project / ".opentrace" / "vaults").exists(), "preflight must fail before any vault write"
