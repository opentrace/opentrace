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

"""OAuth 2.0 + PKCE authentication with RFC 8414 discovery & RFC 7591 dynamic registration.

Discovery uses ``/.well-known/oauth-authorization-server`` (RFC 8414), not OIDC.
Credentials are stored in ``~/.opentrace/`` via the ``credentials`` module, with
OS-appropriate secure permissions (POSIX 0600 or Windows icacls).
"""

from __future__ import annotations

import base64
import hashlib
import html as html_mod
import json
import secrets
import socketserver
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

from opentrace_agent.cli.credentials import (
    clear_tokens,
    load_client,
    load_tokens,
    save_client,
    save_tokens,
)

# Re-export for convenience — callers can ``from opentrace_agent.cli.auth import load_tokens``.
__all__ = ["clear_tokens", "discover", "load_tokens", "login", "refresh", "save_tokens"]

ISSUER = "https://api.opentrace.ai"
DISCOVERY_PATH = "/.well-known/oauth-authorization-server"
SCOPES = "read write"

CLIENT_NAME = "OpenTrace CLI"

CALLBACK_HOST = "127.0.0.1"
CALLBACK_PORT_RANGE = range(9876, 9886)

# ---------------------------------------------------------------------------
# OAuth 2.0 Authorization Server Metadata  (RFC 8414)
# ---------------------------------------------------------------------------

_discovery_cache: dict[str, Any] | None = None


def discover(issuer: str = ISSUER) -> dict[str, Any]:
    """Fetch the OAuth 2.0 Authorization Server Metadata (RFC 8414), caching for the session."""
    global _discovery_cache  # noqa: PLW0603
    if _discovery_cache is not None:
        return _discovery_cache

    url = issuer.rstrip("/") + DISCOVERY_PATH
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content_type = resp.headers.get("Content-Type", "")
            body = resp.read()
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach OAuth metadata endpoint at {url}: {exc}") from exc

    if "json" not in content_type:
        raise RuntimeError(
            f"OAuth metadata endpoint at {url} returned {content_type or 'unknown content type'} "
            f"instead of JSON. Is the OAuth provider configured at {issuer}?"
        )

    try:
        doc = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"OAuth metadata endpoint at {url} returned invalid JSON: {exc}") from exc

    for key in ("authorization_endpoint", "token_endpoint"):
        if key not in doc:
            raise RuntimeError(f"OAuth metadata missing required field: {key}")

    _discovery_cache = doc
    return doc


# ---------------------------------------------------------------------------
# Dynamic Client Registration  (RFC 7591)
# ---------------------------------------------------------------------------


def _register_client(registration_endpoint: str, redirect_uris: list[str]) -> dict[str, Any]:
    """Dynamically register a new OAuth client."""
    body = json.dumps(
        {
            "client_name": CLIENT_NAME,
            "redirect_uris": redirect_uris,
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
            "scope": SCOPES,
            "token_endpoint_auth_method": "none",
        }
    ).encode()

    req = urllib.request.Request(
        registration_endpoint,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        client = json.loads(resp.read())

    if "client_id" not in client:
        raise RuntimeError("Dynamic registration response missing client_id")

    save_client(client)
    return client


def _ensure_client(disco: dict[str, Any], redirect_uris: list[str]) -> dict[str, Any]:
    """Return a registered client, creating one via dynamic registration if needed."""
    existing = load_client()
    if existing is not None:
        return existing

    reg_endpoint = disco.get("registration_endpoint")
    if not reg_endpoint:
        raise RuntimeError(
            "Authorization server does not support dynamic client registration "
            "(no registration_endpoint in discovery document). "
            "Register a client manually and save to ~/.opentrace/client.json"
        )

    return _register_client(reg_endpoint, redirect_uris)


# ---------------------------------------------------------------------------
# PKCE helpers
# ---------------------------------------------------------------------------


def _generate_pkce() -> tuple[str, str]:
    """Return (code_verifier, code_challenge) for S256 PKCE."""
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


# ---------------------------------------------------------------------------
# OAuth callback server
# ---------------------------------------------------------------------------

_SUCCESS_HTML = """\
<!DOCTYPE html>
<html>
<head><title>OpenTrace CLI</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center;
             height: 100vh; margin: 0; background: #f8f9fa;">
  <div style="text-align: center;">
    <h1 style="color: #2d8a4e;">&#10003; Logged in</h1>
    <p>You can close this tab and return to the terminal.</p>
  </div>
</body>
</html>
"""

_ERROR_HTML = """\
<!DOCTYPE html>
<html>
<head><title>OpenTrace CLI</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center;
             height: 100vh; margin: 0; background: #f8f9fa;">
  <div style="text-align: center;">
    <h1 style="color: #d32f2f;">Login failed</h1>
    <p>{error}</p>
  </div>
</body>
</html>
"""


class _OAuthResult:
    """Thread-safe container for the OAuth callback result."""

    def __init__(self) -> None:
        self.code: str | None = None
        self.error: str | None = None
        self.ready = threading.Event()

    def set_code(self, code: str) -> None:
        self.code = code
        self.ready.set()

    def set_error(self, error: str) -> None:
        self.error = error
        self.ready.set()


def _make_handler(result: _OAuthResult, expected_state: str) -> type[BaseHTTPRequestHandler]:
    """Create a request handler class bound to a specific result instance."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)

            # Ignore non-callback requests (e.g. /favicon.ico).
            if parsed.path != "/callback":
                self.send_response(404)
                self.end_headers()
                return

            # Already resolved — ignore duplicate requests.
            if result.ready.is_set():
                self._respond(200, _SUCCESS_HTML)
                return

            qs = parse_qs(parsed.query)

            # Validate state to prevent CSRF.
            received_state = qs.get("state", [None])[0]
            if received_state != expected_state:
                result.set_error("Invalid state parameter — possible CSRF attack")
                self._respond(400, _ERROR_HTML.format(error="Invalid state parameter"))
                return

            error = qs.get("error", [None])[0]
            if error:
                desc = qs.get("error_description", [error])[0]
                result.set_error(desc)
                self._respond(400, _ERROR_HTML.format(error=html_mod.escape(desc)))
                return

            code = qs.get("code", [None])[0]
            if code:
                result.set_code(code)
                self._respond(200, _SUCCESS_HTML)
                return

            result.set_error(f"No authorization code in callback (received: {self.path})")
            self._respond(400, _ERROR_HTML.format(error="Missing code parameter"))

        def _respond(self, status: int, html: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html.encode())

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            pass

    return Handler


class _ThreadedHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    """HTTP server that handles each request in a new thread."""

    daemon_threads = True


def _find_open_port() -> int:
    """Find an available port in the callback range."""
    import socket

    for port in CALLBACK_PORT_RANGE:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((CALLBACK_HOST, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No available port in range {CALLBACK_PORT_RANGE.start}-{CALLBACK_PORT_RANGE.stop - 1}")


# ---------------------------------------------------------------------------
# Token exchange
# ---------------------------------------------------------------------------


def _exchange_code(
    token_endpoint: str,
    client_id: str,
    code: str,
    verifier: str,
    redirect_uri: str,
) -> dict[str, Any]:
    """Exchange an authorization code for tokens."""
    payload = urlencode(
        {
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": verifier,
        }
    ).encode()

    req = urllib.request.Request(
        token_endpoint,
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _refresh_token(token_endpoint: str, client_id: str, refresh_token: str) -> dict[str, Any]:
    """Exchange a refresh token for a new access token."""
    payload = urlencode(
        {
            "grant_type": "refresh_token",
            "client_id": client_id,
            "refresh_token": refresh_token,
        }
    ).encode()

    req = urllib.request.Request(
        token_endpoint,
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def refresh() -> dict[str, Any]:
    """Refresh the access token using the stored refresh token.

    Returns the updated auth payload.
    Raises RuntimeError if not logged in or no refresh token is available.
    """
    tokens = load_tokens()
    if not tokens:
        raise RuntimeError("Not logged in. Run 'opentraceai login' first.")

    rt = tokens.get("refresh_token")
    if not rt:
        raise RuntimeError("No refresh token available. Run 'opentraceai login' to re-authenticate.")

    disco = discover()
    client = load_client()
    if not client:
        raise RuntimeError("No registered client found. Run 'opentraceai login' first.")

    new_tokens = _refresh_token(disco["token_endpoint"], client["client_id"], rt)

    payload: dict[str, Any] = {
        **tokens,  # preserve issuer, created_at, etc.
        **new_tokens,  # overwrite access_token, expires_in, etc.
        "refreshed_at": int(time.time()),
    }
    # Keep the old refresh_token if the server didn't issue a new one.
    if "refresh_token" not in new_tokens:
        payload["refresh_token"] = rt

    save_tokens(payload)
    return payload


def login() -> dict[str, Any]:
    """Run the full OAuth 2.0 + PKCE browser login flow.

    1. Fetch authorization server metadata (RFC 8414).
    2. Ensure a client is registered (RFC 7591 dynamic registration or cached).
    3. Start a local HTTP server for the callback.
    4. Open the browser to the authorization endpoint.
    5. Wait for the redirect with the authorization code.
    6. Exchange the code for tokens and persist to disk.

    Returns the saved auth payload.
    """
    disco = discover()

    port = _find_open_port()
    redirect_uris = [f"http://{CALLBACK_HOST}:{p}/callback" for p in CALLBACK_PORT_RANGE]
    redirect_uri = f"http://{CALLBACK_HOST}:{port}/callback"

    client = _ensure_client(disco, redirect_uris)
    client_id = client["client_id"]

    verifier, challenge = _generate_pkce()
    state = secrets.token_urlsafe(32)

    params = urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": SCOPES,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    authorize_url = f"{disco['authorization_endpoint']}?{params}"

    result = _OAuthResult()
    handler_cls = _make_handler(result, state)

    server = _ThreadedHTTPServer((CALLBACK_HOST, port), handler_cls)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    try:
        webbrowser.open(authorize_url)

        # Wait for the callback (up to 5 minutes).
        if not result.ready.wait(timeout=300):
            raise TimeoutError("Timed out waiting for browser login (5 min)")

        if result.error:
            raise RuntimeError(result.error)

        code = result.code
        assert code is not None  # noqa: S101

        tokens = _exchange_code(disco["token_endpoint"], client_id, code, verifier, redirect_uri)

        payload: dict[str, Any] = {
            **tokens,
            "issuer": disco.get("issuer", ISSUER),
            "created_at": int(time.time()),
        }
        save_tokens(payload)
        return payload
    finally:
        server.shutdown()
        server.server_close()
