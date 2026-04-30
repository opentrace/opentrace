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

"""Tests for the ``fetch-and-index`` command.

Two surfaces are exercised:

- ``_update_existing_clone`` (the pull path): failures must surface to
  the caller, and any URL with embedded credentials must be scrubbed
  before being echoed.
- The ``fetch_and_index`` command body: URL parsing, the three
  ``clone_dir`` filesystem branches, and token-precedence resolution.
  ``_do_clone``, ``_update_existing_clone`` and ``_run_indexing_pipeline``
  are stubbed so the tests don't hit the network or run the pipeline.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

from click.testing import CliRunner

from opentrace_agent.cli.main import (
    _scrub_token,
    _update_existing_clone,
    app,
)


class TestScrubToken:
    def test_redacts_oauth2_token(self) -> None:
        msg = "fatal: unable to access 'https://oauth2:ghp_secret123@github.com/x/y'"
        assert "ghp_secret123" not in _scrub_token(msg)
        assert "[REDACTED]" in _scrub_token(msg)

    def test_redacts_user_password_form(self) -> None:
        msg = "remote: error from https://user:pw@gitlab.example.com/foo/bar"
        scrubbed = _scrub_token(msg)
        assert "user:pw" not in scrubbed
        assert "https://[REDACTED]@gitlab.example.com/foo/bar" in scrubbed

    def test_no_change_when_no_userinfo(self) -> None:
        # Plain URLs (no embedded creds) round-trip unchanged.
        msg = "fatal: refusing to merge unrelated histories on https://github.com/x/y"
        assert _scrub_token(msg) == msg

    def test_handles_multiple_urls(self) -> None:
        msg = "tried https://t1:s@a.com and https://t2:s@b.com"
        scrubbed = _scrub_token(msg)
        assert "t1:s" not in scrubbed
        assert "t2:s" not in scrubbed
        assert scrubbed.count("[REDACTED]") == 2


class TestUpdateExistingClone:
    """The pull path must report failures and never leak tokens."""

    def _fake_run_factory(self, results: list[subprocess.CompletedProcess]):
        """Return a fake subprocess.run that yields *results* in order."""
        calls: list[list[str]] = []
        idx = [0]

        def fake_run(args, **kwargs):
            calls.append(args)
            r = results[idx[0]]
            idx[0] += 1
            return r

        return fake_run, calls

    def test_pull_success_is_silent(self, tmp_path, capsys) -> None:
        clone_dir = tmp_path / "clone"
        clone_dir.mkdir()

        fake_run, _ = self._fake_run_factory(
            [
                subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""),
            ]
        )
        with patch("opentrace_agent.cli.main.subprocess.run", side_effect=fake_run):
            _update_existing_clone(clone_dir, ref=None)

        captured = capsys.readouterr()
        # No warning when pull succeeds.
        assert captured.err == ""

    def test_pull_failure_warns_loudly(self, tmp_path, capsys) -> None:
        """A non-zero git exit code must surface as a stderr warning;
        otherwise the caller silently indexes stale code."""
        clone_dir = tmp_path / "clone"
        clone_dir.mkdir()

        fake_run, _ = self._fake_run_factory(
            [
                subprocess.CompletedProcess(
                    args=[],
                    returncode=1,
                    stdout="",
                    stderr="fatal: Authentication failed",
                ),
            ]
        )
        with patch("opentrace_agent.cli.main.subprocess.run", side_effect=fake_run):
            _update_existing_clone(clone_dir, ref=None)

        captured = capsys.readouterr()
        assert "Warning" in captured.err
        assert "git pull --ff-only" in captured.err
        assert "Authentication failed" in captured.err
        assert "stale" in captured.err  # surfaces the consequence

    def test_pull_failure_scrubs_token_in_warning(self, tmp_path, capsys) -> None:
        """A token-bearing origin URL echoed by git on failure must be
        redacted before the warning is logged."""
        clone_dir = tmp_path / "clone"
        clone_dir.mkdir()

        fake_run, _ = self._fake_run_factory(
            [
                subprocess.CompletedProcess(
                    args=[],
                    returncode=128,
                    stdout="",
                    stderr=(
                        "fatal: unable to access "
                        "'https://oauth2:ghp_supersecret123@github.com/o/r/': "
                        "Could not resolve host"
                    ),
                ),
            ]
        )
        with patch("opentrace_agent.cli.main.subprocess.run", side_effect=fake_run):
            _update_existing_clone(clone_dir, ref=None)

        captured = capsys.readouterr()
        assert "ghp_supersecret123" not in captured.err
        assert "[REDACTED]" in captured.err

    def test_ref_path_runs_fetch_then_checkout(self, tmp_path, capsys) -> None:
        clone_dir = tmp_path / "clone"
        clone_dir.mkdir()

        fake_run, calls = self._fake_run_factory(
            [
                subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""),
                subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""),
            ]
        )
        with patch("opentrace_agent.cli.main.subprocess.run", side_effect=fake_run):
            _update_existing_clone(clone_dir, ref="release-1.2")

        # First call is fetch of the requested ref; second is checkout -B.
        assert calls[0][3:] == ["fetch", "--depth=1", "origin", "release-1.2"]
        assert calls[1][3:] == ["checkout", "-B", "release-1.2", "FETCH_HEAD"]
        assert capsys.readouterr().err == ""

    def test_flag_like_ref_is_refused_without_running_git(self, tmp_path, capsys) -> None:
        """A ref starting with '-' must not reach git: passed as a trailing
        positional to ``git fetch ... <ref>`` or ``git checkout -B <ref>
        ...`` it could be reinterpreted as an option (e.g.
        ``--upload-pack=evil``). Git itself rejects such refs anyway, so
        we short-circuit with a warning and never spawn a subprocess."""
        clone_dir = tmp_path / "clone"
        clone_dir.mkdir()

        called = False

        def fake_run(args, **kwargs):  # pragma: no cover - must not run
            nonlocal called
            called = True
            return subprocess.CompletedProcess(args=args, returncode=0, stdout="", stderr="")

        with patch("opentrace_agent.cli.main.subprocess.run", side_effect=fake_run):
            _update_existing_clone(clone_dir, ref="--upload-pack=evil")

        assert called is False
        captured = capsys.readouterr()
        assert "refusing ref" in captured.err
        assert "--upload-pack=evil" in captured.err

    def test_ref_fetch_failure_does_not_run_checkout(self, tmp_path, capsys) -> None:
        clone_dir = tmp_path / "clone"
        clone_dir.mkdir()

        fake_run, calls = self._fake_run_factory(
            [
                subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="fatal: bad ref"),
            ]
        )
        with patch("opentrace_agent.cli.main.subprocess.run", side_effect=fake_run):
            _update_existing_clone(clone_dir, ref="missing-branch")

        # Only the fetch ran; checkout was skipped because fetch failed.
        assert len(calls) == 1
        captured = capsys.readouterr()
        assert "git fetch origin missing-branch" in captured.err
        assert "stale" in captured.err

    def test_pull_uses_clean_env_no_terminal_prompt(self, tmp_path) -> None:
        """Disable interactive prompts so the pull can't hang waiting
        for credentials when the persisted token has been revoked."""
        clone_dir = tmp_path / "clone"
        clone_dir.mkdir()

        captured_env: dict[str, str] = {}

        def fake_run(args, **kwargs):
            captured_env.update(kwargs.get("env") or {})
            return subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")

        with patch("opentrace_agent.cli.main.subprocess.run", side_effect=fake_run):
            _update_existing_clone(clone_dir, ref=None)

        # _clean_env() flips both of these; the pull would hang without them.
        assert captured_env.get("GIT_TERMINAL_PROMPT") == "0"
        assert captured_env.get("GIT_ASKPASS") == ""

    def test_timeout_is_reported_not_raised(self, tmp_path, capsys) -> None:
        clone_dir = tmp_path / "clone"
        clone_dir.mkdir()

        def fake_run(args, **kwargs):
            raise subprocess.TimeoutExpired(cmd=args, timeout=60)

        with patch("opentrace_agent.cli.main.subprocess.run", side_effect=fake_run):
            # Must not raise — fetch-and-index continues with the existing
            # (stale) clone rather than aborting the whole command.
            _update_existing_clone(clone_dir, ref=None)

        captured = capsys.readouterr()
        assert "timed out" in captured.err


# ---------------------------------------------------------------------------
# fetch-and-index command body
# ---------------------------------------------------------------------------


class _FakeHome:
    """Stand-in for ``Path.home()`` that points at *home* and tracks calls.

    We need this because the production code stores clones under
    ``Path.home() / ".opentrace" / "repos" / org / name`` and the tests
    must not touch the developer's real ``~``.
    """

    def __init__(self, home: Path) -> None:
        self.home = home


def _patch_home(monkeypatch, home: Path) -> None:
    """Redirect ``Path.home()`` at *home* for the test's lifetime."""
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))


def _stub_collaborators(monkeypatch):
    """Replace clone/update/index helpers with recording stubs.

    Returns a dict the test can inspect. Each stub records its
    arguments so the test can pin: which clone path was taken, what
    ref/token the clone got, what metadata flowed into the pipeline.
    """
    calls: dict[str, list] = {
        "do_clone": [],
        "update": [],
        "pipeline": [],
    }

    def fake_do_clone(repo_url, clone_dir, ref, token):
        calls["do_clone"].append({"repo_url": repo_url, "clone_dir": clone_dir, "ref": ref, "token": token})
        return clone_dir

    def fake_update(clone_dir, ref):
        calls["update"].append({"clone_dir": clone_dir, "ref": ref})

    def fake_pipeline(**kwargs):
        calls["pipeline"].append(kwargs)
        return 0.5

    monkeypatch.setattr("opentrace_agent.cli.main._do_clone", fake_do_clone)
    monkeypatch.setattr("opentrace_agent.cli.main._update_existing_clone", fake_update)
    monkeypatch.setattr("opentrace_agent.cli.main._run_indexing_pipeline", fake_pipeline)
    monkeypatch.setattr(
        "opentrace_agent.cli.main._resolve_db",
        lambda db_path=None, **_: db_path or "/tmp/fake.db",
    )
    return calls


def _run(args: list[str], env: dict[str, str] | None = None):
    """Invoke the CLI under test, returning the click result."""
    return CliRunner().invoke(app, ["fetch-and-index", *args], env=env or {})


class TestUrlParsing:
    """Repo-id and org inference from a URL."""

    def test_https_owner_repo(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        result = _run(["https://github.com/owner/repo"])
        assert result.exit_code == 0, result.output

        clone_dir = calls["do_clone"][0]["clone_dir"]
        # Derived: org=owner, name=repo.
        assert clone_dir == tmp_path / ".opentrace" / "repos" / "owner" / "repo"

    def test_dot_git_suffix_stripped(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        result = _run(["https://github.com/owner/repo.git"])
        assert result.exit_code == 0, result.output
        assert calls["do_clone"][0]["clone_dir"].name == "repo"

    def test_trailing_slash_does_not_break_inference(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        result = _run(["https://github.com/owner/repo/"])
        assert result.exit_code == 0, result.output
        # Trailing slash stripped before split, so name is still 'repo'.
        assert calls["do_clone"][0]["clone_dir"].name == "repo"

    def test_single_segment_url_falls_back_to_unknown_org(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        # No prior path segment → org defaults to 'unknown' rather than
        # crashing or silently using the URL host.
        result = _run(["bare-name"])
        assert result.exit_code == 0, result.output
        clone_dir = calls["do_clone"][0]["clone_dir"]
        assert clone_dir == tmp_path / ".opentrace" / "repos" / "unknown" / "bare-name"

    def test_repo_id_override_takes_precedence_over_inferred(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        result = _run(["https://github.com/owner/repo.git", "--repo-id", "custom-id"])
        assert result.exit_code == 0, result.output
        # The clone directory still uses the *inferred* name (so two
        # `fetch-and-index` calls with different --repo-id but the same
        # URL share the same clone), but the pipeline gets the override.
        assert calls["do_clone"][0]["clone_dir"].name == "repo"
        assert calls["pipeline"][0]["repo_id"] == "custom-id"


class TestExistingDirBranches:
    """Three filesystem states for the target clone directory."""

    def test_missing_dir_calls_do_clone(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        result = _run(["https://github.com/owner/repo"])
        assert result.exit_code == 0, result.output

        # Fresh clone — _do_clone runs, _update_existing_clone does not.
        assert len(calls["do_clone"]) == 1
        assert len(calls["update"]) == 0

    def test_existing_dot_git_dir_calls_update_only(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        # Pre-create a clone with a .git directory so the existing-clone
        # branch fires.
        clone_dir = tmp_path / ".opentrace" / "repos" / "owner" / "repo"
        (clone_dir / ".git").mkdir(parents=True)

        calls = _stub_collaborators(monkeypatch)

        result = _run(["https://github.com/owner/repo", "--ref", "release-1"])
        assert result.exit_code == 0, result.output

        # Only the update path runs; _do_clone is skipped.
        assert len(calls["do_clone"]) == 0
        assert len(calls["update"]) == 1
        assert calls["update"][0]["clone_dir"] == clone_dir
        # The user-supplied --ref is forwarded so re-fetch matches the
        # fresh-clone path's branch selection.
        assert calls["update"][0]["ref"] == "release-1"

    def test_dir_without_dot_git_is_replaced(self, tmp_path, monkeypatch) -> None:
        """Recovery branch: dir exists but isn't a git repo → rmtree, re-clone."""
        _patch_home(monkeypatch, tmp_path)

        clone_dir = tmp_path / ".opentrace" / "repos" / "owner" / "repo"
        clone_dir.mkdir(parents=True)
        # Stash a marker file so we can verify the dir really got
        # replaced rather than reused.
        marker = clone_dir / "marker.txt"
        marker.write_text("stale")

        calls = _stub_collaborators(monkeypatch)

        result = _run(["https://github.com/owner/repo"])
        assert result.exit_code == 0, result.output

        assert len(calls["do_clone"]) == 1
        assert len(calls["update"]) == 0
        # rmtree happened before _do_clone re-created the directory; the
        # stale marker should be gone.
        assert not marker.exists()

    def test_recovery_rmtree_only_targets_the_clone_dir(self, tmp_path, monkeypatch) -> None:
        """Defense: the rmtree must only touch the clone dir, never any
        sibling under ~/.opentrace/repos/<org>/."""
        _patch_home(monkeypatch, tmp_path)

        org_dir = tmp_path / ".opentrace" / "repos" / "owner"
        target = org_dir / "repo"
        sibling = org_dir / "other-repo"
        target.mkdir(parents=True)
        sibling.mkdir(parents=True)
        (sibling / "should_survive").write_text("intact")

        _stub_collaborators(monkeypatch)
        result = _run(["https://github.com/owner/repo"])
        assert result.exit_code == 0, result.output

        # The sibling clone (and its contents) must be left alone.
        assert sibling.exists()
        assert (sibling / "should_survive").read_text() == "intact"


class TestTokenPrecedence:
    """Token resolution: explicit flag > envvar > GITHUB_TOKEN > GITLAB_TOKEN."""

    def test_token_flag_wins(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        result = _run(
            ["https://github.com/owner/repo", "--token", "explicit"],
            env={"GITHUB_TOKEN": "from-env", "OPENTRACE_GIT_TOKEN": "from-ot-env"},
        )
        assert result.exit_code == 0, result.output
        assert calls["do_clone"][0]["token"] == "explicit"

    def test_opentrace_envvar_used_when_flag_missing(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        result = _run(
            ["https://github.com/owner/repo"],
            env={"OPENTRACE_GIT_TOKEN": "from-ot-env"},
        )
        assert result.exit_code == 0, result.output
        # click's `envvar=...` consumes OPENTRACE_GIT_TOKEN before the
        # GITHUB_TOKEN/GITLAB_TOKEN fallback runs, so this is the next
        # rung after the explicit flag.
        assert calls["do_clone"][0]["token"] == "from-ot-env"

    def test_github_token_fallback(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        result = _run(
            ["https://github.com/owner/repo"],
            env={"GITHUB_TOKEN": "from-github"},
        )
        assert result.exit_code == 0, result.output
        assert calls["do_clone"][0]["token"] == "from-github"

    def test_github_token_beats_gitlab_token(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        result = _run(
            ["https://github.com/owner/repo"],
            env={"GITHUB_TOKEN": "gh", "GITLAB_TOKEN": "gl"},
        )
        assert result.exit_code == 0, result.output
        # GITHUB_TOKEN is checked first in the fallback chain.
        assert calls["do_clone"][0]["token"] == "gh"

    def test_gitlab_token_when_github_token_absent(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        result = _run(
            ["https://gitlab.com/owner/repo"],
            env={"GITLAB_TOKEN": "gl"},
        )
        assert result.exit_code == 0, result.output
        assert calls["do_clone"][0]["token"] == "gl"


class TestPipelineHandoff:
    """The handoff from clone result to ``_run_indexing_pipeline``."""

    def test_source_uri_extra_metadata_carries_user_supplied_url(self, tmp_path, monkeypatch) -> None:
        """The pipeline gets the *user-supplied* URL as sourceUri, not
        whatever ``_collect_metadata`` would pull from the clone's
        origin (which may carry the token)."""
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        result = _run(["https://github.com/owner/repo.git"])
        assert result.exit_code == 0, result.output

        pipeline_kwargs = calls["pipeline"][0]
        assert pipeline_kwargs["extra_metadata"] == {"sourceUri": "https://github.com/owner/repo.git"}
        assert pipeline_kwargs["repo_id"] == "repo"
        assert pipeline_kwargs["source_path"] == calls["do_clone"][0]["clone_dir"]

    def test_db_flag_is_forwarded_to_pipeline(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        custom_db = str(tmp_path / "custom" / "out.db")
        result = _run(["https://github.com/owner/repo", "--db", custom_db])
        assert result.exit_code == 0, result.output
        assert calls["pipeline"][0]["db_path"] == custom_db

    def test_batch_size_and_verbose_forwarded(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        result = _run(
            [
                "https://github.com/owner/repo",
                "--batch-size",
                "50",
                "--verbose",
            ]
        )
        assert result.exit_code == 0, result.output
        assert calls["pipeline"][0]["batch_size"] == 50
        assert calls["pipeline"][0]["verbose"] is True

    def test_ref_is_forwarded_to_fresh_clone(self, tmp_path, monkeypatch) -> None:
        _patch_home(monkeypatch, tmp_path)
        calls = _stub_collaborators(monkeypatch)

        result = _run(["https://github.com/owner/repo", "--ref", "v1.2.3"])
        assert result.exit_code == 0, result.output
        assert calls["do_clone"][0]["ref"] == "v1.2.3"
