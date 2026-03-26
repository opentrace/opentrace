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

# ---------------------------------------------------------------------------
# Debug logging
# ---------------------------------------------------------------------------

_DEBUG = bool(os.environ.get("OPENTRACE_DEBUG"))


def _debug(msg: str) -> None:
    if _DEBUG:
        print(f"[edit-hook] {msg}", file=sys.stderr)


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
    if not cwd or not os.path.isabs(cwd):
        _debug("no absolute cwd, skipping")
        return

    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {})

    # Extract file path
    file_path = tool_input.get("file_path", "")
    if not file_path:
        _debug("no file_path in tool_input")
        return

    if not _is_code_file(file_path):
        _debug(f"skipping non-code file: {file_path}")
        return

    _debug(f"analyzing impact for {tool_name} on {file_path}")

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
                _debug(f"estimated line range: {line_spec}")

    result = run_opentraceai(args, cwd=cwd)
    if result:
        send_hook_response(result)


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
        if event == "PostToolUse":
            handle_post_tool_use(payload)
    except Exception as exc:
        _debug(f"unhandled error: {exc}")


if __name__ == "__main__":
    main()
