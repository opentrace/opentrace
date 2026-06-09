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

"""Notification hook: announce that a background OpenTrace index has
completed since we last told the user about it.

SessionStart kicks off `uvx opentraceai index` when no DB exists and
seeds the `last_index.json` sentinel with whatever DB mtime is current
(or absent). The Notification event fires when Claude Code is waiting
for user input — we use that lull to surface the completion message
exactly once per new index, then update the sentinel.
"""
from __future__ import annotations

from _common import (
    emit_json,
    find_db_path,
    find_workspace_root,
    last_index_seen,
    read_event,
    record_index_complete,
    run_opentraceai,
)
from _debug import DebugLogger

_debug = DebugLogger("notification")


def main() -> None:
    event = read_event()
    cwd = event.get("cwd")
    _debug.set_cwd(cwd or "")
    workspace_root = find_workspace_root(cwd)
    if not workspace_root:
        _debug("skip — no workspace root")
        return

    db_path = find_db_path(workspace_root)
    if not db_path:
        _debug("skip — no index.db")
        return

    try:
        db_mtime = db_path.stat().st_mtime
    except OSError:
        _debug("skip — db stat failed")
        return

    last = last_index_seen(workspace_root)
    if last is not None and db_mtime <= last:
        _debug(f"skip — db unchanged (mtime={db_mtime} last_seen={last})")
        return

    # New (or first-time) index. Pull a stats summary if we can; the
    # announcement is still useful without it.
    stats = run_opentraceai(["stats"], cwd=workspace_root, timeout=5)
    headline = stats.splitlines()[0] if stats else f"index at {db_path}"
    msg = f"OpenTrace: index updated — {headline}"
    record_index_complete(workspace_root, db_mtime)
    _debug(f"announcing new index (mtime={db_mtime})")
    emit_json({"systemMessage": msg})


if __name__ == "__main__":
    main()
