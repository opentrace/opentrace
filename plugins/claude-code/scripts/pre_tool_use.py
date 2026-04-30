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

"""PreToolUse hook: when Claude Code is about to run Grep, Glob, or Bash,
intercept search/read patterns and inject equivalent OpenTrace graph
context.

This is the runtime nudge: even if the model defaulted to a shell tool,
seeing graph results inline often makes it pivot to MCP tools mid-turn.
The hook never blocks the tool — Claude Code still runs whatever it was
going to run; we just enrich the context.
"""
from __future__ import annotations

import os
import re
import shlex

from _common import (
    SEARCH_COMMANDS,
    SEARCH_VALUE_OPTIONS,
    build_read_message,
    build_search_message,
    emit_hook_output,
    extract_read_path,
    extract_search_pattern,
    find_workspace_root,
    opentrace_healthy,
    read_event,
)
from _debug import DebugLogger

_debug = DebugLogger("pre-tool-use")


# ---------------------------------------------------------------------------
# Pattern extraction for native Grep/Glob/Bash tool invocations
# ---------------------------------------------------------------------------

def _pattern_from_grep(tool_input: dict) -> str | None:
    return tool_input.get("pattern")


def _pattern_from_glob(tool_input: dict) -> str | None:
    raw = tool_input.get("pattern", "") or ""
    m = re.search(r"[A-Za-z_][A-Za-z0-9_]{2,}", raw)
    return m.group(0) if m else None


def _pattern_from_bash(command: str) -> str | None:
    """Best-effort: pull the search term from rg/grep/ack/ag.

    Reuses the shared shell parser when possible. For very simple inputs
    (no shell operators) ``extract_search_pattern`` already handles
    everything; this wrapper just adapts the return shape.
    """
    return extract_search_pattern(command)


def _augment_target(tool_name: str, tool_input: dict) -> tuple[str, str | None]:
    """Decide what kind of augmentation applies to this tool call.

    Returns ``(kind, value)`` where:
    - kind="search" + value=pattern  → run augment via build_search_message
    - kind="read"   + value=path     → run impact via build_read_message
    - kind=""       + value=None     → no augmentation
    """
    if tool_name == "Grep":
        pat = _pattern_from_grep(tool_input)
        return ("search", pat) if pat and len(pat) >= 3 else ("", None)

    if tool_name == "Glob":
        pat = _pattern_from_glob(tool_input)
        return ("search", pat) if pat and len(pat) >= 3 else ("", None)

    if tool_name == "Bash":
        cmd = tool_input.get("command", "") or ""
        pat = _pattern_from_bash(cmd)
        if pat and len(pat) >= 3:
            return ("search", pat)
        path = extract_read_path(cmd)
        if path:
            return ("read", path)
        return ("", None)

    return ("", None)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    payload = read_event()
    cwd = payload.get("cwd", "") or ""
    _debug.set_cwd(cwd)

    if not cwd or not os.path.isabs(cwd):
        _debug("skip — no absolute cwd")
        return

    workspace_root = find_workspace_root(cwd)
    if not opentrace_healthy(workspace_root):
        _debug("skip — opentrace not healthy")
        return

    tool_name = payload.get("tool_name", "") or ""
    tool_input = payload.get("tool_input", {}) or {}
    _debug(f"tool={tool_name!r} input_keys={list(tool_input)}")

    kind, value = _augment_target(tool_name, tool_input)
    if not kind or not value:
        _debug("skip — no augmentable pattern/path")
        return

    if kind == "search":
        _debug(f"augmenting search pattern={value!r}")
        message = build_search_message(value, workspace_root)
    else:  # kind == "read"
        # Shell paths in Bash commands are relative to the command's cwd,
        # not workspace_root — resolve against cwd here.
        abs_path = (
            value if os.path.isabs(value) else os.path.abspath(os.path.join(cwd, value))
        )
        _debug(f"augmenting read path={abs_path!r}")
        message = build_read_message(abs_path, workspace_root)

    if not message:
        _debug("miss — augment returned nothing")
        return

    _debug(f"hit — injecting {len(message)} chars of context")
    emit_hook_output("PreToolUse", message)


if __name__ == "__main__":
    main()