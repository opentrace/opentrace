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

"""Tests for the config command and config helpers."""

from __future__ import annotations

from pathlib import Path

import yaml
from click.testing import CliRunner

from opentrace_agent.cli.config import load_config, save_config
from opentrace_agent.cli.main import app


# ---------------------------------------------------------------------------
# Unit tests for load_config / save_config
# ---------------------------------------------------------------------------


def test_load_config_missing_file(tmp_path: Path) -> None:
    assert load_config(tmp_path / "nope.yaml") == {}


def test_load_config_empty_file(tmp_path: Path) -> None:
    p = tmp_path / "config.yaml"
    p.write_text("")
    assert load_config(p) == {}


def test_save_and_load_roundtrip(tmp_path: Path) -> None:
    p = tmp_path / "config.yaml"
    save_config(p, {"org": "acme_corp"})
    assert load_config(p) == {"org": "acme_corp"}


def test_save_creates_parent_dirs(tmp_path: Path) -> None:
    p = tmp_path / "deep" / "nested" / "config.yaml"
    save_config(p, {"org": "org_123"})
    assert p.exists()
    assert load_config(p) == {"org": "org_123"}


# ---------------------------------------------------------------------------
# CLI integration tests
# ---------------------------------------------------------------------------

runner = CliRunner()


def test_config_set_creates_file(tmp_path: Path, monkeypatch: object) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["config", "set", "org", "acme_corp"])
    assert result.exit_code == 0
    assert "org: acme_corp" in result.output

    cfg = tmp_path / ".opentrace" / "config.yaml"
    assert cfg.exists()
    assert yaml.safe_load(cfg.read_text())["org"] == "acme_corp"


def test_config_get_returns_value(tmp_path: Path, monkeypatch: object) -> None:
    monkeypatch.chdir(tmp_path)
    runner.invoke(app, ["config", "set", "org", "org_abc123"])
    result = runner.invoke(app, ["config", "get", "org"])
    assert result.exit_code == 0
    assert result.output.strip() == "org_abc123"


def test_config_get_missing_key(tmp_path: Path, monkeypatch: object) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["config", "get", "org"])
    assert result.exit_code != 0
    assert "not set" in result.output


def test_config_show_empty(tmp_path: Path, monkeypatch: object) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["config", "show"])
    assert result.exit_code == 0
    assert "No configuration set" in result.output


def test_config_show_with_values(tmp_path: Path, monkeypatch: object) -> None:
    monkeypatch.chdir(tmp_path)
    runner.invoke(app, ["config", "set", "org", "acme_corp"])
    result = runner.invoke(app, ["config", "show"])
    assert result.exit_code == 0
    assert "org: acme_corp" in result.output


def test_config_set_overwrites(tmp_path: Path, monkeypatch: object) -> None:
    monkeypatch.chdir(tmp_path)
    runner.invoke(app, ["config", "set", "org", "old_org"])
    runner.invoke(app, ["config", "set", "org", "new_org"])
    result = runner.invoke(app, ["config", "get", "org"])
    assert result.output.strip() == "new_org"


def test_config_set_uses_existing_opentrace_dir(tmp_path: Path, monkeypatch: object) -> None:
    """If .opentrace/ already exists (e.g. from indexing), config writes there."""
    ot_dir = tmp_path / ".opentrace"
    ot_dir.mkdir()
    (ot_dir / "index.db").touch()

    monkeypatch.chdir(tmp_path)
    runner.invoke(app, ["config", "set", "org", "acme_corp"])

    cfg = ot_dir / "config.yaml"
    assert cfg.exists()
    assert yaml.safe_load(cfg.read_text())["org"] == "acme_corp"


def test_config_path(tmp_path: Path, monkeypatch: object) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["config", "path"])
    assert result.exit_code == 0
    assert ".opentrace" in result.output
    assert "config.yaml" in result.output


def test_config_set_creates_gitignore(tmp_path: Path, monkeypatch: object) -> None:
    monkeypatch.chdir(tmp_path)
    runner.invoke(app, ["config", "set", "org", "acme_corp"])
    gi = tmp_path / ".opentrace" / ".gitignore"
    assert gi.exists()


def test_config_set_invalid_key(tmp_path: Path, monkeypatch: object) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["config", "set", "bad_key", "val"])
    assert result.exit_code != 0
