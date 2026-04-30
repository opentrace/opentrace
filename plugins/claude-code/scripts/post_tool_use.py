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

"""PostToolUse hook for Edit / Write events.

After an edit or write completes:
1. Resolve the file path that was modified.
2. For Edit, estimate the affected line range from new_string.
3. Run ``opentraceai impact`` to surface dependents.
4. Inject the impact analysis as additionalContext.
"""
from __future__ import annotations

import os

from _common import (
    emit_hook_output,
    estimate_line_range,
    find_workspace_root,
    is_code_file,
    opentrace_healthy,
    read_event,
    run_opentraceai,
)
from _debug import DebugLogger

_debug = DebugLogger("post-tool-use")


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
    file_path = tool_input.get("file_path", "") or ""
    if not file_path:
        _debug("skip — no file_path")
        return

    if not os.path.isabs(file_path):
        file_path = os.path.join(cwd, file_path)
    if not is_code_file(file_path):
        _debug(f"skip — non-code file: {file_path}")
        return

    args = ["impact", "--", file_path]
    if tool_name == "Edit":
        new_string = tool_input.get("new_string", "") or ""
        old_string = tool_input.get("old_string", "") or ""
        if new_string and old_string:
            line_spec = estimate_line_range(new_string, file_path)
            if line_spec:
                args = ["impact", "--lines", line_spec, "--", file_path]
                _debug(f"line_range={line_spec}")

    out = run_opentraceai(args, cwd=cwd, timeout=10)
    if not out:
        _debug("miss — no impact output")
        return
    _debug(f"hit — injecting {len(out)} chars")
    emit_hook_output("PostToolUse", out)


if __name__ == "__main__":
    main()
