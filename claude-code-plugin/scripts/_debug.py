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

"""Shared debug logging helpers for OpenTrace Claude Code plugin hooks.

Enable by setting ``OPENTRACE_DEBUG=1`` in the shell that launches Claude
Code. When on, hook scripts emit a timestamped trace to stderr *and*, when
a repo-scoped ``.opentrace/`` directory can be located, append to
``.opentrace/hook-debug.log`` (alongside the index database).

Override the log path with ``OPENTRACE_DEBUG_LOG=/abs/path.log``.
"""

from __future__ import annotations

import os
import sys
import time
from typing import Optional

# Lenient truthiness (matches the pre-existing convention): any non-empty
# value enables debug, including "0" or "false". Changing this would be a
# silent behavior shift for anyone already using OPENTRACE_DEBUG.
_DEBUG = bool(os.environ.get("OPENTRACE_DEBUG"))

# Cap the upward walk to match the CLI's index discovery (10 levels).
_MAX_WALK_DEPTH = 10


def is_debug() -> bool:
    """Return True when debug mode is enabled for this process."""
    return _DEBUG


def find_log_path(start: str) -> Optional[str]:
    """Locate the debug log path by walking up from ``start``.

    Prefers ``OPENTRACE_DEBUG_LOG`` when set. Otherwise returns
    ``<repo>/.opentrace/hook-debug.log`` if a ``.opentrace/`` directory is
    found within the allowed depth (stopping at the git root). Returns
    ``None`` when no path can be determined — callers should fall back to
    stderr-only logging.
    """
    override = os.environ.get("OPENTRACE_DEBUG_LOG")
    if override:
        return override

    if not start or not os.path.isabs(start):
        return None

    current = start
    for _ in range(_MAX_WALK_DEPTH):
        candidate = os.path.join(current, ".opentrace")
        if os.path.isdir(candidate):
            return os.path.join(candidate, "hook-debug.log")
        # Stop at git root (.git is a file in worktrees, dir otherwise)
        if os.path.exists(os.path.join(current, ".git")):
            break
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return None


class DebugLogger:
    """Append-only debug logger; silent when ``OPENTRACE_DEBUG`` is unset.

    Usage:
        _debug = DebugLogger("opentrace-hook")
        _debug.set_cwd(payload["cwd"])    # resolves log path lazily
        _debug("extracted pattern=foo")
    """

    def __init__(self, tag: str) -> None:
        self.tag = tag
        self._log_path: Optional[str] = None
        self._resolved = False

    def set_cwd(self, cwd: str) -> None:
        """Resolve the log file path once we know the hook's cwd."""
        if not _DEBUG or self._resolved:
            return
        self._log_path = find_log_path(cwd)
        self._resolved = True

    @property
    def log_path(self) -> Optional[str]:
        return self._log_path

    def __call__(self, msg: str) -> None:
        if not _DEBUG:
            return
        line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} [{self.tag}] {msg}"
        # Always emit to stderr — surfaces in Claude Code's transcript logs.
        print(line, file=sys.stderr)
        # Also append to the log file when we have a resolved path.
        if self._log_path:
            try:
                with open(self._log_path, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except OSError:
                # A hook that crashes on logging is worse than one that
                # logs nothing. Swallow I/O errors silently.
                pass
