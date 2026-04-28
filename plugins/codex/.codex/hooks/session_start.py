#!/usr/bin/env python3
"""SessionStart hook: prime Codex with OpenTrace tool-routing guidance.

Fires once per session. Only injects context when an OpenTrace index is
present in the workspace — otherwise stays silent so Codex behaves
normally on un-indexed projects.
"""
from __future__ import annotations

from common import (
    emit_json,
    find_db_path,
    find_workspace_root,
    opentrace_healthy,
    read_event,
    run_opentraceai,
)


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
hits, follow up with `source_read` before quoting docstrings as fact."""


def main() -> None:
    event = read_event()
    workspace_root = find_workspace_root(event.get("cwd"))
    if not opentrace_healthy(workspace_root):
        return

    db_path = find_db_path(workspace_root)
    stats = run_opentraceai(["stats"], cwd=workspace_root, timeout=10)

    lines = [DIRECTIVE]
    if stats:
        lines.append("")
        lines.append("Current graph state:")
        lines.append(stats)
    if db_path:
        lines.append("")
        lines.append(f"Index: {db_path}")

    emit_json({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": "\n".join(lines),
        }
    })


if __name__ == "__main__":
    main()