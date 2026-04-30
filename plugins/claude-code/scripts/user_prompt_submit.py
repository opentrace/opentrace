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

"""UserPromptSubmit hook: re-inject a brief OpenTrace status reminder
periodically so the model doesn't drift back to shell tools mid-session.

Throttled to once every BRIEFING_TTL_SECONDS (10 min) per machine.
"""
from __future__ import annotations

from _common import (
    briefing_due,
    emit_hook_output,
    find_workspace_root,
    mark_briefing_sent,
    opentrace_healthy,
    read_event,
    run_opentraceai,
)
from _debug import DebugLogger

_debug = DebugLogger("user-prompt-submit")


def main() -> None:
    event = read_event()
    cwd = event.get("cwd")
    _debug.set_cwd(cwd or "")
    workspace_root = find_workspace_root(cwd)
    if not opentrace_healthy(workspace_root):
        _debug("skip — opentrace not healthy")
        return
    if not briefing_due():
        _debug("skip — briefing not due")
        return

    stats = run_opentraceai(["stats"], cwd=workspace_root, timeout=8)
    if not stats:
        _debug("skip — stats returned nothing")
        return

    mark_briefing_sent()
    _debug("emitting briefing")
    emit_hook_output(
        "UserPromptSubmit",
        (
            "[OpenTrace] reminder — prefer `keyword_search`, `find_usages`, "
            "`traverse_graph`, `source_read`, `source_grep`, "
            "`impact_analysis` over shell `rg` / `grep` / `cat`.\n\n"
            "Graph state:\n" + stats
        ),
    )


if __name__ == "__main__":
    main()
