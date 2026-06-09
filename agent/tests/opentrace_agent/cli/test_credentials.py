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

"""Tests for per-org token storage in credentials.py."""

from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import patch

from opentrace_agent.cli import credentials
from opentrace_agent.cli.credentials import (
    clear_org_tokens,
    load_org_token,
    save_org_token,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _patch_base_dir(monkeypatch: object, tmp_path: Path) -> Path:
    """Redirect credentials storage to a test-local directory."""
    base = tmp_path / ".opentrace"
    base.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(credentials, "_base_dir", lambda: base)
    return base


# ---------------------------------------------------------------------------
# Unit tests — org token storage
# ---------------------------------------------------------------------------


def test_save_and_load_org_token_roundtrip(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    token_data = {"access_token": "otoat_roundtrip", "expires_at": int(time.time()) + 3600}
    save_org_token("org_abc", token_data)
    loaded = load_org_token("org_abc")
    assert loaded is not None
    assert loaded["access_token"] == "otoat_roundtrip"


def test_load_org_token_missing(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    assert load_org_token("org_nonexistent") is None


def test_load_org_token_expired(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    save_org_token("org_exp", {"access_token": "otoat_expired", "expires_at": 1000})
    with patch.object(credentials.time, "time", return_value=2000):
        assert load_org_token("org_exp") is None


def test_load_org_token_expired_deletes_file(tmp_path: Path, monkeypatch: object) -> None:
    base = _patch_base_dir(monkeypatch, tmp_path)
    save_org_token("org_exp", {"access_token": "otoat_expired", "expires_at": 1000})
    token_file = base / "org_tokens" / "org_exp.json"
    assert token_file.exists()
    with patch.object(credentials.time, "time", return_value=2000):
        load_org_token("org_exp")
    assert not token_file.exists()


def test_clear_org_tokens_removes_all(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    for i in range(3):
        save_org_token(f"org_{i}", {"access_token": f"otoat_{i}", "expires_at": int(time.time()) + 3600})
    assert clear_org_tokens() == 3
    assert load_org_token("org_0") is None


def test_clear_org_tokens_empty(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    assert clear_org_tokens() == 0


# ---------------------------------------------------------------------------
# Unit tests — git PAT storage
# ---------------------------------------------------------------------------


def test_save_and_load_git_token_roundtrip(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    credentials.save_git_token("github.com", "ghp_secret")
    assert credentials.load_git_token("github.com") == "ghp_secret"


def test_load_git_token_missing(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    assert credentials.load_git_token("github.com") is None


def test_git_token_host_normalized(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    credentials.save_git_token("GitHub.com", "ghp_secret")
    # Lookups are case-insensitive and ignore a leading www.
    assert credentials.load_git_token("github.com") == "ghp_secret"
    assert credentials.load_git_token("www.github.com") == "ghp_secret"


def test_git_tokens_multi_host_isolated(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    credentials.save_git_token("github.com", "gh")
    credentials.save_git_token("gitlab.com", "gl")
    assert credentials.load_git_token("github.com") == "gh"
    assert credentials.load_git_token("gitlab.com") == "gl"
    # A host we never stored returns None even when others exist.
    assert credentials.load_git_token("bitbucket.org") is None


def test_save_git_token_ignores_empty(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    credentials.save_git_token("", "tok")
    credentials.save_git_token("github.com", "")
    assert credentials.list_git_token_hosts() == []


def test_list_git_token_hosts_sorted(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    credentials.save_git_token("gitlab.com", "gl")
    credentials.save_git_token("github.com", "gh")
    assert credentials.list_git_token_hosts() == ["github.com", "gitlab.com"]


def test_clear_git_tokens(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    credentials.save_git_token("github.com", "gh")
    credentials.save_git_token("gitlab.com", "gl")
    assert credentials.clear_git_tokens() == 2
    assert credentials.load_git_token("github.com") is None
    assert credentials.clear_git_tokens() == 0


def test_git_tokens_encrypted_at_rest(tmp_path: Path, monkeypatch: object) -> None:
    base = _patch_base_dir(monkeypatch, tmp_path)
    credentials.save_git_token("github.com", "ghp_plaintext_marker")
    blob = (base / "git_tokens.json").read_bytes()
    # The raw file must not contain the plaintext token.
    assert b"ghp_plaintext_marker" not in blob
