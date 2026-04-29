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

"""``opentraceai source-grep`` — regex search over indexed repo file contents.

Where ``source-search`` queries the knowledge graph, this walks the
indexed repos' actual files with ripgrep. It exists because graph
search can't find substrings inside function bodies or matches in
files the indexer didn't model (READMEs, configs, etc.).

The non-trivial part is **resolving where a repo's clone lives on
disk**. The graph stores ``IndexMetadata.repoPath`` — the absolute
path the indexer was pointed at — but that path reflects the
indexing host. When a DB moves machines (Parquet export/import,
shared CI cache, copy across laptops), the stored path won't exist
locally.

For repos cloned via ``fetch-and-index`` the convention is
``<home>/.opentrace/repos/<org>/<name>``. If the stored ``repoPath``
matches that shape, we re-home it under the *current* ``$HOME``
before falling back to the literal value. Repos indexed in place via
``opentrace index <path>`` don't follow the convention; their
``repoPath`` is wherever the user pointed the indexer, and the only
thing we can do on a different machine is fail loudly.

We never silently skip a repo whose clone is missing — that's the
behavior the plugin's prior implementation had, and it produced
plausible-looking "no matches" responses for queries that hadn't
actually run anywhere.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import click

# Cap on per-repo matches before we stop reading rg output. Mirrors
# the plugin's old default. Caller can override via --limit.
_DEFAULT_LIMIT = 50

# Wall-clock cap on a single rg invocation. Prevents a runaway regex
# (catastrophic backtracking) from hanging a hook.
_RG_TIMEOUT_SECONDS = 10

# Marker inserted in the convention path so the rehoming detection
# stays explicit if anyone reads the code looking for it.
_REPOS_DIR_MARKER = (".opentrace", "repos")


def _convention_suffix(repo_path: str) -> tuple[str, ...] | None:
    """If *repo_path* looks like ``<home>/.opentrace/repos/<...>``, return
    the trailing path components after ``.opentrace/repos/``.

    Used to rehome an indexed-host path under the current ``$HOME``.
    Returns ``None`` for repos indexed in place (path doesn't pass
    through the convention directory) and for paths whose suffix
    contains ``..`` segments — those would let a crafted ``repoPath``
    direct the rehome target outside ``$HOME/.opentrace/repos/`` once
    joined.
    """
    parts = Path(repo_path).parts
    for i in range(len(parts) - 1):
        if parts[i : i + 2] == _REPOS_DIR_MARKER:
            tail = parts[i + 2 :]
            if not tail:
                return None
            if any(p == ".." for p in tail):
                return None
            return tail
    return None


def _resolve_clone_path(repo_path: str | None) -> Path | None:
    """Find an existing on-disk path for a repo's clone.

    Strategy:

    1. If *repo_path* matches the ``.opentrace/repos/<...>`` convention,
       try the same suffix under the current ``$HOME`` first. This is
       the rehoming case — DB moved hosts but the convention is
       stable, so the clone exists at the equivalent location locally.
    2. Fall back to the literal stored path. Covers the indexed-in-place
       case (``opentrace index <local-path>``) where the user owns the
       working tree at a path of their choosing.
    3. If neither exists, return ``None`` and let the caller surface
       a per-repo error.
    """
    if not repo_path:
        return None

    suffix = _convention_suffix(repo_path)
    if suffix is not None:
        candidate = Path.home().joinpath(*_REPOS_DIR_MARKER, *suffix)
        if candidate.is_dir():
            return candidate

    literal = Path(repo_path)
    if literal.is_dir():
        return literal

    return None


def _load_repo_paths(
    store: Any, only_repo: str | None
) -> list[tuple[str, str | None]]:
    """Return ``[(repo_id, stored_repoPath_or_None), ...]`` for indexed repos.

    When *only_repo* is set, the list is filtered to that single id (a
    miss is the caller's responsibility — ``_resolve_repo`` handled
    that before we got here). Otherwise every Repository node in the
    graph is included, in id order so output is deterministic.
    """
    metadata_by_id: dict[str, str | None] = {}
    for entry in store.get_metadata():
        rid = entry.get("repoId")
        if isinstance(rid, str) and rid:
            rp = entry.get("repoPath")
            metadata_by_id[rid] = rp if isinstance(rp, str) and rp else None

    pairs: list[tuple[str, str | None]] = []
    if only_repo:
        pairs.append((only_repo, metadata_by_id.get(only_repo)))
        return pairs

    for rid in store.list_repository_ids():
        pairs.append((rid, metadata_by_id.get(rid)))
    return pairs


def _resolve_repo(store: Any, repo_id: str | None) -> str | None:
    """Verify *repo_id* exists as a Repository node id; raise on miss.

    Same contract as ``source-search``'s ``--repo`` resolution — match
    by canonical id, list candidates on miss. Kept as a separate copy
    rather than importing from ``source_search`` to avoid making the
    two modules co-evolve.
    """
    if not repo_id:
        return None

    if store.repository_exists(repo_id):
        return repo_id

    candidates = store.list_repository_ids()
    if candidates:
        raise click.ClickException(
            f"No repo with id {repo_id!r}. Available: {', '.join(candidates)}"
        )
    raise click.ClickException(
        f"No repo with id {repo_id!r} (no Repository nodes are indexed)."
    )


def _run_rg(
    pattern: str,
    repo_id: str,
    repo_root: Path,
    include: str | None,
    max_count: int,
) -> tuple[list[str], bool, str | None]:
    """Spawn ripgrep against *repo_root*; return ``(matches, truncated, error)``.

    Each entry in *matches* is a scrubbed line of the form
    ``[<repo_id>] <repo-relative-path>:<line>:<content>``; lines that
    don't match the expected ``<abs-path>:<line>:<content>`` shape are
    dropped. The docstring promise is that absolute indexing-host
    paths never reach the caller, so anything we can't safely rewrite
    (binary-file notes, permission warnings, malformed lines) is
    filtered out rather than echoed verbatim.

    *max_count* is enforced **per repo** — rg's own ``--max-count`` is
    a per-file cap, so a repo with N matching files would otherwise
    return up to ``N × max_count`` lines. We pass it through as a
    safety bound on per-file work and then truncate the joined result
    to ``max_count`` here. *truncated* is True when more matches
    existed than were returned.
    """
    cmd = [
        "rg",
        "--no-heading",
        "--line-number",
        "--max-count",
        str(max_count),
    ]
    if include:
        cmd.extend(["--glob", include])
    # `--` separator: defends against patterns that begin with `-`
    # being interpreted as an rg flag.
    cmd.append("--")
    cmd.append(pattern)
    cmd.append(str(repo_root))

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=_RG_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return [], False, f"ripgrep timed out after {_RG_TIMEOUT_SECONDS}s."

    # rg exit code 1 means "no matches" — that's a normal outcome,
    # not an error. Anything else (2 = invalid args/regex, 130 =
    # signal, etc.) is a real failure worth surfacing.
    if proc.returncode == 1:
        return [], False, None
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "").strip() or f"rg exit {proc.returncode}"
        return [], False, f"ripgrep failed: {msg}"

    abs_prefix = str(repo_root) + os.sep
    scrubbed: list[str] = []
    for line in proc.stdout.splitlines():
        if not line.startswith(abs_prefix):
            # Anything not starting with `<repo_root>/` is either an
            # rg auxiliary message (binary-file note, etc.) or a path
            # outside the repo (symlink leak). Drop it: the contract
            # is no absolute paths in output.
            continue
        scrubbed.append(f"[{repo_id}] {line[len(abs_prefix):]}")

    truncated = len(scrubbed) > max_count
    if truncated:
        scrubbed = scrubbed[:max_count]
    return scrubbed, truncated, None


def run_source_grep(
    pattern: str,
    db_path: str | None,
    *,
    repo: str | None = None,
    include: str | None = None,
    limit: int = _DEFAULT_LIMIT,
    output_json: bool = False,
) -> None:
    """Entry point for the source-grep subcommand.

    *db_path* must point at an existing index. *repo* optionally
    restricts the search to a single repository (matched by
    canonical id, same contract as ``source-search``'s ``--repo``).
    *include* is a glob passed through to ripgrep's ``--glob`` flag.
    *limit* caps per-repo matches.
    """
    if shutil.which("rg") is None:
        raise click.ClickException(
            "ripgrep ('rg') is not installed or not on PATH. "
            "Install it (e.g. `brew install ripgrep`) and retry."
        )

    from opentrace_agent.store import GraphStore

    store = GraphStore(db_path, read_only=True)
    try:
        resolved_repo = _resolve_repo(store, repo)
        targets = _load_repo_paths(store, resolved_repo)
    finally:
        store.close()

    if not targets:
        if output_json:
            click.echo(
                json.dumps(
                    {
                        "pattern": pattern,
                        "repo": resolved_repo,
                        "limit": limit,
                        "results": [],
                        "errors": [],
                    },
                    indent=2,
                )
            )
        else:
            click.echo("No indexed repositories found. Run `opentrace index` or `opentrace fetch-and-index` first.")
        return

    # [(repo_id, matches, truncated)]
    repo_outputs: list[tuple[str, list[str], bool]] = []
    errors: list[tuple[str, str]] = []  # [(repo_id, message)]

    for repo_id, stored_path in targets:
        clone_root = _resolve_clone_path(stored_path)
        if clone_root is None:
            tried: list[str] = []
            suffix = _convention_suffix(stored_path) if stored_path else None
            if suffix:
                tried.append(str(Path.home().joinpath(*_REPOS_DIR_MARKER, *suffix)))
            if stored_path:
                tried.append(stored_path)
            errors.append(
                (
                    repo_id,
                    "no clone found locally"
                    + (f" (tried: {', '.join(tried)})" if tried else " (no repoPath stored)"),
                )
            )
            continue

        matches, truncated, err = _run_rg(pattern, repo_id, clone_root, include, limit)
        if err:
            errors.append((repo_id, err))
            continue
        if matches:
            repo_outputs.append((repo_id, matches, truncated))

    if output_json:
        _emit_json(pattern, resolved_repo, repo_outputs, errors, limit)
    else:
        _emit_text(pattern, resolved_repo, repo_outputs, errors, limit)


def _emit_text(
    pattern: str,
    repo_id: str | None,
    repo_outputs: list[tuple[str, list[str], bool]],
    errors: list[tuple[str, str]],
    limit: int,
) -> None:
    """Emit human-readable grep output."""
    lines: list[str] = []

    if repo_outputs:
        repo_part = f" in repo {repo_id!r}" if repo_id else ""
        lines.append(f"Grep results for {pattern!r}{repo_part}:")
        lines.append("")
        for rid, matches, truncated in repo_outputs:
            lines.extend(matches)
            if truncated:
                lines.append(
                    f"  ... [{rid}] truncated at {limit} matches per repo "
                    "(rerun with --limit to see more)."
                )
        lines.append("")
        lines.append("Use `opentrace source-read --path <file>` to read a matched file.")
    else:
        repo_part = f" in repo {repo_id!r}" if repo_id else ""
        lines.append(f"No matches for {pattern!r}{repo_part}.")

    if errors:
        # Errors go after results so the matches an LLM cares about
        # appear first in the output, but loudly enough that a
        # caller seeing "no matches" knows whether something was
        # actually skipped.
        lines.append("")
        lines.append("Note: some repos were not searched:")
        for rid, msg in errors:
            lines.append(f"  - [{rid}] {msg}")
        lines.append(
            "  (For cloned repos: ensure they exist under "
            "~/.opentrace/repos/. For locally-indexed repos: re-run "
            "`opentrace index <path>` from the current location.)"
        )

    click.echo("\n".join(lines).rstrip())


def _emit_json(
    pattern: str,
    repo_id: str | None,
    repo_outputs: list[tuple[str, list[str], bool]],
    errors: list[tuple[str, str]],
    limit: int,
) -> None:
    """Emit structured JSON.

    The ``results`` array preserves per-repo grouping so a consumer
    can render its own UI affordances; ``errors`` is non-empty when
    repos were skipped (missing clone, rg failure, ripgrep absent).
    Each result bucket carries a ``truncated`` flag so consumers can
    distinguish "you saw everything" from "we capped at --limit".
    """
    payload = {
        "pattern": pattern,
        "repo": repo_id,
        "limit": limit,
        "results": [
            {
                "repo": rid,
                "truncated": truncated,
                "matches": _parse_rg_matches(matches),
            }
            for rid, matches, truncated in repo_outputs
        ],
        "errors": [{"repo": rid, "message": msg} for rid, msg in errors],
    }
    click.echo(json.dumps(payload, indent=2, default=str))


_RG_LINE = re.compile(r"^\[(?P<repo>[^\]]+)\] (?P<rest>.+)$")


def _parse_rg_matches(matches: list[str]) -> list[dict[str, Any]]:
    """Convert scrubbed rg lines into ``{path, line, text}`` dicts.

    The text-mode pipeline already produces ``[repo] path:line:text``
    rows; for JSON we strip the prefix and split path/line/text. A
    line that doesn't parse (rare; rg's output format is stable) is
    surfaced as ``{path: null, line: null, text: <raw>}`` so no data
    is silently dropped.
    """
    parsed: list[dict[str, Any]] = []
    for line in matches:
        m = _RG_LINE.match(line)
        if not m:
            parsed.append({"path": None, "line": None, "text": line})
            continue
        rest = m.group("rest")
        # rest is "path:line:text"
        parts = rest.split(":", 2)
        if len(parts) == 3:
            path, line_no, text = parts
            try:
                parsed.append({"path": path, "line": int(line_no), "text": text})
                continue
            except ValueError:
                pass
        parsed.append({"path": None, "line": None, "text": rest})
    return parsed
