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

"""Tests for auth functions and auth-related CLI commands."""

from __future__ import annotations

import json
import time
import urllib.error
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from opentrace_agent.cli import auth, credentials
from opentrace_agent.cli.config import save_config
from opentrace_agent.cli.credentials import (
    load_org_token,
    save_org_token,
    save_tokens,
)
from opentrace_agent.cli.main import app

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

runner = CliRunner()

FAKE_DISCOVERY = {
    "issuer": "https://api.opentrace.ai",
    "authorization_endpoint": "https://api.opentrace.ai/oauth/authorize",
    "token_endpoint": "https://api.opentrace.ai/oauth/token",
    "registration_endpoint": "https://api.opentrace.ai/oauth/register",
}


def _patch_base_dir(monkeypatch: object, tmp_path: Path, subdir: str = ".opentrace") -> Path:
    """Redirect credentials storage to a test-local directory."""
    base = tmp_path / subdir
    base.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(credentials, "_base_dir", lambda: base)
    return base


def _make_repo(base: Path) -> Path:
    """Create a fake git repo root so directory walk stays bounded."""
    (base / ".git").mkdir(exist_ok=True)
    return base


def _fake_urlopen_response(data: dict) -> MagicMock:
    """Return a context-manager mock that acts like urlopen(...)."""
    resp = MagicMock()
    resp.read.return_value = json.dumps(data).encode()
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


# ---------------------------------------------------------------------------
# Unit tests — resolve_org_token
# ---------------------------------------------------------------------------


def test_resolve_returns_cached(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    save_org_token("org_cached", {"access_token": "otoat_cached", "expires_at": int(time.time()) + 3600})
    result = auth.resolve_org_token("org_cached")
    assert result["access_token"] == "otoat_cached"


def test_resolve_exchanges_on_miss(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    save_tokens({"access_token": "otuat_usertoken"})
    monkeypatch.setattr(auth, "_discovery_cache", None)

    exchange_resp = {"access_token": "otoat_new", "expires_in": 3600}
    with (
        patch.object(auth, "discover", return_value=FAKE_DISCOVERY),
        patch("urllib.request.urlopen", return_value=_fake_urlopen_response(exchange_resp)) as mock_urlopen,
    ):
        result = auth.resolve_org_token("org_miss")

    assert result["access_token"] == "otoat_new"
    assert "expires_at" in result

    # Verify it was cached
    assert load_org_token("org_miss") is not None

    # Verify correct request
    req = mock_urlopen.call_args[0][0]
    assert req.full_url == "https://api.opentrace.ai/oauth/exchange-org-token"
    assert req.get_header("Authorization") == "Bearer otuat_usertoken"


def test_resolve_not_logged_in(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    with pytest.raises(RuntimeError, match="Not logged in"):
        auth.resolve_org_token("org_x")


def test_resolve_legacy_otoat(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    save_tokens({"access_token": "otoat_legacytoken"})
    monkeypatch.setattr(auth, "_discovery_cache", None)
    with pytest.raises(RuntimeError, match="legacy format"):
        auth.resolve_org_token("org_x")


def test_resolve_http_401(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    save_tokens({"access_token": "otuat_valid"})
    monkeypatch.setattr(auth, "_discovery_cache", None)

    err = urllib.error.HTTPError("url", 401, "Unauthorized", {}, BytesIO(b"unauth"))
    with (
        patch.object(auth, "discover", return_value=FAKE_DISCOVERY),
        patch("urllib.request.urlopen", side_effect=err),
    ):
        with pytest.raises(RuntimeError, match="expired or invalid"):
            auth.resolve_org_token("org_x")


def test_resolve_http_404(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    save_tokens({"access_token": "otuat_valid"})
    monkeypatch.setattr(auth, "_discovery_cache", None)

    err = urllib.error.HTTPError("url", 404, "Not Found", {}, BytesIO(b"not found"))
    with (
        patch.object(auth, "discover", return_value=FAKE_DISCOVERY),
        patch("urllib.request.urlopen", side_effect=err),
    ):
        with pytest.raises(RuntimeError, match="not found"):
            auth.resolve_org_token("org_x")


# ---------------------------------------------------------------------------
# Unit tests — get_api_token
# ---------------------------------------------------------------------------


def test_get_api_token_with_org(tmp_path: Path, monkeypatch: object) -> None:
    _make_repo(tmp_path)
    monkeypatch.chdir(tmp_path)
    _patch_base_dir(monkeypatch, tmp_path, subdir="home_opentrace")

    # Set up project config
    ot_dir = tmp_path / ".opentrace"
    ot_dir.mkdir(exist_ok=True)
    save_config(ot_dir / "config.yaml", {"org": "org_test"})

    # Save org token
    save_org_token("org_test", {"access_token": "otoat_orgtoken", "expires_at": int(time.time()) + 3600})

    assert auth.get_api_token() == "otoat_orgtoken"


def test_get_api_token_no_org(tmp_path: Path, monkeypatch: object) -> None:
    _make_repo(tmp_path)
    monkeypatch.chdir(tmp_path)
    _patch_base_dir(monkeypatch, tmp_path, subdir="home_opentrace")

    save_tokens({"access_token": "otuat_direct"})

    assert auth.get_api_token() == "otuat_direct"


def test_get_api_token_not_logged_in(tmp_path: Path, monkeypatch: object) -> None:
    _make_repo(tmp_path)
    monkeypatch.chdir(tmp_path)
    _patch_base_dir(monkeypatch, tmp_path, subdir="home_opentrace")

    with pytest.raises(RuntimeError, match="Not logged in"):
        auth.get_api_token()


# ---------------------------------------------------------------------------
# Unit test — login includes prompt=none
# ---------------------------------------------------------------------------


def test_login_includes_prompt_none(monkeypatch: object) -> None:
    monkeypatch.setattr(auth, "_discovery_cache", None)
    captured_url = {}

    def capture_url(url: str) -> None:
        captured_url["url"] = url

    # Create a fake _OAuthResult whose ready.wait() returns False immediately
    fake_result = MagicMock()
    fake_result.ready.wait.return_value = False

    with (
        patch.object(auth, "discover", return_value=FAKE_DISCOVERY),
        patch.object(auth, "_find_open_port", return_value=9876),
        patch.object(auth, "_ensure_client", return_value={"client_id": "test_client"}),
        patch.object(auth, "webbrowser") as mock_wb,
        patch.object(auth, "_ThreadedHTTPServer"),
        patch.object(auth, "_OAuthResult", return_value=fake_result),
    ):
        mock_wb.open.side_effect = capture_url

        with pytest.raises(TimeoutError):
            auth.login()

    assert "url" in captured_url
    assert "prompt=none" in captured_url["url"]


# ---------------------------------------------------------------------------
# CLI integration tests — logout
# ---------------------------------------------------------------------------


def test_logout_with_org_tokens(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    save_tokens({"access_token": "otuat_user"})
    save_org_token("org_1", {"access_token": "otoat_1", "expires_at": int(time.time()) + 3600})
    save_org_token("org_2", {"access_token": "otoat_2", "expires_at": int(time.time()) + 3600})

    result = runner.invoke(app, ["logout"])
    assert result.exit_code == 0
    assert "user credentials" in result.output
    assert "2 org token(s)" in result.output


def test_logout_not_logged_in(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    result = runner.invoke(app, ["logout"])
    assert result.exit_code == 0
    assert "Not logged in" in result.output


# ---------------------------------------------------------------------------
# CLI integration tests — whoami
# ---------------------------------------------------------------------------


def test_whoami_not_logged_in(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    result = runner.invoke(app, ["whoami"])
    assert result.exit_code == 0
    assert "Not logged in" in result.output


def test_whoami_otuat_token(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    save_tokens({"access_token": "otuat_abc", "issuer": "https://api.opentrace.ai", "scope": "read write"})

    result = runner.invoke(app, ["whoami"])
    assert result.exit_code == 0
    assert "user (otuat)" in result.output


def test_whoami_legacy_otoat(tmp_path: Path, monkeypatch: object) -> None:
    _patch_base_dir(monkeypatch, tmp_path)
    save_tokens({"access_token": "otoat_legacy123", "issuer": "https://api.opentrace.ai", "scope": "read write"})

    result = runner.invoke(app, ["whoami"])
    assert result.exit_code == 0
    assert "org-scoped (legacy)" in result.output


def test_whoami_org_cached(tmp_path: Path, monkeypatch: object) -> None:
    _make_repo(tmp_path)
    monkeypatch.chdir(tmp_path)
    _patch_base_dir(monkeypatch, tmp_path, subdir="home_opentrace")

    # Set up project config
    ot_dir = tmp_path / ".opentrace"
    ot_dir.mkdir(exist_ok=True)
    save_config(ot_dir / "config.yaml", {"org": "org_cached"})

    # Save tokens
    save_tokens({"access_token": "otuat_user", "issuer": "https://api.opentrace.ai", "scope": "read write"})
    save_org_token("org_cached", {"access_token": "otoat_org", "expires_at": int(time.time()) + 3600})

    result = runner.invoke(app, ["whoami"])
    assert result.exit_code == 0
    assert "org_cached" in result.output
    assert "(token cached)" in result.output


def test_whoami_org_not_cached_resolve_fails(tmp_path: Path, monkeypatch: object) -> None:
    _make_repo(tmp_path)
    monkeypatch.chdir(tmp_path)
    _patch_base_dir(monkeypatch, tmp_path, subdir="home_opentrace")

    # Set up project config
    ot_dir = tmp_path / ".opentrace"
    ot_dir.mkdir(exist_ok=True)
    save_config(ot_dir / "config.yaml", {"org": "org_nocache"})

    # Only user token, no org token
    save_tokens({"access_token": "otuat_user", "issuer": "https://api.opentrace.ai", "scope": "read write"})

    with patch.object(auth, "resolve_org_token", side_effect=RuntimeError("token expired")):
        result = runner.invoke(app, ["whoami"])
    assert result.exit_code == 0
    assert "org_nocache" in result.output
    assert "(exchange failed:" in result.output


def test_whoami_org_auto_resolves(tmp_path: Path, monkeypatch: object) -> None:
    _make_repo(tmp_path)
    monkeypatch.chdir(tmp_path)
    _patch_base_dir(monkeypatch, tmp_path, subdir="home_opentrace")

    ot_dir = tmp_path / ".opentrace"
    ot_dir.mkdir(exist_ok=True)
    save_config(ot_dir / "config.yaml", {"org": "org_resolved"})

    save_tokens({"access_token": "otuat_user", "issuer": "https://api.opentrace.ai", "scope": "read write"})

    with patch.object(auth, "resolve_org_token", return_value={"access_token": "otoat_new"}):
        result = runner.invoke(app, ["whoami"])
    assert result.exit_code == 0
    assert "org_resolved" in result.output
    assert "(token resolved)" in result.output


# ---------------------------------------------------------------------------
# CLI integration tests — login --resolve
# ---------------------------------------------------------------------------


def test_login_resolve_exchanges_org_token(tmp_path: Path, monkeypatch: object) -> None:
    _make_repo(tmp_path)
    monkeypatch.chdir(tmp_path)
    _patch_base_dir(monkeypatch, tmp_path, subdir="home_opentrace")

    ot_dir = tmp_path / ".opentrace"
    ot_dir.mkdir(exist_ok=True)
    save_config(ot_dir / "config.yaml", {"org": "org_test"})

    fake_payload = {"issuer": "https://api.opentrace.ai", "scope": "read write", "access_token": "otuat_new"}

    with (
        patch.object(auth, "login", return_value=fake_payload),
        patch.object(auth, "resolve_org_token", return_value={"access_token": "otoat_org"}) as mock_resolve,
    ):
        result = runner.invoke(app, ["login", "--resolve"])

    assert result.exit_code == 0
    assert "Org token resolved for 'org_test'" in result.output
    mock_resolve.assert_called_once_with("org_test")


def test_login_resolve_no_config(tmp_path: Path, monkeypatch: object) -> None:
    _make_repo(tmp_path)
    monkeypatch.chdir(tmp_path)
    _patch_base_dir(monkeypatch, tmp_path, subdir="home_opentrace")

    # No .opentrace/config.yaml

    fake_payload = {"issuer": "https://api.opentrace.ai", "scope": "read write", "access_token": "otuat_new"}

    with patch.object(auth, "login", return_value=fake_payload):
        result = runner.invoke(app, ["login", "--resolve"])

    assert result.exit_code == 0
    assert "No .opentrace/config.yaml found" in result.output


def test_login_resolve_no_org(tmp_path: Path, monkeypatch: object) -> None:
    _make_repo(tmp_path)
    monkeypatch.chdir(tmp_path)
    _patch_base_dir(monkeypatch, tmp_path, subdir="home_opentrace")

    ot_dir = tmp_path / ".opentrace"
    ot_dir.mkdir(exist_ok=True)
    save_config(ot_dir / "config.yaml", {})

    fake_payload = {"issuer": "https://api.opentrace.ai", "scope": "read write", "access_token": "otuat_new"}

    with patch.object(auth, "login", return_value=fake_payload):
        result = runner.invoke(app, ["login", "--resolve"])

    assert result.exit_code == 0
    assert "No org set in config" in result.output


def test_login_resolve_exchange_fails(tmp_path: Path, monkeypatch: object) -> None:
    _make_repo(tmp_path)
    monkeypatch.chdir(tmp_path)
    _patch_base_dir(monkeypatch, tmp_path, subdir="home_opentrace")

    ot_dir = tmp_path / ".opentrace"
    ot_dir.mkdir(exist_ok=True)
    save_config(ot_dir / "config.yaml", {"org": "org_fail"})

    fake_payload = {"issuer": "https://api.opentrace.ai", "scope": "read write", "access_token": "otuat_new"}

    with (
        patch.object(auth, "login", return_value=fake_payload),
        patch.object(auth, "resolve_org_token", side_effect=RuntimeError("token expired")),
    ):
        result = runner.invoke(app, ["login", "--resolve"])

    assert result.exit_code != 0
    assert "Org token resolution failed" in result.output
