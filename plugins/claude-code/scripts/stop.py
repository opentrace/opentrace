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

"""Stop hook: end-of-session staleness summary + cache pruning.

When the session ends, surface any files that were edited but never
re-indexed so the user knows to refresh before they return. Also prune
the staleness cache so it doesn't grow unbounded across long-lived
sessions on the same machine.

Opt-in auto-reindex: with ``OPENTRACE_CLAUDE_AUTO_REINDEX=1``, a stale
graph triggers a detached background ``uvx opentraceai index`` instead
of only a nag. Guarded by a 10-minute cooldown sentinel and a check for
an already-running indexer (``index.db.staging``), so the per-response
Stop event can't stack subprocesses. Completion is announced by the
existing Notification hook.
"""
from __future__ import annotations

import os

from _common import (
    AUTO_REINDEX_DEFAULT,
    emit_json,
    env_flag_enabled,
    find_workspace_root,
    maybe_start_auto_reindex,
    opentrace_healthy,
    prune_staleness,
    read_event,
    stale_files,
)
from _debug import DebugLogger

_debug = DebugLogger("stop")

_MAX_PATHS_SHOWN = 5


def main() -> None:
    event = read_event()
    cwd = event.get("cwd")
    _debug.set_cwd(cwd or "")
    workspace_root = find_workspace_root(cwd)

    # Prune first so the cache stays bounded even when the workspace
    # doesn't have a healthy index right now.
    prune_staleness()

    if not workspace_root or not opentrace_healthy(workspace_root):
        _debug("skip — opentrace not healthy")
        return

    paths = stale_files(workspace_root)
    if not paths:
        _debug("clean — no stale files")
        return

    workspace_str = str(workspace_root.resolve())
    rels = []
    for p in paths[:_MAX_PATHS_SHOWN]:
        try:
            rels.append(os.path.relpath(p, workspace_str))
        except ValueError:
            rels.append(p)
    more = f" (+{len(paths) - len(rels)} more)" if len(paths) > len(rels) else ""
    bullet = ", ".join(rels)
    plural = len(paths) != 1
    head = (
        f"OpenTrace: {len(paths)} file{'s' if plural else ''} edited this "
        f"session {'are' if plural else 'is'} not yet in the index "
        f"({bullet}{more})."
    )

    if env_flag_enabled("OPENTRACE_CLAUDE_AUTO_REINDEX", default=AUTO_REINDEX_DEFAULT):
        if maybe_start_auto_reindex(workspace_root):
            _debug(f"auto-reindex launched ({len(paths)} stale files)")
            emit_json({
                "systemMessage": f"{head} Auto-reindex started in the background."
            })
            return
        # Already running or within cooldown — stay quiet rather than nag
        # about staleness that's already being fixed.
        _debug("auto-reindex suppressed (in progress or cooldown)")
        return

    msg = (
        f"{head} Run `/index` or the `opentrace-index` skill next "
        "session to refresh graph queries for these files."
    )
    _debug(f"emitting end-of-session summary ({len(paths)} files)")
    emit_json({"systemMessage": msg})


if __name__ == "__main__":
    main()
