#!/usr/bin/env python3
"""UserPromptSubmit hook: re-inject a brief OpenTrace status reminder
periodically so the model doesn't drift back to shell tools mid-session.

Throttled to once every BRIEFING_TTL_SECONDS (10 min) per machine.
"""
from __future__ import annotations

from common import (
    briefing_due,
    emit_json,
    find_workspace_root,
    mark_briefing_sent,
    opentrace_healthy,
    read_event,
    run_opentraceai,
)


def main() -> None:
    event = read_event()
    workspace_root = find_workspace_root(event.get("cwd"))
    if not opentrace_healthy(workspace_root):
        return
    if not briefing_due():
        return

    stats = run_opentraceai(["stats"], cwd=workspace_root, timeout=8)
    if not stats:
        return

    mark_briefing_sent()
    emit_json({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": (
                "[OpenTrace] reminder — prefer `keyword_search`, "
                "`find_usages`, `traverse_graph`, `source_read`, "
                "`source_grep`, `impact_analysis` over shell `rg` / "
                "`grep` / `cat`.\n\nGraph state:\n" + stats
            ),
        }
    })


if __name__ == "__main__":
    main()