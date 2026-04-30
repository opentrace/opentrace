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
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Optional

from _common import (
    emit_json,
    find_db_path,
    find_workspace_root,
    opentrace_healthy,
    run_opentraceai,
)
from _debug import DebugLogger

_debug = DebugLogger("session-start")


DIRECTIVE = """\
OpenTrace is active in this workspace — the codebase is indexed into a
queryable knowledge graph (classes, functions, files, services, and the
relationships between them).

**Default to OpenTrace tools BEFORE shell `rg` / `grep` / `find` / `cat`.**
The graph answers in one call what would take many shell commands.

| Question shape | Use | Not |
|---|---|---|
| Find a symbol by name | `keyword_search` | `rg <name>` |
| Read a file by node ID or path | `source_read` | `cat <path>` |
| Search across indexed repos | `source_grep` | `rg` (only sees cwd) |
| Trace callers / dependents | `find_usages` or `traverse_graph` | manual rg + grep loops |
| Pre-edit blast radius | `impact_analysis` | nothing — rg can't do this |
| Structural overview | `get_stats` + `list_nodes` | `tree` / `find` / `wc -l` |
| Subgraph around a node | `search_graph` | not possible in shell |

Fall back to shell only when OpenTrace returns no results, the file isn't
in any indexed repo, or the user explicitly asks for raw shell output.

Trust hint: `keyword_search` results carry a `_match_field` tag — treat
`name` / `signature` matches as authoritative; for `_match_field: "docs"`
hits, follow up with `source_read` before quoting docstrings as fact.

Specialist agents: `@opentrace`, `@code-explorer`, `@dependency-analyzer`,
`@find-usages`, `@explain-service`. Slash commands: `/explore <name>`,
`/graph-status`, `/index`, `/interrogate`, `/update`."""


# ---------------------------------------------------------------------------
# Background indexing — when no .opentrace/index.db is present
# ---------------------------------------------------------------------------

def _start_background_index(repo_root: Path) -> Optional[int]:
    """Kick off `uvx opentraceai index .` detached. Returns the PID or None."""
    if not shutil.which("uvx"):
        _debug("background index: skipped (uvx missing)")
        return None
    log_path = repo_root / ".opentrace-index.log"
    try:
        with open(log_path, "ab") as logf:
            proc = subprocess.Popen(
                ["uvx", "opentraceai", "index", str(repo_root)],
                stdout=logf,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                cwd=str(repo_root),
                start_new_session=True,
            )
    except OSError as exc:
        _debug(f"background index: failed to spawn: {exc}")
        return None
    _debug(f"background index: pid={proc.pid} log={log_path}")
    return proc.pid


def _git_repo_root(start: Path) -> Optional[Path]:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            cwd=str(start),
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    out = result.stdout.strip()
    return Path(out) if out else None


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

    # No index → emit a system message and start indexing in the background.
    if not opentrace_healthy(workspace_root):
        repo_root = workspace_root or _git_repo_root(Path(cwd))
        if repo_root:
            _start_background_index(repo_root)
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

    context_lines = [DIRECTIVE]
    if stats:
        context_lines.extend(["", "Current graph state:", stats])
    if db_path:
        context_lines.extend(["", f"Index: {db_path}"])

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
            "additionalContext": "\n".join(context_lines),
        },
        "systemMessage": system_msg,
    })


if __name__ == "__main__":
    main()
