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

"""PreCompact hook: re-inject the OpenTrace routing directive plus the
current `get_stats` snapshot so the post-compact context window keeps
its routing knowledge.

Compaction summarizes old turns aggressively and can strip the
SessionStart system message. Without this hook, a long session can
"forget" the graph exists and silently drift back to `rg`/`grep`.
"""
from __future__ import annotations

from _common import (
    build_directive,
    emit_hook_output,
    find_db_path,
    find_workspace_root,
    opentrace_healthy,
    read_event,
    run_opentraceai,
)
from _debug import DebugLogger

_debug = DebugLogger("pre-compact")


def main() -> None:
    event = read_event()
    cwd = event.get("cwd")
    _debug.set_cwd(cwd or "")
    workspace_root = find_workspace_root(cwd)
    if not workspace_root or not opentrace_healthy(workspace_root):
        _debug("skip — opentrace not healthy")
        return

    db_path = find_db_path(workspace_root)
    stats = run_opentraceai(["stats"], cwd=workspace_root, timeout=8)
    context = build_directive(stats=stats, db_path=db_path)
    _debug(f"emitting directive ({len(context)} chars)")
    emit_hook_output("PreCompact", context)


if __name__ == "__main__":
    main()
