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

"""OT-1732 Grep — regex pattern matching across indexed scopes (OT-1732 Phase 6).

Scopes are nodes whose subtree has on-disk content the agent can search:

- ``Repository`` with ``local_path`` set (local-directory indexes; cloned
  remote repos don't carry one).
- ``WikiVault`` (always rooted under ``OT_VAULT_ROOT/<name>/pages``).

ripgrep is invoked via ``subprocess.run`` with ``--json`` for structured
output. ``rg`` is expected on ``PATH``; missing-binary cases return a
structured error so the agent can fall back to ``search_graph``.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path
from typing import Any

from opentrace_agent.store import GraphStore

logger = logging.getLogger(__name__)

DEFAULT_MAX_RESULTS = 200
MAX_RESULTS_CAP = 5000

# Cap subprocess wall-time so a runaway pattern can't hang the MCP server.
RG_TIMEOUT_SEC = 10


def grep(
    store: GraphStore,
    pattern: str,
    *,
    scope_id: str,
    file_filter: str | None = None,
    case_sensitive: bool = False,
    max_results: int = DEFAULT_MAX_RESULTS,
) -> dict[str, Any]:
    """Run regex *pattern* via ripgrep over the on-disk content reachable from *scope_id*.

    Parameters
    ----------
    scope_id
        ID of a ``Repository`` or ``WikiVault`` node — the node whose
        on-disk subtree is searched.
    file_filter
        Optional substring; only files whose path contains it are searched.
    case_sensitive
        Default ``False``. Maps to ripgrep's ``-i``.
    max_results
        Hard cap on returned matches (default 200, max 5000).

    Returns
    -------
    dict
        ``{"matches": [Match, ...], "count": N, "scope": str, "mode": "ripgrep"|"error"}``
        where each Match is
        ``{node_id, file_path, line_number, line_text, structural_context}``.
        On failure the result has ``mode="error"`` and an ``error`` string
        explaining why; ``matches`` is empty.
    """
    max_results = max(1, min(max_results, MAX_RESULTS_CAP))

    scope_node = store.get_node(scope_id)
    if scope_node is None:
        return _err(scope_id, f"scope node not found: {scope_id}")
    scope_type = scope_node["type"]
    scope_props = scope_node.get("properties") or {}

    if scope_type == "Repository":
        local_path = scope_props.get("local_path")
        if not local_path:
            return _err(
                scope_id,
                "Repository has no local_path — re-index from a local "
                "directory to enable grep, or fall back to search_graph",
            )
        root = Path(str(local_path))
    elif scope_type == "WikiVault":
        from opentrace_agent.wiki.paths import (
            InvalidVaultName,
        )
        from opentrace_agent.wiki.paths import (
            pages_dir as _pages_dir,
        )

        # WikiVault id format is ``vault::<name>``. Strip the prefix.
        vault_name = scope_node["name"] or scope_id.replace("vault::", "", 1)
        try:
            root = _pages_dir(vault_name)
        except InvalidVaultName as e:
            return _err(scope_id, f"invalid vault name: {e}")
    else:
        return _err(
            scope_id,
            f"unsupported scope type {scope_type!r} — must be Repository or WikiVault",
        )

    if not root.exists() or not root.is_dir():
        return _err(scope_id, f"scope path is not a directory on disk: {root}")

    rg = shutil.which("rg")
    if rg is None:
        return _err(
            scope_id,
            "ripgrep ('rg') not on PATH — install ripgrep or use search_graph for FTS over indexed name/summary",
        )

    matches = _run_ripgrep(
        rg=rg,
        pattern=pattern,
        root=root,
        file_filter=file_filter,
        case_sensitive=case_sensitive,
        max_results=max_results,
    )

    # Enrich with structural context — the File node id and (for vault
    # scopes) the vault name.
    enriched: list[dict[str, Any]] = []
    for m in matches:
        enriched.append(
            {
                "node_id": _resolve_file_node_id(store, scope_node, m["file_path"]),
                "file_path": m["file_path"],
                "line_number": m["line_number"],
                "line_text": m["line_text"],
                "structural_context": _structural_context(scope_type, scope_props),
            }
        )

    return {
        "matches": enriched,
        "count": len(enriched),
        "scope": scope_id,
        "mode": "ripgrep",
    }


def _err(scope_id: str, message: str) -> dict[str, Any]:
    return {"matches": [], "count": 0, "scope": scope_id, "mode": "error", "error": message}


def _run_ripgrep(
    *,
    rg: str,
    pattern: str,
    root: Path,
    file_filter: str | None,
    case_sensitive: bool,
    max_results: int,
) -> list[dict[str, Any]]:
    """Spawn ripgrep with ``--json`` and parse line-match events into a list."""
    cmd: list[str] = [
        rg,
        "--json",
        "--line-number",
        "--no-heading",
        "--max-count=" + str(max_results),
        # Limit memory/time on very large files; ripgrep skips binary by default.
        "--max-filesize=10M",
    ]
    if not case_sensitive:
        cmd.append("--ignore-case")
    if file_filter:
        # ripgrep glob: `*<filter>*` so a substring matches.
        cmd.extend(["--glob", f"*{file_filter}*"])
    cmd.extend(["--", pattern, str(root)])

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=RG_TIMEOUT_SEC,
            check=False,
        )
    except subprocess.TimeoutExpired:
        logger.warning("ripgrep timed out after %ds for pattern=%r", RG_TIMEOUT_SEC, pattern)
        return []

    if proc.returncode not in (0, 1):
        # 1 = no matches, also non-error. Anything else is a real failure.
        logger.warning("ripgrep returned %d: stderr=%s", proc.returncode, proc.stderr.strip())
        return []

    matches: list[dict[str, Any]] = []
    for line in proc.stdout.splitlines():
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "match":
            continue
        data = event.get("data") or {}
        path = (data.get("path") or {}).get("text", "")
        text = (data.get("lines") or {}).get("text", "").rstrip("\n")
        line_no = int(data.get("line_number") or 0)
        # Path comes back absolute; relativize to the scope root for stable
        # display, falling back to the raw path if it falls outside.
        try:
            rel = str(Path(path).relative_to(root))
        except ValueError:
            rel = path
        matches.append(
            {
                "file_path": rel,
                "line_number": line_no,
                "line_text": text,
            }
        )
        if len(matches) >= max_results:
            break
    return matches


def _resolve_file_node_id(store: GraphStore, scope_node: dict[str, Any], file_rel_path: str) -> str | None:
    """Best-effort lookup of the File node id for a hit's relative path.

    For a ``Repository``-scoped grep, file node IDs follow
    ``{repoId}/{path}`` per the indexer convention. For ``WikiVault``
    scopes, hits are markdown pages whose slug == filename minus ``.md``;
    we map that to a ``WikiPage`` node id.
    """
    scope_type = scope_node["type"]
    if scope_type == "Repository":
        return f"{scope_node['id']}/{file_rel_path}"
    if scope_type == "WikiVault":
        if file_rel_path.endswith(".md"):
            slug = file_rel_path[: -len(".md")]
        else:
            slug = file_rel_path
        # WikiPage id is ``<vault>::<slug>``. Vault name lives on the scope node.
        vault_name = scope_node.get("name") or ""
        return f"{vault_name}::{slug}"
    return None


def _structural_context(scope_type: str, scope_props: dict[str, Any]) -> dict[str, Any]:
    ctx: dict[str, Any] = {"scope_type": scope_type}
    if scope_type == "WikiVault":
        ctx["vault"] = scope_props.get("vault") or scope_props.get("name")
    return ctx
