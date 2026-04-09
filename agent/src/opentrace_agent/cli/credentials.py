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

"""Cross-platform secure credential storage in ~/.opentrace/.

Sensitive files (tokens) are encrypted at rest using Fernet (AES-128-CBC +
HMAC-SHA256) with a key derived from the machine's unique hardware ID plus a
random salt.  This means credentials cannot be decrypted if copied to another
machine.

Permissions:
  - Linux / macOS: directory 0700, files 0600 (POSIX chmod)
  - Windows: directory and files restricted to current user via icacls
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import json
import logging
import os
import platform
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

log = logging.getLogger(__name__)

_OPENTRACE_DIR = ".opentrace"

# ---------------------------------------------------------------------------
# Directory & permission helpers
# ---------------------------------------------------------------------------


def _base_dir() -> Path:
    """Return ``~/.opentrace/``, creating it with restricted permissions if needed."""
    d = Path.home() / _OPENTRACE_DIR
    if not d.exists():
        d.mkdir(parents=True, exist_ok=True)
        _secure_path(d)
    return d


def _secure_path(path: Path) -> None:
    """Apply owner-only permissions to *path* (file or directory)."""
    if sys.platform == "win32":
        _secure_path_windows(path)
    else:
        _secure_path_posix(path)


def _secure_path_posix(path: Path) -> None:
    """chmod 0700 for directories, 0600 for files."""
    mode = 0o700 if path.is_dir() else 0o600
    path.chmod(mode)


def _secure_path_windows(path: Path) -> None:
    """Restrict access to the current user via icacls."""
    target = str(path)
    username = _windows_username()
    try:
        subprocess.run(["icacls", target, "/inheritance:r"], check=True, capture_output=True)
        subprocess.run(["icacls", target, "/grant:r", f"{username}:(F)"], check=True, capture_output=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        log.warning("Could not set secure permissions on %s", target)


def _windows_username() -> str:
    """Return DOMAIN\\user or just user for icacls."""
    if sys.platform != "win32":
        return ""
    return os.environ.get("USERNAME", platform.node())


# ---------------------------------------------------------------------------
# Machine-bound encryption key
# ---------------------------------------------------------------------------


def _get_machine_id() -> str:
    """Return a stable, machine-specific identifier.

    - Linux:   /etc/machine-id  (systemd)
    - macOS:   IOPlatformUUID via ioreg
    - Windows: MachineGuid from the registry
    - Fallback: hostname + username (weaker, but works everywhere)
    """
    # Linux
    machine_id_path = Path("/etc/machine-id")
    if machine_id_path.exists():
        mid = machine_id_path.read_text().strip()
        if mid:
            return mid

    # macOS
    if sys.platform == "darwin":
        try:
            out = subprocess.run(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    return line.split('"')[-2]
        except (subprocess.CalledProcessError, FileNotFoundError, IndexError):
            pass

    # Windows
    if sys.platform == "win32":
        try:
            import winreg

            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography")
            val, _ = winreg.QueryValueEx(key, "MachineGuid")
            winreg.CloseKey(key)
            if val:
                return str(val)
        except OSError:
            pass

    # Fallback
    return f"{platform.node()}:{getpass.getuser()}"


def _salt_path() -> Path:
    return _base_dir() / ".salt"


def _get_or_create_salt() -> bytes:
    """Return a 16-byte salt, creating it on first use."""
    path = _salt_path()
    if path.exists():
        return path.read_bytes()
    salt = os.urandom(16)
    path.write_bytes(salt)
    _secure_path(path)
    return salt


def _derive_key() -> bytes:
    """Derive a Fernet key from the machine ID and a stored salt."""
    machine_id = _get_machine_id().encode()
    salt = _get_or_create_salt()
    # PBKDF2-HMAC-SHA256, 480_000 iterations (OWASP 2024 recommendation)
    raw = hashlib.pbkdf2_hmac("sha256", machine_id, salt, iterations=480_000)
    return base64.urlsafe_b64encode(raw)


def _get_fernet() -> Fernet:
    return Fernet(_derive_key())


# ---------------------------------------------------------------------------
# Encrypted read / write helpers
# ---------------------------------------------------------------------------


def _write_encrypted(path: Path, data: dict[str, Any]) -> None:
    """Encrypt *data* as JSON and write to *path* with secure permissions."""
    plaintext = json.dumps(data).encode("utf-8")
    ciphertext = _get_fernet().encrypt(plaintext)
    path.write_bytes(ciphertext)
    _secure_path(path)


def _read_encrypted(path: Path) -> dict[str, Any] | None:
    """Read and decrypt a Fernet-encrypted JSON file, returning *None* on failure."""
    if not path.exists():
        return None
    try:
        ciphertext = path.read_bytes()
        plaintext = _get_fernet().decrypt(ciphertext)
        data = json.loads(plaintext)
        if isinstance(data, dict):
            return data
    except (InvalidToken, json.JSONDecodeError, OSError) as exc:
        log.debug("Could not decrypt %s: %s", path, exc)
    return None


def _write_secure(path: Path, data: dict[str, Any]) -> None:
    """Write JSON to *path* and lock down permissions (unencrypted)."""
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    _secure_path(path)


def _read_json(path: Path) -> dict[str, Any] | None:
    """Read and parse a plain JSON file, returning *None* on any failure."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return None


# ---------------------------------------------------------------------------
# Token credentials  (auth.json) — encrypted
# ---------------------------------------------------------------------------


def load_tokens() -> dict[str, Any] | None:
    """Load saved OAuth tokens, or *None* if not logged in."""
    data = _read_encrypted(_base_dir() / "auth.json")
    if data and "access_token" in data:
        return data
    return None


def save_tokens(tokens: dict[str, Any]) -> None:
    """Persist OAuth tokens with encryption."""
    _write_encrypted(_base_dir() / "auth.json", tokens)


def clear_tokens() -> bool:
    """Remove saved tokens.  Returns True if credentials were deleted."""
    path = _base_dir() / "auth.json"
    if path.exists():
        path.unlink()
        return True
    return False


# ---------------------------------------------------------------------------
# Per-org tokens  (org_tokens/{org_id}.json) — encrypted
# ---------------------------------------------------------------------------


def _org_tokens_dir() -> Path:
    """Return ``~/.opentrace/org_tokens/``, creating with secure permissions if needed."""
    d = _base_dir() / "org_tokens"
    if not d.exists():
        d.mkdir(parents=True, exist_ok=True)
        _secure_path(d)
    return d


def load_org_token(org_id: str) -> dict[str, Any] | None:
    """Load a cached org-scoped access token, or ``None`` if missing/expired."""
    path = _org_tokens_dir() / f"{org_id}.json"
    data = _read_encrypted(path)
    if data and "access_token" in data:
        expires_at = data.get("expires_at")
        if expires_at and time.time() > expires_at:
            path.unlink(missing_ok=True)
            return None
        return data
    return None


def save_org_token(org_id: str, tokens: dict[str, Any]) -> None:
    """Persist an org-scoped access token (encrypted)."""
    _write_encrypted(_org_tokens_dir() / f"{org_id}.json", tokens)


def clear_org_tokens() -> int:
    """Remove all cached org tokens. Returns count removed."""
    d = _org_tokens_dir()
    if not d.exists():
        return 0
    count = 0
    for f in d.glob("*.json"):
        f.unlink()
        count += 1
    return count


# ---------------------------------------------------------------------------
# Client registration  (client.json) — plain JSON (not secret)
# ---------------------------------------------------------------------------


def load_client() -> dict[str, Any] | None:
    """Load a previously registered OAuth client."""
    data = _read_json(_base_dir() / "client.json")
    if data and "client_id" in data:
        return data
    return None


def save_client(client: dict[str, Any]) -> None:
    """Persist dynamic client registration (unencrypted — not secret)."""
    _write_secure(_base_dir() / "client.json", client)


def clear_client() -> bool:
    """Remove saved client registration."""
    path = _base_dir() / "client.json"
    if path.exists():
        path.unlink()
        return True
    return False
