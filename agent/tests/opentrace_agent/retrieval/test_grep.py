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

"""Tests for the OT-1732 Phase 6 Grep retrieval primitive."""

from __future__ import annotations

import os
import shutil
import subprocess
import time

import pytest

ladybug = pytest.importorskip("real_ladybug")


def _find_rg() -> str | None:
    """Locate ripgrep on PATH or in well-known vendored locations.

    Tests run inside ``uv run`` which sometimes strips PATH entries,
    so we widen the search to include the few places ``rg`` is bundled
    on developer machines (Claude Code vendors one for the IDE).
    """
    p = shutil.which("rg")
    if p:
        return p
    for candidate in (
        "/usr/bin/rg",
        "/usr/local/bin/rg",
        os.path.expanduser(
            "~/.nvm/versions/node/v18.20.6/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x64-linux/rg"
        ),
    ):
        if os.access(candidate, os.X_OK):
            return candidate
    return None


# ripgrep is an OPTIONAL accelerator — grep falls back to a Python scan. This
# module must therefore NOT skip when `rg` is missing: doing exactly that is
# what hid a real defect for three benchmark runs. `rg` existed here only as a
# shell function, so `shutil.which` never saw it and every vault grep returned
# "ripgrep not on PATH" in production, while these tests passed by prepending a
# vendored binary to PATH — validating a path production could not take.
# Only the ripgrep-vs-native perf comparison needs the real binary.
_RG = _find_rg()
if _RG is not None:
    os.environ["PATH"] = os.path.dirname(_RG) + os.pathsep + os.environ.get("PATH", "")

from opentrace_agent.retrieval import grep  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    s = GraphStore(str(tmp_path / "grepdb"))
    yield s
    s.close()


@pytest.fixture()
def fixture_repo(tmp_path):
    """Create a small on-disk repo with grep-able content."""
    root = tmp_path / "myrepo"
    (root / "src").mkdir(parents=True)
    (root / "src" / "main.py").write_text(
        "def greet():\n    return 'hello world'\n\ndef shout():\n    return 'HELLO WORLD'\n"
    )
    (root / "src" / "db.py").write_text("def connect():\n    return 'db connection'\n")
    (root / "README.md").write_text("# myrepo\n\nA tiny fixture.\n")
    return root


# ---------------------------------------------------------------------------
# Repository scope
# ---------------------------------------------------------------------------


class TestGrepRepositoryScope:
    def test_basic_match(self, store, fixture_repo):
        store.add_node(
            "myorg/myrepo",
            "Repository",
            "myrepo",
            {"local_path": str(fixture_repo)},
        )
        result = grep(store, "hello", scope_id="myorg/myrepo")
        assert result["mode"] == "ripgrep"
        assert result["count"] >= 2  # 'hello' and 'HELLO' both match (case-insensitive)
        files = {m["file_path"] for m in result["matches"]}
        assert "src/main.py" in files

    def test_case_sensitive(self, store, fixture_repo):
        store.add_node(
            "myorg/myrepo",
            "Repository",
            "myrepo",
            {"local_path": str(fixture_repo)},
        )
        result = grep(store, "HELLO", scope_id="myorg/myrepo", case_sensitive=True)
        # Only the upper-case match
        assert all("HELLO" in m["line_text"] for m in result["matches"])
        # Should NOT include the lowercase 'hello world'
        assert all("hello world" not in m["line_text"] for m in result["matches"])

    def test_file_filter(self, store, fixture_repo):
        store.add_node(
            "myorg/myrepo",
            "Repository",
            "myrepo",
            {"local_path": str(fixture_repo)},
        )
        result = grep(store, "def", scope_id="myorg/myrepo", file_filter="db")
        # Only db.py should be searched.
        files = {m["file_path"] for m in result["matches"]}
        assert files == {"src/db.py"}

    def test_resolves_node_id(self, store, fixture_repo):
        store.add_node(
            "myorg/myrepo",
            "Repository",
            "myrepo",
            {"local_path": str(fixture_repo)},
        )
        result = grep(store, "greet", scope_id="myorg/myrepo")
        assert result["count"] >= 1
        m = result["matches"][0]
        assert m["node_id"] == "myorg/myrepo/src/main.py"

    def test_missing_local_path(self, store):
        store.add_node("myorg/cloned", "Repository", "cloned", {"sourceUri": "https://..."})
        result = grep(store, "x", scope_id="myorg/cloned")
        assert result["mode"] == "error"
        assert "local_path" in result["error"]

    def test_path_gone_from_disk(self, store, tmp_path):
        ghost = str(tmp_path / "deleted")
        store.add_node("myorg/ghost", "Repository", "ghost", {"local_path": ghost})
        result = grep(store, "x", scope_id="myorg/ghost")
        assert result["mode"] == "error"
        assert "not a directory" in result["error"]

    def test_unknown_scope_node(self, store):
        result = grep(store, "x", scope_id="missing")
        assert result["mode"] == "error"

    def test_unsupported_scope_type(self, store):
        store.add_node("f1", "File", "main.py", {"path": "src/main.py"})
        result = grep(store, "x", scope_id="f1")
        assert result["mode"] == "error"
        assert "unsupported scope type" in result["error"]

    def test_max_results_cap(self, store, tmp_path):
        # Generate a file with many matches.
        root = tmp_path / "big"
        root.mkdir()
        (root / "many.txt").write_text("\n".join("foo" for _ in range(200)))
        store.add_node("myorg/big", "Repository", "big", {"local_path": str(root)})
        result = grep(store, "foo", scope_id="myorg/big", max_results=10)
        assert result["count"] <= 10


# ---------------------------------------------------------------------------
# KnowledgeVault scope — the corpus sweep (exhaustiveness primitive)
# ---------------------------------------------------------------------------


class TestGrepVaultCorpusScope:
    """Vault grep sweeps member docs' normalized bodies, joined back to their
    KnowledgeDoc identity. Membership comes from CONTAINS edges — the shared
    sha-keyed corpus dir may hold other vaults' documents."""

    @pytest.fixture(autouse=True)
    def _isolated_vault_root(self, tmp_path, monkeypatch):
        # The pages-layer lookup resolves vault names against real disk roots;
        # pin it to an empty dir so a same-named vault on the dev machine
        # can't leak pages hits into these corpus-only tests.
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "no-vaults"))

    def _seed_vault(self, store, tmp_path):
        # GraphStore lives at tmp_path/grepdb, so db_dir == tmp_path and the
        # corpus sits at tmp_path/corpus — mirroring <db_dir>/corpus/<sha>.md.
        corpus = tmp_path / "corpus"
        corpus.mkdir(exist_ok=True)
        store.add_node("vault::kb", "KnowledgeVault", "kb", {"vault": "kb", "scope": "local"})

        def add_doc(sha: str, path: str, body: str, *, member: bool = True, status: str = "authoritative"):
            (corpus / f"{sha}.md").write_text(body)
            store.add_node(
                f"corpus::{sha}",
                "KnowledgeDoc",
                path.rsplit("/", 1)[-1],
                {
                    "sha256": sha,
                    "corpus_path": f"corpus/{sha}.md",
                    "path": path,
                    "title": path.rsplit("/", 1)[-1].removesuffix(".md").title(),
                    "status": status,
                },
            )
            if member:
                store.merge_relationship(
                    id=f"vault::kb->CONTAINS->corpus::{sha}",
                    rel_type="CONTAINS",
                    source_id="vault::kb",
                    target_id=f"corpus::{sha}",
                )

        add_doc("aaa1", "guides/cold-chain.md", "# Cold chain\nTrailer T-2207 is at capacity.\n")
        add_doc("bbb2", "specs/dc7.md", "# DC-7\nNo capacity concerns this quarter.\n", status="design_history")
        # Same corpus dir, DIFFERENT (hypothetical) vault — no CONTAINS edge.
        add_doc("ccc3", "other/foreign.md", "capacity capacity capacity\n", member=False)
        return corpus

    def test_corpus_hits_join_back_to_docs(self, store, tmp_path):
        self._seed_vault(store, tmp_path)
        result = grep(store, "capacity", scope_id="vault::kb")
        assert result["mode"] == "ripgrep"
        by_node = {m["node_id"]: m for m in result["matches"]}
        assert set(by_node) == {"corpus::aaa1", "corpus::bbb2"}, "non-member doc must not leak into the sweep"
        hit = by_node["corpus::aaa1"]
        assert hit["file_path"] == "guides/cold-chain.md"  # display path, never the sha filename
        assert hit["title"] == "Cold-Chain"
        assert hit["status"] == "authoritative"
        assert hit["structural_context"] == {"scope_type": "KnowledgeVault", "vault": "kb", "layer": "corpus"}
        assert by_node["corpus::bbb2"]["status"] == "design_history"

    def test_file_filter_matches_display_path_not_sha(self, store, tmp_path):
        self._seed_vault(store, tmp_path)
        result = grep(store, "capacity", scope_id="vault::kb", file_filter="guides")
        assert {m["node_id"] for m in result["matches"]} == {"corpus::aaa1"}
        # A filter on the content-addressed name matches nothing — that name
        # is an implementation detail the agent never sees.
        assert grep(store, "capacity", scope_id="vault::kb", file_filter="aaa1")["count"] == 0

    def test_missing_corpus_file_is_skipped_not_fatal(self, store, tmp_path):
        corpus = self._seed_vault(store, tmp_path)
        (corpus / "aaa1.md").unlink()  # e.g. a metadata-only mirror
        result = grep(store, "capacity", scope_id="vault::kb")
        assert result["mode"] == "ripgrep"
        assert {m["node_id"] for m in result["matches"]} == {"corpus::bbb2"}

    def test_no_content_at_all_is_a_structured_error(self, store):
        store.add_node("vault::empty", "KnowledgeVault", "empty", {"vault": "empty"})
        result = grep(store, "x", scope_id="vault::empty")
        assert result["mode"] == "error"
        assert "no on-disk content" in result["error"]

    def test_bare_vault_name_resolves(self, store, tmp_path):
        """`list_vaults` hands back bare names, so a bare name must work as a
        scope. It previously didn't: an agent looked the name up, passed it
        here, got "scope node not found" a second time, and fell back to
        reading 21 documents one at a time."""
        self._seed_vault(store, tmp_path)
        by_id = grep(store, "capacity", scope_id="vault::kb")
        by_name = grep(store, "capacity", scope_id="kb")
        assert by_name["mode"] == "ripgrep"
        assert {m["node_id"] for m in by_name["matches"]} == {m["node_id"] for m in by_id["matches"]}

    def test_bare_repo_name_resolves(self, store, fixture_repo):
        store.add_node("myorg/myrepo", "Repository", "myrepo", {"local_path": str(fixture_repo)})
        result = grep(store, "hello", scope_id="myrepo")
        assert result["mode"] == "ripgrep"
        assert result["count"] >= 2

    def test_unknown_scope_names_the_valid_ones(self, store, tmp_path):
        """The error has to be actionable — the whole failure was an agent
        unable to guess the id format."""
        self._seed_vault(store, tmp_path)
        result = grep(store, "x", scope_id="vault")
        assert result["mode"] == "error"
        assert "Valid scopes in this graph" in result["error"]
        assert "vault::kb" in result["error"]

    def test_unknown_scope_in_empty_graph_says_so(self, store):
        result = grep(store, "x", scope_id="nope")
        assert result["mode"] == "error"
        assert "no Repository or KnowledgeVault" in result["error"]

    def test_line_numbers_refer_to_normalized_body(self, store, tmp_path):
        self._seed_vault(store, tmp_path)
        result = grep(store, "T-2207", scope_id="vault::kb")
        (m,) = result["matches"]
        assert m["line_number"] == 2  # line 2 of the corpus markdown — what load_source returns


# ---------------------------------------------------------------------------
# Performance — within 2x native ripgrep on a fixture repo
# ---------------------------------------------------------------------------


@pytest.mark.skipif(_RG is None, reason="needs a real ripgrep binary to compare against")
class TestGrepPerformance:
    """OT-1732 success criterion: grep within 2x of native ripgrep."""

    def test_within_2x_of_native_rg(self, store, tmp_path):
        # Build a repo of ~200 files with mixed content.
        root = tmp_path / "perfrepo"
        for i in range(20):
            d = root / f"pkg{i}"
            d.mkdir(parents=True)
            for j in range(10):
                (d / f"mod{j}.py").write_text("\n".join(f"def fn_{i}_{j}_{k}():\n    return {k}" for k in range(20)))
        store.add_node("perf/repo", "Repository", "repo", {"local_path": str(root)})

        # Native ripgrep timing.
        t0 = time.monotonic()
        subprocess.run(
            ["rg", "--ignore-case", "fn_5", str(root)],
            capture_output=True,
            check=False,
        )
        native_elapsed = time.monotonic() - t0

        # Our wrapper timing.
        t0 = time.monotonic()
        result = grep(store, "fn_5", scope_id="perf/repo", max_results=5000)
        wrapper_elapsed = time.monotonic() - t0

        assert result["count"] > 0
        # Allow generous slack on small fixtures where overhead dominates;
        # wall-time floor at 50ms keeps the ratio meaningful.
        floor = max(native_elapsed, 0.05)
        assert wrapper_elapsed <= floor * 2.0, (
            f"grep wrapper too slow: {wrapper_elapsed * 1000:.0f}ms vs "
            f"native rg {native_elapsed * 1000:.0f}ms (2x ratio: {floor * 2 * 1000:.0f}ms)"
        )


# ---------------------------------------------------------------------------
# ripgrep-free operation — the fallback that makes grep work everywhere
# ---------------------------------------------------------------------------


class TestGrepWithoutRipgrep:
    """`rg` absent must degrade to a Python scan, not to an error.

    Regression guard for a defect that survived three benchmark runs: grep
    hard-required ripgrep, `shutil.which("rg")` returned None on the dev
    machine (it was a shell function), so the vault-sweep primitive returned
    "ripgrep not on PATH" every single time and the arm answered coverage
    questions by opening documents one at a time instead.
    """

    @pytest.fixture(autouse=True)
    def _no_ripgrep(self, monkeypatch):
        # grep.py calls shutil.which at call time, so patching the shared
        # module object reaches it. (The dotted-string form doesn't work here:
        # retrieval/__init__ re-exports `grep` the FUNCTION, shadowing the
        # module name for monkeypatch's importer.)
        monkeypatch.setattr(shutil, "which", lambda _name: None)

    @pytest.fixture(autouse=True)
    def _isolated_vault_root(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OT_VAULT_ROOT", str(tmp_path / "no-vaults"))

    def test_vault_corpus_sweep_works(self, store, tmp_path):
        TestGrepVaultCorpusScope()._seed_vault(store, tmp_path)
        result = grep(store, "capacity", scope_id="vault::kb")
        assert result["mode"] == "python"
        assert {m["node_id"] for m in result["matches"]} == {"corpus::aaa1", "corpus::bbb2"}
        # Hits stay joined to doc identity — the whole point of a corpus sweep.
        hit = next(m for m in result["matches"] if m["node_id"] == "corpus::aaa1")
        assert hit["file_path"] == "guides/cold-chain.md"
        assert hit["title"] == "Cold-Chain"
        assert hit["line_number"] == 2

    def test_repository_scope_works(self, store, fixture_repo):
        store.add_node("myorg/myrepo", "Repository", "myrepo", {"local_path": str(fixture_repo)})
        result = grep(store, "hello", scope_id="myorg/myrepo")
        assert result["mode"] == "python"
        assert "src/main.py" in {m["file_path"] for m in result["matches"]}

    def test_case_sensitivity_and_regex_honoured(self, store, fixture_repo):
        store.add_node("myorg/myrepo", "Repository", "myrepo", {"local_path": str(fixture_repo)})
        ci = grep(store, "hello", scope_id="myorg/myrepo")
        cs = grep(store, "HELLO", scope_id="myorg/myrepo", case_sensitive=True)
        assert len(ci["matches"]) > len(cs["matches"])
        assert all("HELLO" in m["line_text"] for m in cs["matches"])
        alt = grep(store, "greet|connect", scope_id="myorg/myrepo")
        assert {m["file_path"] for m in alt["matches"]} == {"src/main.py", "src/db.py"}

    def test_max_results_and_file_filter_honoured(self, store, tmp_path):
        root = tmp_path / "big"
        (root / "sub").mkdir(parents=True)
        (root / "many.txt").write_text("\n".join("foo" for _ in range(50)))
        (root / "sub" / "other.txt").write_text("foo\n")
        store.add_node("o/big", "Repository", "big", {"local_path": str(root)})
        assert grep(store, "foo", scope_id="o/big", max_results=10)["count"] == 10
        only = grep(store, "foo", scope_id="o/big", file_filter="sub")
        assert {m["file_path"] for m in only["matches"]} == {"sub/other.txt"}

    def test_invalid_regex_is_not_a_crash(self, store, fixture_repo):
        store.add_node("myorg/myrepo", "Repository", "myrepo", {"local_path": str(fixture_repo)})
        assert grep(store, "([unclosed", scope_id="myorg/myrepo")["count"] == 0
