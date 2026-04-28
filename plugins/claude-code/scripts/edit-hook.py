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

"""OpenTrace hook for Claude Code PostToolUse events on Edit/Write.

After an edit or write completes, this hook:
1. Extracts the file path from the tool output
2. Estimates which line ranges were changed (for Edit)
3. Runs ``opentraceai impact`` to find affected symbols and their dependents
4. Injects the impact analysis as additionalContext for Claude
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time

from _debug import DebugLogger

# ---------------------------------------------------------------------------
# Debug logging — enabled via OPENTRACE_DEBUG. See scripts/_debug.py.
# ---------------------------------------------------------------------------

_debug = DebugLogger("edit-hook")


# ---------------------------------------------------------------------------
# Line range estimation
# ---------------------------------------------------------------------------

def _estimate_line_range(old_string: str, new_string: str, file_path: str) -> str | None:
    """Try to figure out which lines were affected by an Edit.

    We read the *updated* file and find where new_string lands.
    Returns a line spec like "10-25" or None if we can't determine it.
    """
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except Exception:
        return None

    idx = content.find(new_string)
    if idx == -1:
        return None

    start_line = content[:idx].count("\n") + 1
    end_line = start_line + new_string.count("\n")

    # Expand the range a bit to catch the full function/class
    start_line = max(1, start_line - 5)
    end_line = end_line + 5

    return f"{start_line}-{end_line}"


# ---------------------------------------------------------------------------
# CLI invocation
# ---------------------------------------------------------------------------

def run_opentraceai(args: list[str], cwd: str, timeout: int = 10) -> str | None:
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

def send_hook_response(context: str) -> None:
    """Write a hook response JSON to stdout."""
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": context,
        }
    }
    print(json.dumps(payload), flush=True)


# ---------------------------------------------------------------------------
# File extension filter — skip files that are unlikely to be in the graph
# ---------------------------------------------------------------------------

_CODE_EXTENSIONS = frozenset({
    ".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".kt",
    ".cs", ".c", ".cpp", ".h", ".hpp", ".rb", ".swift", ".proto",
    ".sql", ".graphql", ".gql", ".sh", ".bash",
})


def _is_code_file(path: str) -> bool:
    """Check if the file extension suggests source code."""
    _, ext = os.path.splitext(path)
    return ext.lower() in _CODE_EXTENSIONS


# ---------------------------------------------------------------------------
# Event handler
# ---------------------------------------------------------------------------

def handle_post_tool_use(payload: dict) -> None:
    """Analyze the impact of an edit/write and inject context."""
    cwd = payload.get("cwd", "")
    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {})
    _debug(f"post_tool_use: tool={tool_name!r} cwd={cwd!r} input_keys={list(tool_input)}")

    if not cwd or not os.path.isabs(cwd):
        _debug("post_tool_use: skip — no absolute cwd")
        return

    # Extract file path
    file_path = tool_input.get("file_path", "")
    if not file_path:
        _debug("post_tool_use: skip — no file_path in tool_input")
        return

    # Ensure path is absolute if relative
    if not os.path.isabs(file_path) and cwd:
        file_path = os.path.join(cwd, file_path)

    if not _is_code_file(file_path):
        _debug(f"post_tool_use: skip — non-code file: {file_path}")
        return

    _debug(f"post_tool_use: analyzing tool={tool_name} path={file_path}")

    # Build the CLI args
    args = ["impact", "--", file_path]

    # For Edit, try to estimate the changed line range
    if tool_name == "Edit":
        new_string = tool_input.get("new_string", "")
        old_string = tool_input.get("old_string", "")
        if new_string and old_string:
            line_spec = _estimate_line_range(old_string, new_string, file_path)
            if line_spec:
                args = ["impact", "--lines", line_spec, "--", file_path]
                _debug(f"post_tool_use: estimated line_range={line_spec}")
            else:
                _debug("post_tool_use: line_range=unknown (new_string not found in file)")

    result = run_opentraceai(args, cwd=cwd)
    if result:
        _debug(f"post_tool_use: hit — injecting {len(result)} chars of context")
        send_hook_response(result)
    else:
        _debug("post_tool_use: miss — no impact output")


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
        if event == "PostToolUse":
            handle_post_tool_use(payload)
    except Exception as exc:
        _debug(f"main: unhandled error: {exc}")


if __name__ == "__main__":
    main()
