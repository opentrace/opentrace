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

"""Tests for ``opentrace source-grep`` CLI surface.

Most cases run rg against real on-disk fixtures so the path-resolution
logic (rehoming, literal fallback, absolute-path scrubbing) is
exercised end-to-end. Mocking the filesystem would dodge the parts
most likely to drift between environments.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest
from click.testing import CliRunner

real_ladybug = pytest.importorskip("real_ladybug")

from opentrace_agent.cli.main import app  # noqa: E402
from opentrace_agent.cli.source_grep import (  # noqa: E402
    _convention_suffix,
    _resolve_clone_path,
)
from opentrace_agent.store import GraphStore  # noqa: E402

pytestmark = pytest.mark.skipif(
    shutil.which("rg") is None,
    reason="ripgrep not installed; source-grep tests require rg on PATH",
)


@pytest.fixture()
def grep_env(tmp_path, monkeypatch):
    """Build a DB plus on-disk clones laid out like the real system.

    Three indexed repos:

    - ``alpha``: clone lives under the **current** ``$HOME/.opentrace/repos/``.
      Stored ``repoPath`` is a *fake* path under a different home dir,
      so retrieving the clone requires rehoming via the convention.
    - ``beta``: clone lives at an explicit absolute path with no
      convention applied (the ``opentrace index <local>`` flow).
      Stored ``repoPath`` matches the actual location verbatim.
    - ``gamma``: stored ``repoPath`` points nowhere on this machine
      and the convention rehoming would also fail (clone deleted /
      never copied across). Acts as the loud-error case.

    ``$HOME`` is monkeypatched to ``tmp_path / "home"`` so the test
    doesn't depend on the developer's real home directory.
    """
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))

    # alpha: clone under fake_home/.opentrace/repos/acme/alpha,
    # but stored repoPath references a *different* indexing host's home.
    alpha_clone = fake_home / ".opentrace" / "repos" / "acme" / "alpha"
    alpha_clone.mkdir(parents=True)
    (alpha_clone / "main.py").write_text("def parse_alpha():\n    return 'alpha'\n")
    (alpha_clone / "README.md").write_text("alpha\n")
    alpha_stored_path = "/Users/someoneElse/.opentrace/repos/acme/alpha"

    # beta: clone at an arbitrary path that does exist locally.
    beta_clone = tmp_path / "workspace" / "beta-project"
    beta_clone.mkdir(parents=True)
    (beta_clone / "main.go").write_text("package beta\nfunc Parse() string { return \"beta\" }\n")

    # gamma: stored path is the convention shape but the clone isn't
    # present under fake_home, AND the literal path doesn't exist.
    gamma_stored_path = "/Users/yetAnother/.opentrace/repos/acme/gamma"

    # Build the DB.
    db_path = str(tmp_path / "grep.db")
    store = GraphStore(db_path)

    # Repository nodes
    store.add_node("alpha", "Repository", "alpha", {})
    store.add_node("beta", "Repository", "beta", {})
    store.add_node("gamma", "Repository", "gamma", {})

    # IndexMetadata rows. The repos command (and our _load_repo_paths)
    # read from store.get_metadata(); GraphStore.save_metadata writes
    # (or upserts) one IndexMetadata row per call.
    store.save_metadata({"repoId": "alpha", "repoPath": alpha_stored_path})
    store.save_metadata({"repoId": "beta", "repoPath": str(beta_clone)})
    store.save_metadata({"repoId": "gamma", "repoPath": gamma_stored_path})

    store.close()
    yield {
        "db_path": db_path,
        "fake_home": fake_home,
        "alpha_clone": alpha_clone,
        "beta_clone": beta_clone,
    }


def _invoke(db_path: str, *args: str) -> Any:
    """Run the source-grep click command with extra args."""
    return CliRunner().invoke(app, ["source-grep", *args, "--db", db_path])


class TestConventionSuffix:
    """Unit tests for the path-shape detector that drives rehoming."""

    def test_extracts_suffix_under_dot_opentrace_repos(self) -> None:
        assert _convention_suffix(
            "/Users/dapywell/.opentrace/repos/pallets/click"
        ) == ("pallets", "click")

    def test_handles_org_repo_with_extra_segments(self) -> None:
        assert _convention_suffix(
            "/home/anys/.opentrace/repos/acme/widgets/v2"
        ) == ("acme", "widgets", "v2")

    def test_returns_none_for_non_convention_path(self) -> None:
        # opentrace index <local-path> stores the user's workspace; this
        # path doesn't pass through .opentrace/repos/.
        assert _convention_suffix("/Users/anys/work/myproject") is None

    def test_returns_none_for_truncated_convention(self) -> None:
        # The marker exists but nothing follows.
        assert _convention_suffix("/Users/anys/.opentrace/repos") is None


class TestResolveClonePath:
    """Unit tests for the rehoming + literal-fallback strategy."""

    def test_prefers_rehomed_over_literal(self, tmp_path, monkeypatch) -> None:
        # Both candidate paths exist; the rehomed one should win.
        fake_home = tmp_path / "home"
        rehomed = fake_home / ".opentrace" / "repos" / "x" / "y"
        rehomed.mkdir(parents=True)
        literal = tmp_path / "literal" / ".opentrace" / "repos" / "x" / "y"
        literal.mkdir(parents=True)
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))

        result = _resolve_clone_path(str(literal))
        assert result == rehomed

    def test_falls_back_to_literal_when_rehome_missing(self, tmp_path, monkeypatch) -> None:
        fake_home = tmp_path / "empty-home"
        fake_home.mkdir()
        # No rehomed dir exists.
        literal = tmp_path / "literal-only"
        literal.mkdir()
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))

        result = _resolve_clone_path(str(literal))
        assert result == literal

    def test_returns_none_when_neither_exists(self, tmp_path, monkeypatch) -> None:
        fake_home = tmp_path / "empty-home"
        fake_home.mkdir()
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))

        assert _resolve_clone_path("/nope/does/not/exist") is None

    def test_none_input_returns_none(self) -> None:
        # Repos without a stored repoPath get None straight through.
        assert _resolve_clone_path(None) is None


class TestRepoResolution:
    """Integration tests around clone-path resolution end-to-end."""

    def test_rehoming_finds_alpha(self, grep_env) -> None:
        # alpha's stored repoPath points at a non-existent home dir,
        # but the convention path under the (monkeypatched) current
        # home does exist — rehoming should find it.
        result = _invoke(grep_env["db_path"], "parse_alpha", "--repo", "alpha")
        assert result.exit_code == 0, result.output
        assert "[alpha] main.py:1:def parse_alpha():" in result.output

    def test_literal_path_used_for_locally_indexed_repo(self, grep_env) -> None:
        # beta's stored path is the absolute path under tmp_path —
        # the convention doesn't apply, literal fallback wins.
        result = _invoke(grep_env["db_path"], "Parse", "--repo", "beta")
        assert result.exit_code == 0, result.output
        assert "[beta] main.go:" in result.output

    def test_missing_clone_surfaces_loud_error(self, grep_env) -> None:
        # gamma's clone is nowhere; the user must see a clear note,
        # not a silent "no matches".
        result = _invoke(grep_env["db_path"], "anything", "--repo", "gamma")
        assert result.exit_code == 0, result.output
        assert "No matches" in result.output
        assert "some repos were not searched" in result.output
        assert "[gamma]" in result.output
        assert "no clone found locally" in result.output

    def test_unknown_repo_lists_candidates(self, grep_env) -> None:
        result = _invoke(grep_env["db_path"], "x", "--repo", "does-not-exist")
        # ClickException -> exit code 1 (pin it; "!= 0" would mask a
        # regression where we accidentally start using e.g. abort()).
        assert result.exit_code == 1
        assert "No repo with id 'does-not-exist'" in result.output
        # Available list includes all three indexed repos.
        for rid in ("alpha", "beta", "gamma"):
            assert rid in result.output

    def test_repo_without_repopath_emits_specific_error(self, tmp_path, monkeypatch) -> None:
        # A Repository node with no IndexMetadata row hits the "no
        # repoPath stored" branch. Easy to mis-handle as a generic
        # "no clone found"; the specific message tells the user to
        # re-index, not to look for the clone.
        fake_home = tmp_path / "home"
        fake_home.mkdir()
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))

        db_path = str(tmp_path / "orphan.db")
        store = GraphStore(db_path)
        store.add_node("orphan", "Repository", "orphan", {})
        # Deliberately no save_metadata call.
        store.close()

        result = _invoke(db_path, "anything", "--repo", "orphan")
        assert result.exit_code == 0, result.output
        assert "[orphan]" in result.output
        assert "no repoPath stored" in result.output


class TestUnfilteredSearch:
    def test_searches_all_repos_when_no_filter(self, grep_env) -> None:
        # Without --repo, both findable repos should be searched, and
        # gamma's missing-clone error should be reported alongside.
        result = _invoke(grep_env["db_path"], "Parse|parse_alpha")

        assert result.exit_code == 0, result.output
        assert "[alpha]" in result.output
        assert "[beta]" in result.output
        assert "some repos were not searched" in result.output
        assert "[gamma]" in result.output


class TestAbsolutePathScrubbing:
    def test_output_does_not_leak_indexing_host_paths(self, grep_env) -> None:
        # The indexer-host stored repoPath was /Users/someoneElse/...
        # That path must NEVER appear in scrubbed output, even though
        # we walked the rehomed clone with a different absolute path.
        result = _invoke(grep_env["db_path"], "parse_alpha", "--repo", "alpha")

        assert result.exit_code == 0, result.output
        assert "/Users/someoneElse" not in result.output
        # And the rehomed absolute path is also stripped — output is
        # repo-relative only.
        assert str(grep_env["alpha_clone"]) not in result.output


class TestIncludeFilter:
    def test_glob_restricts_files_matched(self, grep_env) -> None:
        # alpha has both main.py and README.md mentioning "alpha". The
        # *.py glob should keep the .py hit and drop the .md one.
        result = _invoke(
            grep_env["db_path"],
            "alpha",
            "--repo",
            "alpha",
            "--include",
            "*.py",
        )

        assert result.exit_code == 0, result.output
        assert "main.py" in result.output
        assert "README.md" not in result.output


class TestJsonOutput:
    def test_shape(self, grep_env) -> None:
        result = _invoke(
            grep_env["db_path"],
            "parse_alpha",
            "--repo",
            "alpha",
            "--json",
        )

        assert result.exit_code == 0, result.output
        data = json.loads(result.output)

        assert data["pattern"] == "parse_alpha"
        assert data["repo"] == "alpha"
        assert data["errors"] == []
        assert len(data["results"]) == 1
        bucket = data["results"][0]
        assert bucket["repo"] == "alpha"
        assert len(bucket["matches"]) == 1
        match = bucket["matches"][0]
        assert match["path"] == "main.py"
        assert match["line"] == 1
        assert "parse_alpha" in match["text"]

    def test_errors_surface_in_json(self, grep_env) -> None:
        result = _invoke(grep_env["db_path"], "x", "--repo", "gamma", "--json")

        assert result.exit_code == 0, result.output
        data = json.loads(result.output)
        assert data["results"] == []
        assert len(data["errors"]) == 1
        assert data["errors"][0]["repo"] == "gamma"
        assert "no clone found locally" in data["errors"][0]["message"]

    def test_truncated_flag_in_json(self, tmp_path, monkeypatch) -> None:
        # Same setup as TestPerRepoLimit but checks the JSON-side flag,
        # which downstream consumers are likely to branch on.
        fake_home = tmp_path / "home"
        fake_home.mkdir()
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))

        clone = fake_home / ".opentrace" / "repos" / "acme" / "wide"
        clone.mkdir(parents=True)
        for i in range(3):
            (clone / f"f{i}.txt").write_text("HIT\n" * 4)

        db_path = str(tmp_path / "wide.db")
        store = GraphStore(db_path)
        store.add_node("wide", "Repository", "wide", {})
        store.save_metadata(
            {"repoId": "wide", "repoPath": "/Users/elsewhere/.opentrace/repos/acme/wide"}
        )
        store.close()

        result = _invoke(db_path, "HIT", "--repo", "wide", "--limit", "5", "--json")
        assert result.exit_code == 0, result.output

        data = json.loads(result.output)
        assert data["limit"] == 5
        assert len(data["results"]) == 1
        assert data["results"][0]["truncated"] is True
        assert len(data["results"][0]["matches"]) == 5


class TestPerRepoLimit:
    """``--limit`` is a per-repo cap, not rg's per-file ``--max-count``."""

    def test_truncates_total_matches_across_files(self, tmp_path, monkeypatch) -> None:
        fake_home = tmp_path / "home"
        fake_home.mkdir()
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))

        # 3 files × 4 matches each = 12 total. With --limit 5, the
        # output must contain exactly 5 match lines, plus a
        # truncation indicator. Without the per-repo cap, you'd see
        # all 12 (rg's --max-count is per file).
        clone = fake_home / ".opentrace" / "repos" / "acme" / "wide"
        clone.mkdir(parents=True)
        for i in range(3):
            (clone / f"f{i}.txt").write_text("HIT\n" * 4)

        db_path = str(tmp_path / "wide.db")
        store = GraphStore(db_path)
        store.add_node("wide", "Repository", "wide", {})
        store.save_metadata(
            {"repoId": "wide", "repoPath": "/Users/elsewhere/.opentrace/repos/acme/wide"}
        )
        store.close()

        result = _invoke(db_path, "HIT", "--repo", "wide", "--limit", "5")
        assert result.exit_code == 0, result.output

        match_lines = [
            line for line in result.output.splitlines()
            if line.startswith("[wide] ")
        ]
        assert len(match_lines) == 5, result.output
        assert "truncated at 5 matches per repo" in result.output

    def test_no_truncation_indicator_when_under_limit(self, grep_env) -> None:
        # alpha has exactly one match for parse_alpha; --limit 50 is
        # comfortably above it. No truncation message should appear.
        result = _invoke(grep_env["db_path"], "parse_alpha", "--repo", "alpha")
        assert result.exit_code == 0, result.output
        assert "truncated" not in result.output


class TestPatternFlagInjection:
    """Patterns starting with ``-`` must not be parsed as rg flags."""

    def test_leading_dash_pattern_is_treated_as_regex(self, grep_env) -> None:
        # Patterns like "-version" must reach rg as a regex, not as a
        # flag. We pass it via click's `--` separator (so click treats
        # it as the positional pattern) and expect our `--` separator
        # before pattern to keep rg from interpreting it as a flag.
        # The pattern doesn't match anything in alpha, so success
        # looks like exit-0 + "No matches", not "ripgrep failed".
        runner = CliRunner()
        result = runner.invoke(
            app,
            [
                "source-grep",
                "--db",
                grep_env["db_path"],
                "--repo",
                "alpha",
                "--",
                "-nonexistent-pattern",
            ],
        )
        assert result.exit_code == 0, result.output
        assert "No matches" in result.output
        # If our `--` separator were missing, rg would have rejected
        # the pattern as an unknown flag and surfaced this message.
        assert "ripgrep failed" not in result.output


class TestRipgrepErrors:
    def test_invalid_regex_surfaces_as_repo_error(self, grep_env) -> None:
        # `[` is an unterminated character class — rg exits with 2.
        # We translate that into a per-repo error rather than
        # crashing or pretending there are no matches.
        result = _invoke(grep_env["db_path"], "[", "--repo", "alpha")
        assert result.exit_code == 0, result.output
        assert "ripgrep failed" in result.output
        assert "[alpha]" in result.output
