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
- ``KnowledgeVault`` — the vault's document CORPUS (each member
  KnowledgeDoc's normalized markdown body, resolved via its ``corpus_path``)
  plus its compiled ``pages/`` when the vault has concept pages. The corpus
  sweep is what makes exhaustive content claims possible for an agent whose
  only access is the graph: ranked search finds the best documents, grep
  establishes what's true of EVERY document. Corpus hits arrive joined back
  to their KnowledgeDoc — node id, display path, title, epistemic status —
  and their line numbers refer to the normalized body (exactly what
  ``load_source`` returns).

ripgrep is invoked via ``subprocess.run`` with ``--json`` for structured
output. ``rg`` is expected on ``PATH``; missing-binary cases return a
structured error so the agent can fall back to ``search_graph``.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

from opentrace_agent.store import GraphStore

logger = logging.getLogger(__name__)

DEFAULT_MAX_RESULTS = 200
MAX_RESULTS_CAP = 5000

# Cap subprocess wall-time so a runaway pattern can't hang the MCP server.
RG_TIMEOUT_SEC = 10

# Matches ripgrep's --max-filesize=10M so both engines skip the same files.
_MAX_SCAN_FILESIZE = 10 * 1024 * 1024


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
        ID of a ``Repository`` or ``KnowledgeVault`` node — the node whose
        on-disk content is searched.
    file_filter
        Optional substring; only files whose (display) path contains it are
        searched. For vault corpus hits this matches the document's
        folder/repo-relative path or filename, never the content-addressed
        corpus filename.
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
        Vault-corpus matches additionally carry ``title`` and ``status`` so a
        sweep's hits are triageable without a follow-up read. On failure the
        result has ``mode="error"`` and an ``error`` string explaining why;
        ``matches`` is empty.
    """
    max_results = max(1, min(max_results, MAX_RESULTS_CAP))

    scope_node = _resolve_scope(store, scope_id)
    if scope_node is None:
        return _err(scope_id, _unknown_scope_message(store, scope_id))
    scope_type = scope_node["type"]

    if scope_type == "Repository":
        return _grep_repository(
            store,
            scope_node,
            pattern,
            file_filter=file_filter,
            case_sensitive=case_sensitive,
            max_results=max_results,
        )
    if scope_type == "KnowledgeVault":
        return _grep_vault(
            store,
            scope_node,
            pattern,
            file_filter=file_filter,
            case_sensitive=case_sensitive,
            max_results=max_results,
        )
    return _err(
        scope_id,
        f"unsupported scope type {scope_type!r} — must be Repository or Vault",
    )


def _grep_repository(
    store: GraphStore,
    scope_node: dict[str, Any],
    pattern: str,
    *,
    file_filter: str | None,
    case_sensitive: bool,
    max_results: int,
) -> dict[str, Any]:
    scope_id = scope_node["id"]
    scope_props = scope_node.get("properties") or {}
    local_path = scope_props.get("local_path")
    if not local_path:
        return _err(
            scope_id,
            "Repository has no local_path — re-index from a local "
            "directory to enable grep, or fall back to search_graph",
        )
    root = Path(str(local_path))
    if not root.exists() or not root.is_dir():
        return _err(scope_id, f"scope path is not a directory on disk: {root}")

    raw = _search_files(
        pattern=pattern,
        targets=[str(root)],
        glob=f"*{file_filter}*" if file_filter else None,
        case_sensitive=case_sensitive,
        max_results=max_results,
    )
    matches: list[dict[str, Any]] = []
    for m in raw:
        try:
            rel = str(Path(m["file_path"]).relative_to(root))
        except ValueError:
            rel = m["file_path"]
        matches.append(
            {
                # File node IDs follow ``{repoId}/{path}`` per the indexer convention.
                "node_id": f"{scope_id}/{rel}",
                "file_path": rel,
                "line_number": m["line_number"],
                "line_text": m["line_text"],
                "structural_context": {"scope_type": "Repository"},
            }
        )
    return {"matches": matches, "count": len(matches), "scope": scope_id, "mode": _engine()}


def _grep_vault(
    store: GraphStore,
    scope_node: dict[str, Any],
    pattern: str,
    *,
    file_filter: str | None,
    case_sensitive: bool,
    max_results: int,
) -> dict[str, Any]:
    """Grep a vault's corpus (member docs' normalized bodies) + compiled pages.

    The corpus half is the load-bearing one: membership comes from the
    vault's ``CONTAINS`` edges (the shared, sha-keyed corpus dir may hold
    other vaults' documents), each member resolves through its own
    ``corpus_path`` (the canonical pointer — never parse corpus filenames),
    and every hit is joined back to its KnowledgeDoc so the sweep's output is
    pre-labelled. Docs whose corpus file isn't on this machine (e.g. a
    metadata-only mirror) are skipped rather than failing the sweep.
    """
    scope_id = scope_node["id"]
    vault_name = scope_node["name"] or scope_id.replace("vault::", "", 1)

    # Pages layer — present only for vaults compiled with concept pages.
    # Resolve the vault whichever scope it lives in (local first, then
    # global); the previous global-only lookup silently missed local vaults.
    pages_root: Path | None = None
    try:
        from opentrace_agent.wiki.paths import InvalidVaultName, resolve_vault_scope

        try:
            found = resolve_vault_scope(vault_name)
            if found is not None:
                candidate = found[1] / "pages"
                if candidate.is_dir():
                    pages_root = candidate
        except InvalidVaultName as e:
            return _err(scope_id, f"invalid vault name: {e}")
    except Exception:  # noqa: BLE001 — pages are optional; the corpus can still be swept
        pages_root = None

    # Corpus layer — the vault's member documents.
    db_dir = Path(store.db_path).resolve().parent
    corpus_by_abs: dict[str, dict[str, Any]] = {}
    for r in store.traverse(scope_id, direction="outgoing", max_depth=1, relationship_type="CONTAINS"):
        node = r["node"]
        if node.get("type") != "KnowledgeDoc":
            continue
        nprops = node.get("properties") or {}
        corpus_rel = nprops.get("corpus_path")
        if not corpus_rel:
            continue
        display = nprops.get("path") or nprops.get("filename") or node.get("name") or str(corpus_rel)
        if file_filter and file_filter not in display:
            continue
        abs_path = (db_dir / str(corpus_rel)).resolve()
        if not abs_path.is_file():
            continue
        corpus_by_abs[str(abs_path)] = {
            "node_id": node["id"],
            "display": display,
            "title": nprops.get("title"),
            "status": nprops.get("status"),
        }

    if pages_root is None and not corpus_by_abs:
        return _err(
            scope_id,
            "vault has no on-disk content to grep — no member document bodies "
            "reachable from this DB and no compiled pages. Use search_graph / "
            "load_source instead",
        )

    matches: list[dict[str, Any]] = []

    # Corpus first — the document layer is the reason to grep a vault.
    if corpus_by_abs:
        raw = _search_files(
            pattern=pattern,
            targets=sorted(corpus_by_abs),
            glob=None,  # membership + file_filter already selected the files
            case_sensitive=case_sensitive,
            max_results=max_results,
        )
        for m in raw:
            doc = corpus_by_abs.get(m["file_path"])
            if doc is None:
                continue
            matches.append(
                {
                    "node_id": doc["node_id"],
                    "file_path": doc["display"],
                    "line_number": m["line_number"],
                    "line_text": m["line_text"],
                    "title": doc["title"],
                    "status": doc["status"],
                    "structural_context": {"scope_type": "KnowledgeVault", "vault": vault_name, "layer": "corpus"},
                }
            )
            if len(matches) >= max_results:
                break

    if pages_root is not None and len(matches) < max_results:
        raw = _search_files(
            pattern=pattern,
            targets=[str(pages_root)],
            glob=f"*{file_filter}*" if file_filter else None,
            case_sensitive=case_sensitive,
            max_results=max_results - len(matches),
        )
        for m in raw:
            try:
                rel = str(Path(m["file_path"]).relative_to(pages_root))
            except ValueError:
                rel = m["file_path"]
            slug = rel[: -len(".md")] if rel.endswith(".md") else rel
            matches.append(
                {
                    # Page id is ``<vault>::<slug>``.
                    "node_id": f"{vault_name}::{slug}",
                    "file_path": rel,
                    "line_number": m["line_number"],
                    "line_text": m["line_text"],
                    "structural_context": {"scope_type": "KnowledgeVault", "vault": vault_name, "layer": "pages"},
                }
            )

    return {"matches": matches, "count": len(matches), "scope": scope_id, "mode": _engine()}


def _resolve_scope(store: GraphStore, scope_id: str) -> dict[str, Any] | None:
    """Find the scope node for *scope_id*, accepting a plain NAME as well as an id.

    A vault's node id is ``vault::<name>``, which is not what any discovery
    path hands back: ``list_vaults`` returns bare names. Measured consequence —
    an agent grepped ``scopeId="vault"``, got "scope node not found", called
    ``list_vaults``, used the name it was given, and got the same error again;
    it then abandoned grep and read 21 documents one at a time to answer a
    question one sweep would have answered. A tool whose id format can't be
    discovered from the tools that list its scopes is a tool that doesn't get
    used, so resolve the forms callers actually have.
    """
    node = store.get_node(scope_id)
    if node is not None:
        return node
    # Bare vault name → vault::<name>.
    node = store.get_node(f"vault::{scope_id}")
    if node is not None:
        return node
    # Bare repo name → the Repository node whose name matches.
    try:
        for repo in store.list_nodes("Repository", limit=1000):
            if (repo.get("name") or "") == scope_id:
                return repo
    except Exception:  # noqa: BLE001 — no Repository table in a docs-only graph
        pass
    return None


def _unknown_scope_message(store: GraphStore, scope_id: str) -> str:
    """Explain an unresolvable scope by NAMING the scopes that do exist."""
    options: list[str] = []
    for node_type in ("KnowledgeVault", "Repository"):
        try:
            for n in store.list_nodes(node_type, limit=50):
                options.append(n["id"])
        except Exception:  # noqa: BLE001 — type may not exist in this graph
            continue
    if options:
        return f"scope node not found: {scope_id}. Valid scopes in this graph: {', '.join(sorted(options))}"
    return (
        f"scope node not found: {scope_id}. This graph has no Repository or KnowledgeVault "
        "node to scope a grep to."
    )


def _err(scope_id: str, message: str) -> dict[str, Any]:
    return {"matches": [], "count": 0, "scope": scope_id, "mode": "error", "error": message}


def _engine() -> str:
    """Which scanner backs this call — ``"ripgrep"`` or ``"python"``."""
    return "ripgrep" if shutil.which("rg") else "python"


def _search_files(
    *,
    pattern: str,
    targets: list[str],
    glob: str | None,
    case_sensitive: bool,
    max_results: int,
) -> list[dict[str, Any]]:
    """Regex-scan *targets*, preferring ripgrep and falling back to Python.

    ripgrep is an optional accelerator, NOT a requirement. It used to be
    required, and the consequence was invisible: `rg` is absent from plenty of
    environments (and on the machine this was developed on it existed only as a
    shell function, so ``shutil.which`` never saw it), which made every vault
    grep return "ripgrep not on PATH". The tool that exists to answer
    exhaustiveness questions therefore never ran once in three benchmark runs,
    and the arm fell back to opening documents one at a time. The unit tests
    missed it because they hunt for a vendored `rg` and prepend it to PATH —
    validating a path production could not take.

    A vault corpus is a few dozen small normalized markdown files, so a pure
    Python scan is entirely adequate there; the fallback keeps large repo
    scopes working too, just slower.
    """
    rg = shutil.which("rg")
    if rg is not None:
        return _run_ripgrep(
            rg=rg,
            pattern=pattern,
            targets=targets,
            glob=glob,
            case_sensitive=case_sensitive,
            max_results=max_results,
        )
    return _run_python_scan(
        pattern=pattern,
        targets=targets,
        glob=glob,
        case_sensitive=case_sensitive,
        max_results=max_results,
    )


def _iter_scan_files(targets: list[str], glob: str | None) -> Iterator[Path]:
    """Yield the files a scan should read, expanding directory targets."""
    needle = glob.strip("*") if glob else None
    for t in targets:
        p = Path(t)
        candidates: Iterable[Path] = [p] if p.is_file() else (q for q in p.rglob("*") if q.is_file())
        for f in candidates:
            if needle and needle not in str(f):
                continue
            yield f


def _run_python_scan(
    *,
    pattern: str,
    targets: list[str],
    glob: str | None,
    case_sensitive: bool,
    max_results: int,
) -> list[dict[str, Any]]:
    """ripgrep-free regex scan. Same output shape as :func:`_run_ripgrep`."""
    try:
        rx = re.compile(pattern, 0 if case_sensitive else re.IGNORECASE)
    except re.error as e:
        logger.warning("invalid grep pattern %r: %s", pattern, e)
        return []

    matches: list[dict[str, Any]] = []
    for f in _iter_scan_files(targets, glob):
        try:
            if f.stat().st_size > _MAX_SCAN_FILESIZE:
                continue
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), start=1):
            if rx.search(line):
                matches.append({"file_path": str(f), "line_number": i, "line_text": line.rstrip("\n")})
                if len(matches) >= max_results:
                    return matches
    return matches


def _run_ripgrep(
    *,
    rg: str,
    pattern: str,
    targets: list[str],
    glob: str | None,
    case_sensitive: bool,
    max_results: int,
) -> list[dict[str, Any]]:
    """Spawn ripgrep with ``--json`` over *targets* (dirs and/or files).

    Returns matches whose ``file_path`` is exactly the path ripgrep printed
    (absolute when the target was absolute) — callers relativize or join back
    to their own identity maps.
    """
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
    if glob:
        cmd.extend(["--glob", glob])
    cmd.extend(["--", pattern, *targets])

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
        matches.append(
            {
                "file_path": path,
                "line_number": line_no,
                "line_text": text,
            }
        )
        if len(matches) >= max_results:
            break
    return matches
