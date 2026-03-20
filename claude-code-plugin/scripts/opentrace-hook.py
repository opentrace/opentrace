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

"""OpenTrace hook for Claude Code PreToolUse / PostToolUse events.

Reads a JSON payload from stdin, dispatches on ``hook_event_name``, and
writes a JSON response to stdout when graph-enriched context is available.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Debug logging — only when OPENTRACE_DEBUG is set
# ---------------------------------------------------------------------------

_DEBUG = bool(os.environ.get("OPENTRACE_DEBUG"))


def _debug(msg: str) -> None:
    if _DEBUG:
        print(f"[opentrace-hook] {msg}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Index discovery
# ---------------------------------------------------------------------------

_OPENTRACE_DIR = ".opentrace"
_INDEX_NAME = "index.db"


def find_ot_index(start_dir: str) -> str | None:
    """Walk up to 5 parent directories looking for .opentrace/index.db."""
    try:
        current = Path(start_dir).resolve()
        for _ in range(6):  # start_dir + 5 parents
            candidate = current / _OPENTRACE_DIR / _INDEX_NAME
            if candidate.is_file():
                return str(candidate)
            parent = current.parent
            if parent == current:
                break
            current = parent
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Pattern extraction
# ---------------------------------------------------------------------------

# Flags that consume the next token as a value
_BASH_FLAG_VALUES = frozenset({
    "-e", "-f", "-A", "-B", "-C",
    "--glob", "--type", "-t", "-i", "-m", "--max-count",
})


def extract_pattern(tool_name: str, tool_input: dict) -> str | None:
    """Extract a meaningful search pattern from a tool invocation."""
    try:
        if tool_name == "Grep":
            return tool_input.get("pattern")

        if tool_name == "Glob":
            raw = tool_input.get("pattern", "")
            # Pull an identifier-like token from the glob string
            m = re.search(r"[A-Za-z_][A-Za-z0-9_]{2,}", raw)
            return m.group(0) if m else None

        if tool_name == "Bash":
            cmd = tool_input.get("command", "")
            tokens = shlex.split(cmd)
            if not tokens:
                return None
            # Only proceed for rg or grep commands
            base = os.path.basename(tokens[0])
            if base not in ("rg", "grep"):
                return None
            skip_next = False
            for tok in tokens[1:]:
                if skip_next:
                    skip_next = False
                    continue
                if tok in _BASH_FLAG_VALUES:
                    skip_next = True
                    continue
                if tok.startswith("-"):
                    continue
                if len(tok) >= 3:
                    return tok
    except Exception:
        _debug(f"extract_pattern error for {tool_name}")
    return None


# ---------------------------------------------------------------------------
# CLI invocation
# ---------------------------------------------------------------------------


def run_opentraceai(args: list[str], cwd: str, timeout: int = 7) -> str | None:
    """Run the opentraceai CLI and return stdout on success."""
    try:
        exe = shutil.which("opentraceai")
        if exe:
            cmd = [exe, *args]
        else:
            cmd = ["uvx", "opentraceai", *args]

        _debug(f"running: {cmd}")
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=timeout,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except subprocess.TimeoutExpired:
        _debug("opentraceai timed out")
    except Exception as exc:
        _debug(f"opentraceai error: {exc}")
    return None


# ---------------------------------------------------------------------------
# Hook response
# ---------------------------------------------------------------------------


def send_hook_response(event: str, context: str) -> None:
    """Write a hook response JSON to stdout."""
    payload = {
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": context,
        }
    }
    print(json.dumps(payload), flush=True)


# ---------------------------------------------------------------------------
# Event handlers
# ---------------------------------------------------------------------------

_AUGMENT_TOOLS = frozenset({"Grep", "Glob", "Bash"})

_GIT_MUTATION_COMMANDS = (
    "git commit",
    "git merge",
    "git rebase",
    "git checkout",
    "git switch",
)


def handle_pre_tool_use(payload: dict) -> None:
    """Augment search tool calls with graph context."""
    try:
        cwd = payload.get("cwd", "")
        if not cwd or not os.path.isabs(cwd):
            _debug("no absolute cwd, skipping")
            return

        db_path = find_ot_index(cwd)
        if not db_path:
            _debug("no otindex.db found")
            return

        tool_name = payload.get("tool_name", "")
        if tool_name not in _AUGMENT_TOOLS:
            return

        tool_input = payload.get("tool_input", {})
        pattern = extract_pattern(tool_name, tool_input)
        if not pattern or len(pattern) < 3:
            _debug(f"pattern too short: {pattern!r}")
            return

        _debug(f"augmenting {tool_name} with pattern={pattern!r}")
        result = run_opentraceai(
            ["augment", "--db", db_path, "--", pattern],
            cwd=cwd,
        )
        if result:
            send_hook_response("PreToolUse", result)
    except Exception as exc:
        _debug(f"handle_pre_tool_use error: {exc}")


def handle_post_tool_use(payload: dict) -> None:
    """Warn about potential index staleness after git mutations."""
    try:
        tool_name = payload.get("tool_name", "")
        if tool_name != "Bash":
            return

        tool_input = payload.get("tool_input", {})
        cmd = tool_input.get("command", "")
        if not any(mutation in cmd for mutation in _GIT_MUTATION_COMMANDS):
            return

        cwd = payload.get("cwd", "")
        if not cwd or not os.path.isabs(cwd):
            return

        db_path = find_ot_index(cwd)
        if not db_path:
            return

        _debug("git mutation detected, emitting staleness warning")
        send_hook_response(
            "PostToolUse",
            "The OpenTrace graph index (.opentrace/index.db) may now be stale "
            "after this git operation. If code structure has changed, suggest "
            "re-indexing with: opentraceai index",
        )
    except Exception as exc:
        _debug(f"handle_post_tool_use error: {exc}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return
        payload = json.loads(raw)
    except Exception as exc:
        _debug(f"failed to parse stdin: {exc}")
        return

    event = payload.get("hook_event_name", "")
    _debug(f"event={event}")

    try:
        if event == "PreToolUse":
            handle_pre_tool_use(payload)
        elif event == "PostToolUse":
            handle_post_tool_use(payload)
    except Exception as exc:
        _debug(f"unhandled error: {exc}")


if __name__ == "__main__":
    main()
