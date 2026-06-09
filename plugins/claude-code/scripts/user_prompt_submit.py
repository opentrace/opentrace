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

"""UserPromptSubmit hook: surface a graph-staleness warning when the
on-disk source has drifted from the indexed knowledge graph.

Replaces the previous 10-min "use the graph!" reminder, which paid a
per-prompt context cost whether or not the reminder was useful. The new
behavior is silent when nothing is stale, and emits a short heads-up
when one or more tracked edits postdate the index DB.

PostToolUse records every Edit/Write into `staleness.json`. This hook
reads that cache, compares each entry's mtime against `.opentrace/index.db`,
and emits a one-shot warning (throttled by `briefing_due()` so a long
session sees at most one warning per 10 minutes).
"""
from __future__ import annotations

import os

from _common import (
    briefing_due,
    emit_hook_output,
    find_workspace_root,
    mark_briefing_sent,
    opentrace_healthy,
    read_event,
    stale_files,
)
from _debug import DebugLogger

_debug = DebugLogger("user-prompt-submit")

_MAX_PATHS_SHOWN = 8


def _format_paths(paths: list[str], workspace_root) -> list[str]:
    """Render paths repo-relative for readability; cap at _MAX_PATHS_SHOWN."""
    workspace_str = str(workspace_root.resolve())
    rels = []
    for p in paths[:_MAX_PATHS_SHOWN]:
        try:
            rel = os.path.relpath(p, workspace_str)
        except ValueError:
            rel = p
        rels.append(rel)
    return rels


def main() -> None:
    event = read_event()
    cwd = event.get("cwd")
    _debug.set_cwd(cwd or "")
    workspace_root = find_workspace_root(cwd)
    if not workspace_root or not opentrace_healthy(workspace_root):
        _debug("skip — opentrace not healthy")
        return

    paths = stale_files(workspace_root)
    if not paths:
        _debug("skip — no stale files")
        return

    if not briefing_due():
        _debug(f"skip — {len(paths)} stale, throttled")
        return

    shown = _format_paths(paths, workspace_root)
    total = len(paths)
    more = f" (+{total - len(shown)} more)" if total > len(shown) else ""
    bullet = "\n".join(f"  - {p}" for p in shown)
    message = (
        f"[OpenTrace] Graph staleness: {total} file"
        f"{'s' if total != 1 else ''} edited since the last index{more}.\n"
        f"{bullet}\n\n"
        "Graph queries for symbols defined in these files may return "
        "outdated results. Re-index with the `opentrace-index` skill "
        "(or `/index`) to refresh."
    )
    mark_briefing_sent()
    _debug(f"emitting staleness warning ({total} files)")
    emit_hook_output("UserPromptSubmit", message)


if __name__ == "__main__":
    main()
