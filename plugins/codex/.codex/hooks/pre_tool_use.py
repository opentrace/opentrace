#!/usr/bin/env python3
"""PreToolUse hook: when Codex is about to run a Bash command, intercept
shell search (rg / grep) and shell file-reads (cat / head / tail) and
inject equivalent OpenTrace graph context as a systemMessage.

This is the runtime nudge: even if the model defaulted to a shell tool,
seeing graph results inline often makes it pivot to MCP tools mid-turn.
The hook never blocks the shell command — Codex still runs whatever it
was going to run; we just enrich the context.
"""
from __future__ import annotations

from common import (
    build_read_message,
    build_search_message,
    emit_json,
    extract_read_path,
    extract_search_pattern,
    find_workspace_root,
    opentrace_healthy,
    read_event,
)


def main() -> None:
    event = read_event()
    workspace_root = find_workspace_root(event.get("cwd"))
    if not opentrace_healthy(workspace_root):
        return

    command = str(event.get("tool_input", {}).get("command") or "")
    if not command:
        return

    message = None
    pattern = extract_search_pattern(command)
    if pattern:
        message = build_search_message(pattern, workspace_root)
    else:
        path = extract_read_path(command)
        if path:
            message = build_read_message(path, workspace_root)

    if not message:
        return
    emit_json({"systemMessage": message})


if __name__ == "__main__":
    main()