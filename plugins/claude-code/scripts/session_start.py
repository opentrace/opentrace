#!/usr/bin/env python3
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

"""SessionStart hook: prime Claude Code with OpenTrace tool-routing
guidance.

Fires once per session. When an OpenTrace index is present, injects a
table-style routing directive plus the current graph stats. When there's
no index, kicks off a background `uvx opentraceai index .` so tools are
available shortly. Also surfaces a CLI update notice when one is
available — best-effort, never blocks.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Optional

from _common import (
    build_directive,
    emit_json,
    find_db_path,
    find_workspace_root,
    git_repo_root,
    opentrace_healthy,
    record_index_complete,
    run_opentraceai,
    start_background_index,
)
from _debug import DebugLogger

_debug = DebugLogger("session-start")


_DEPRECATION_NOTE = (
    "Note: `/explore` and `/interrogate` slash commands were removed in "
    "0.8.0 — describe what you want and Claude will route to the "
    "`opentrace-explore` / `opentrace-interrogate` skills automatically. "
    "`@opentrace` and `@code-explorer` subagents were also removed; use "
    "`@dependency-analyzer`, `@find-usages`, or `@explain-service` for "
    "multi-step delegated investigations."
)


# ---------------------------------------------------------------------------
# Update notice — version compare against PyPI
# ---------------------------------------------------------------------------

def _installed_version() -> Optional[str]:
    out = run_opentraceai(["--version"], cwd=Path.cwd(), timeout=5)
    if not out:
        return None
    # "opentraceai 0.11.0" → "0.11.0"
    parts = out.split()
    return parts[-1] if parts else None


def _latest_pypi_version() -> Optional[str]:
    try:
        with urllib.request.urlopen(
            "https://pypi.org/pypi/opentraceai/json", timeout=5
        ) as resp:
            data = json.load(resp)
        return data.get("info", {}).get("version")
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def _version_tuple(v: str) -> Optional[tuple[int, ...]]:
    """Parse a dotted version like '0.11.0' into a comparable tuple.

    Returns None for non-numeric versions (dev tags, hashes, etc.) so we
    skip the upgrade prompt rather than guessing.
    """
    parts = v.split("+")[0].split("-")[0].split(".")
    try:
        return tuple(int(p) for p in parts)
    except ValueError:
        return None


def _update_notice() -> Optional[str]:
    installed = _installed_version()
    latest = _latest_pypi_version()
    _debug(f"versions: installed={installed} latest={latest}")
    if not installed or not latest or installed == latest:
        return None
    iv, lv = _version_tuple(installed), _version_tuple(latest)
    if iv is None or lv is None or iv >= lv:
        return None
    return (
        f"Update available: opentraceai {installed} → {latest}. "
        "Run /update to upgrade."
    )


# ---------------------------------------------------------------------------
# CLI install guidance — when `opentraceai` is not on PATH
# ---------------------------------------------------------------------------

# Mirrors the wording of the opencode plugin's getCliMissingMessage so a
# user encountering both plugins gets a consistent install nudge.
_CLI_MISSING_MESSAGE = (
    "OpenTrace tools are unavailable: no working `opentraceai` CLI was found.\n"
    "\n"
    "Install with one of:\n"
    "  uv tool install opentraceai      # if uv is available\n"
    "  pipx install opentraceai         # alternative\n"
    "\n"
    "Once installed, the tools become available on the next session — no\n"
    "restart of this process required. Ask the user before running an install\n"
    "command on their behalf."
)


# Appended to the injected context when no git token is resolvable, so the
# model knows how to route a private-repo indexing request. Informational
# (goes in additionalContext, not a user-facing systemMessage) — public
# repos need no token, so this never blocks anything.
_AUTH_NUDGE = (
    "Note: no git token detected. Public repos index without one, but to "
    "index a private repository the user can run `/auth` (or `opentraceai "
    "auth git`) to store a PAT, or set GITHUB_TOKEN / GITLAB_TOKEN / "
    "OPENTRACE_GIT_TOKEN."
)


def _git_token_available() -> bool:
    """Best-effort check for a usable git PAT — env var or stored credential.

    Mirrors fetch-and-index's resolution: any of the three env vars, or the
    presence of a token file written by `opentraceai auth git`. Doesn't
    decrypt the file; presence alone means onboarding already happened.
    """
    if any(os.environ.get(v) for v in ("OPENTRACE_GIT_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN")):
        return True
    token_file = Path.home() / ".opentrace" / "git_tokens.json"
    try:
        return token_file.is_file() and token_file.stat().st_size > 0
    except OSError:
        return False


def _cli_installed() -> bool:
    """Best-effort probe for `opentraceai` (or `uvx opentraceai`) on PATH.

    Treats any successful ``--version`` invocation as installed; treats any
    failure (CLI missing, uvx missing, network probe error) as not installed.
    """
    return _installed_version() is not None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    raw = sys.stdin.read()
    try:
        event = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        event = {}

    cwd = event.get("cwd") or os.getcwd()
    _debug.set_cwd(cwd)
    _debug(f"start cwd={cwd}")

    workspace_root = find_workspace_root(cwd)

    # CLI not installed → guide the user instead of silently failing later.
    # Without `opentraceai` on PATH neither indexing nor any tool call works,
    # so this branch must precede the no-index check.
    if not _cli_installed():
        _debug("skip — opentraceai CLI not installed")
        emit_json({"systemMessage": _CLI_MISSING_MESSAGE})
        return

    # No index → emit a system message and start indexing in the background.
    if not opentrace_healthy(workspace_root):
        repo_root = workspace_root or git_repo_root(Path(cwd))
        if repo_root:
            pid = start_background_index(repo_root)
            _debug(f"background index: pid={pid}")
            msg = (
                "OpenTrace: no index found — background indexing started. "
                "Tools will be available shortly."
            )
        else:
            msg = (
                "OpenTrace: not in a git repo or workspace. "
                "Run `uvx opentraceai index <path>` to enable graph tools."
            )
        emit_json({"systemMessage": msg})
        return

    db_path = find_db_path(workspace_root)
    stats = run_opentraceai(["stats"], cwd=workspace_root, timeout=10)
    update_notice = _update_notice()

    # Seed the Notification sentinel so we don't immediately announce the
    # already-present DB as "newly updated" on the very next prompt.
    if db_path and workspace_root:
        try:
            record_index_complete(workspace_root, db_path.stat().st_mtime)
        except OSError:
            pass

    additional_context = build_directive(stats=stats, db_path=db_path)
    additional_context = f"{additional_context}\n\n{_DEPRECATION_NOTE}"
    if not _git_token_available():
        additional_context = f"{additional_context}\n\n{_AUTH_NUDGE}"

    if stats:
        system_msg = f"OpenTrace is active — {stats.splitlines()[0]}"
    else:
        system_msg = (
            f"OpenTrace is active — index found at {db_path}. "
            "Run /graph-status or call get_stats to see what's indexed."
        )
    if update_notice:
        system_msg = f"{system_msg} | {update_notice}"
    if _debug.log_path:
        system_msg = f"{system_msg} | debug: {_debug.log_path}"

    emit_json({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": additional_context,
        },
        "systemMessage": system_msg,
    })


if __name__ == "__main__":
    main()
