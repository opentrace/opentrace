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

"""Tests for `opentraceai install claude`."""

from __future__ import annotations

import pytest
from click.testing import CliRunner

from opentrace_agent.cli import install as install_mod
from opentrace_agent.cli.main import app


@pytest.fixture()
def runner():
    return CliRunner()


def _fake_runner(calls, *, results=None):
    """Build a `_run` replacement that records commands and returns scripted
    ``(ok, output)`` tuples (defaulting to success)."""
    results = list(results or [])

    def run(cmd, *, dry_run):
        calls.append((cmd, dry_run))
        if results:
            return results.pop(0)
        return True, ""

    return run


class TestSource:
    def test_default_source(self, monkeypatch):
        monkeypatch.delenv("OPENTRACE_MARKETPLACE_SOURCE", raising=False)
        assert install_mod._marketplace_source(None) == "opentrace/opentrace"

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("OPENTRACE_MARKETPLACE_SOURCE", "myfork/opentrace")
        assert install_mod._marketplace_source(None) == "myfork/opentrace"

    def test_flag_beats_env(self, monkeypatch):
        monkeypatch.setenv("OPENTRACE_MARKETPLACE_SOURCE", "myfork/opentrace")
        assert install_mod._marketplace_source("/local/path") == "/local/path"


class TestInstallClaude:
    def test_happy_path_runs_both_claude_commands(self, runner, monkeypatch):
        calls: list = []
        monkeypatch.setattr(install_mod.shutil, "which", lambda _: "/usr/bin/claude")
        monkeypatch.setattr(install_mod, "_run", _fake_runner(calls))

        result = runner.invoke(app, ["install", "claude"])
        assert result.exit_code == 0, result.output

        assert calls[0][0] == ["claude", "plugin", "marketplace", "add", "opentrace/opentrace"]
        assert calls[1][0] == ["claude", "plugin", "install", "opentrace-oss@opentrace-oss"]
        assert "Done" in result.output

    def test_source_override_flag(self, runner, monkeypatch):
        calls: list = []
        monkeypatch.setattr(install_mod.shutil, "which", lambda _: "/usr/bin/claude")
        monkeypatch.setattr(install_mod, "_run", _fake_runner(calls))

        result = runner.invoke(app, ["install", "claude", "--source", "myorg/fork"])
        assert result.exit_code == 0, result.output
        assert calls[0][0][-1] == "myorg/fork"

    def test_missing_claude_cli_errors(self, runner, monkeypatch):
        monkeypatch.setattr(install_mod.shutil, "which", lambda _: None)
        result = runner.invoke(app, ["install", "claude"])
        assert result.exit_code != 0
        assert "claude` CLI not found" in result.output

    def test_already_added_is_not_an_error(self, runner, monkeypatch):
        calls: list = []
        monkeypatch.setattr(install_mod.shutil, "which", lambda _: "/usr/bin/claude")
        monkeypatch.setattr(
            install_mod,
            "_run",
            _fake_runner(
                calls,
                results=[(False, "marketplace already exists"), (False, "Plugin already installed")],
            ),
        )
        result = runner.invoke(app, ["install", "claude"])
        assert result.exit_code == 0, result.output
        assert "already added" in result.output
        assert "already installed" in result.output

    def test_marketplace_add_failure_aborts(self, runner, monkeypatch):
        calls: list = []
        monkeypatch.setattr(install_mod.shutil, "which", lambda _: "/usr/bin/claude")
        monkeypatch.setattr(install_mod, "_run", _fake_runner(calls, results=[(False, "network unreachable")]))
        result = runner.invoke(app, ["install", "claude"])
        assert result.exit_code != 0
        assert "marketplace add` failed" in result.output
        # Must not attempt the install step after the marketplace step failed.
        assert len(calls) == 1

    def test_dry_run_skips_which_and_prints_commands(self, runner, monkeypatch):
        # dry-run must not require the claude CLI to be present.
        monkeypatch.setattr(install_mod.shutil, "which", lambda _: None)
        result = runner.invoke(app, ["install", "claude", "--dry-run"])
        assert result.exit_code == 0, result.output
        assert "claude plugin marketplace add opentrace/opentrace" in result.output
        assert "claude plugin install opentrace-oss@opentrace-oss" in result.output
        assert "dry run" in result.output

    def test_unknown_target_rejected(self, runner):
        result = runner.invoke(app, ["install", "emacs"])
        assert result.exit_code != 0  # click.Choice rejects it


class TestRunHelper:
    def test_missing_binary_returns_false(self, monkeypatch):
        ok, out = install_mod._run(["definitely-not-a-real-binary-xyz"], dry_run=False)
        assert ok is False
        assert "not found" in out

    def test_dry_run_echoes_without_executing(self):
        ok, out = install_mod._run(["claude", "plugin", "list"], dry_run=True)
        assert ok is True
        assert out == ""
