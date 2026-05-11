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

"""Workspace-mode DB resolution for the ``opentraceai`` CLI.

The top-level ``--workspace <dir>`` flag keys a per-directory database
under ``~/.opentrace/workspaces/<basename>-<sha256[:7]>/index.db``.
The formula is the canonical source of truth; consumers (the OpenCode
plugin, IDE extensions, direct CLI users) pass ``--workspace`` instead
of recomputing the path locally.

Exit codes are mirrored on the consumer side as constants so neither
end carries a magic number.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

# Exit codes — the published contract that consumers (OpenCode plugin,
# IDE extensions, direct CLI scripts) mirror. EXIT_OK isn't referenced
# inside the CLI (Click defaults to 0 on success) but stays here so this
# module is the single source of truth for the contract.
EXIT_OK = 0
EXIT_USAGE = 2
EXIT_DB_MISSING = 3
EXIT_WORKSPACE_UNRESOLVABLE = 4
EXIT_INDEX_IN_PROGRESS = 5

WORKSPACES_ROOT = Path.home() / ".opentrace" / "workspaces"
DB_NAME = "index.db"

# ASCII-only sanitiser — `\w` would let through Unicode letters that are
# valid on POSIX but cause grief on case-insensitive / non-UTF-8 filesystems
# and in tooling that round-trips paths through ASCII-restricted layers.
_BASENAME_SANITISER = re.compile(r"[^A-Za-z0-9._-]")


def _workspace_root_for(resolved_dir: Path) -> Path:
    """Return the per-workspace directory (without the DB filename) for a resolved path."""
    digest = hashlib.sha256(str(resolved_dir).encode("utf-8")).hexdigest()[:7]
    safe_basename = _BASENAME_SANITISER.sub("_", resolved_dir.name) or "root"
    return WORKSPACES_ROOT / f"{safe_basename}-{digest}"


def resolve_workspace_db(workspace_dir: str) -> Path:
    """Resolve ``workspace_dir`` to its workspace ``index.db`` path.

    Strict ``realpath``: a broken symlink, missing path, or EACCES
    raises ``FileNotFoundError`` / ``OSError`` instead of silently
    degrading. A path that resolves to a non-directory (a regular
    file, socket, etc.) raises ``NotADirectoryError`` — same handling
    on the caller side, since both subclass ``OSError`` and the
    top-level callback maps the whole family to exit code 4.

    The parent directory under ``WORKSPACES_ROOT`` is created eagerly
    (``mkdir -p``); writes can land immediately and reads against a
    missing ``index.db`` distinguish "no graph yet" from "directory
    layout broken".
    """
    resolved = Path(workspace_dir).resolve(strict=True)
    if not resolved.is_dir():
        raise NotADirectoryError(workspace_dir)
    workspace_root = _workspace_root_for(resolved)
    workspace_root.mkdir(parents=True, exist_ok=True)
    return workspace_root / DB_NAME
