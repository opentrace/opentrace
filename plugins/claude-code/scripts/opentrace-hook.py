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

"""OpenTrace hook for Claude Code PreToolUse events.

Reads a JSON payload from stdin, queries the graph for context about the
search target, and writes a JSON response to stdout when available.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time

from _debug import DebugLogger

# ---------------------------------------------------------------------------
# Debug logging — enabled via OPENTRACE_DEBUG. See scripts/_debug.py.
# ---------------------------------------------------------------------------

_debug = DebugLogger("opentrace-hook")


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
    except Exception as exc:
        _debug(f"extract_pattern: error tool={tool_name}: {exc}")
    return None


# ---------------------------------------------------------------------------
# CLI invocation
# ---------------------------------------------------------------------------


def run_opentraceai(args: list[str], cwd: str, timeout: int = 7) -> str | None:
    """Run the opentraceai CLI and return stdout on success."""
    exe = shutil.which("opentraceai")
    cmd = [exe, *args] if exe else ["uvx", "opentraceai", *args]
    _debug(f"cli: exec={'direct' if exe else 'uvx'} cmd={cmd!r} cwd={cwd!r} timeout={timeout}")

    start = time.monotonic()
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        _debug(f"cli: TIMEOUT after {time.monotonic() - start:.2f}s")
        return None
    except Exception as exc:
        _debug(f"cli: ERROR after {time.monotonic() - start:.2f}s: {exc}")
        return None

    duration = time.monotonic() - start
    out = result.stdout.strip()
    err = result.stderr.strip()
    _debug(
        f"cli: rc={result.returncode} duration={duration:.2f}s "
        f"stdout_len={len(out)} stderr_len={len(err)}"
    )
    if err:
        _debug(f"cli: stderr={err[:200]!r}")
    if result.returncode == 0 and out:
        return out
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

def handle_pre_tool_use(payload: dict) -> None:
    """Augment search tool calls with graph context."""
    try:
        cwd = payload.get("cwd", "")
        tool_name = payload.get("tool_name", "")
        tool_input = payload.get("tool_input", {})
        _debug(f"pre_tool_use: tool={tool_name!r} cwd={cwd!r} input_keys={list(tool_input)}")

        if not cwd or not os.path.isabs(cwd):
            _debug("pre_tool_use: skip — no absolute cwd")
            return

        pattern = extract_pattern(tool_name, tool_input)
        if not pattern or len(pattern) < 3:
            _debug(f"pre_tool_use: skip — pattern too short ({pattern!r})")
            return

        _debug(f"pre_tool_use: augmenting tool={tool_name} pattern={pattern!r}")
        # Let the CLI handle DB discovery via its own find_db()
        result = run_opentraceai(["augment", "--", pattern], cwd=cwd)
        if result:
            _debug(f"pre_tool_use: hit — injecting {len(result)} chars of context")
            send_hook_response("PreToolUse", result)
        else:
            _debug("pre_tool_use: miss — no augment output")
    except Exception as exc:
        _debug(f"pre_tool_use: unhandled error: {exc}")


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

    # Resolve the debug log path from the payload's cwd so subsequent
    # log lines also land in the file (not just stderr).
    _debug.set_cwd(payload.get("cwd", ""))

    event = payload.get("hook_event_name", "")
    _debug(f"main: event={event!r} log={_debug.log_path!r}")

    try:
        if event == "PreToolUse":
            handle_pre_tool_use(payload)
    except Exception as exc:
        _debug(f"main: unhandled error: {exc}")


if __name__ == "__main__":
    main()
