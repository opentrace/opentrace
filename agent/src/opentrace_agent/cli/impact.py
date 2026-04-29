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

"""``opentraceai impact`` — find graph nodes affected by changes to a file.

Given a file path (and optional line ranges), discovers which symbols
(functions, classes) are defined in that file by walking ``File
-DEFINES-> Symbol`` edges, then follows incoming ``CALLS``/``IMPORTS``/
``DEPENDS_ON``/``EXTENDS``/``IMPLEMENTS`` relationships from each symbol
to surface the blast radius.
"""

from __future__ import annotations

import json
import os
from typing import Any

import click

# Relationship types that indicate something *depends on* the changed symbol.
_IMPACT_RELS = frozenset({"CALLS", "IMPORTS", "DEPENDS_ON", "EXTENDS", "IMPLEMENTS"})

# Caps to keep output concise.
_MAX_SYMBOLS = 15
_MAX_CALLERS_PER_SYMBOL = 8
_MAX_TRAVERSE_DEPTH = 2

# Cap on how many sibling candidates we name when an ambiguous match is raised.
_MAX_AMBIGUOUS_CANDIDATES = 10


def _props(node: dict[str, Any]) -> dict[str, Any]:
    """Safely extract a node's properties dict, handling JSON-string storage.

    GraphStore stores ``properties`` as a JSON string on disk but returns a
    dict via most read paths. This helper normalizes both shapes so callers
    can consume a dict unconditionally.
    """
    p = node.get("properties") or {}
    if isinstance(p, str):
        try:
            return json.loads(p)
        except Exception:
            return {}
    return p


def _candidate_relative_paths(store: Any, file_path: str) -> list[str]:
    """Return relative-path variants of *file_path* to try for exact match.

    Stored ``properties.path`` values are repo-relative. When a caller passes
    an absolute path (typical for a plugin hook responding to an edit-tool
    event), we strip any matching repo root from metadata to produce a
    relative candidate. Callers get the raw input last as a last-ditch
    option — it rarely matches but costs nothing to try.
    """
    candidates: list[str] = []
    if os.path.isabs(file_path):
        try:
            metadata = store.get_metadata()
        except Exception:
            metadata = []
        for entry in metadata:
            repo_path = entry.get("repoPath")
            if not repo_path:
                continue
            rp = str(repo_path).rstrip(os.sep)
            if file_path == rp or file_path.startswith(rp + os.sep):
                rel = os.path.relpath(file_path, rp)
                if rel and rel not in candidates:
                    candidates.append(rel)
    if file_path not in candidates:
        candidates.append(file_path)
    return candidates


def _resolve_file_node(store: Any, file_path: str) -> dict[str, Any] | None:
    """Find the File node whose stored relative path matches *file_path*.

    Matching strategies, tried in order:

    1. Exact match against ``properties.path`` for the input, and for any
       relative variant derived by stripping a known repo root (when the
       input is absolute).
    2. Unique-basename match: if exactly one File in the graph ends in
       ``/<basename>``, accept it. Multiple matches raise.

    Returns the matched node, or ``None`` if nothing matches. Raises
    ``click.ClickException`` with the candidate paths listed when the input
    resolves to more than one File — better to surface the ambiguity than
    to silently pick one and attribute dependents to the wrong file.
    """
    for candidate in _candidate_relative_paths(store, file_path):
        matches = store.list_nodes(
            "File",
            filters={"path": candidate},
            limit=_MAX_AMBIGUOUS_CANDIDATES + 1,
        )
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            # Same relative path indexed across multiple repos: dedupe by
            # node id (repo-prefixed) rather than properties.path so the
            # user can tell the duplicates apart.
            ids = sorted(n["id"] for n in matches)
            raise click.ClickException(
                f"Ambiguous match for {file_path!r}: multiple files in the "
                f"graph share the relative path {candidate!r}: "
                f"{ids[:_MAX_AMBIGUOUS_CANDIDATES]}. "
                f"Pass a fully-qualified node id to disambiguate."
            )

    basename = os.path.basename(file_path)
    if basename:
        # Basename fallback runs even when basename == file_path (bare
        # filename input). The exact-match phase above tested
        # properties.path == <input>, which only matches files at a
        # repo root. This phase widens to any file *ending* in the
        # basename, and requires uniqueness.
        fts_candidates = store.search_nodes(basename, node_types=["File"], limit=20)
        basename_matches = [
            n
            for n in fts_candidates
            if _props(n).get("path", "").endswith("/" + basename)
            or _props(n).get("path") == basename
        ]
        if len(basename_matches) == 1:
            return basename_matches[0]
        if len(basename_matches) > 1:
            ids = sorted(n["id"] for n in basename_matches)
            raise click.ClickException(
                f"Ambiguous match for {file_path!r}: multiple files in the "
                f"graph are named {basename!r}: "
                f"{ids[:_MAX_AMBIGUOUS_CANDIDATES]}. "
                f"Pass a repo-relative path to disambiguate."
            )

    return None


def _find_defined_symbols(
    store: Any,
    file_node: dict[str, Any],
    line_ranges: list[tuple[int, int]] | None,
) -> list[dict[str, Any]]:
    """Return Function/Class/Module nodes defined in *file_node*.

    The indexer emits ``File -DEFINES-> Symbol`` edges. From the File's
    perspective those are *outgoing*. (An earlier version of this code
    walked ``incoming`` on the misconception that the schema was
    ``Symbol -DEFINED_IN-> File``; that schema has never existed in the
    graph, which is why impact used to always return zero symbols.)

    File nodes also emit ``IMPORTS`` edges to File/Dependency nodes —
    those happen to be filtered out today by the node-type check below
    (Dependency/File aren't in the symbol set), but we additionally
    gate on ``rel.type == "DEFINES"`` so a future schema addition
    like ``File -REFERENCES-> Function`` can't silently inflate the
    impact-affected symbol set.
    """
    neighbors = store._get_neighbors(file_node["id"], "outgoing")
    symbols: list[dict[str, Any]] = []
    for nb_node, nb_rel in neighbors:
        if nb_rel.get("type") != "DEFINES":
            continue
        if nb_node["type"] not in ("Function", "Class", "Module"):
            continue
        if not _in_line_range(nb_node, line_ranges):
            continue
        symbols.append(nb_node)
        if len(symbols) >= _MAX_SYMBOLS:
            break
    return symbols


def _symbol_label(node: dict[str, Any]) -> str:
    """Short label: Type Name (line range)."""
    props = _props(node)
    start = props.get("start_line")
    end = props.get("end_line")
    if not start:
        return f"{node['type']}: {node['name']}"
    if end and end != start:
        return f"{node['type']}: {node['name']} L{start}-{end}"
    return f"{node['type']}: {node['name']} L{start}"


def _caller_label(node: dict[str, Any], rel: dict[str, Any], depth: int) -> str:
    """One-line caller: <--CALLS-- Name (Type) [depth N]."""
    props = _props(node)
    path = props.get("path", "")
    loc = f"  {path}" if path else ""
    indent = "  " * depth
    return f"    {indent}<--{rel['type']}-- {node['name']} ({node['type']}){loc}"


def _in_line_range(
    node: dict[str, Any],
    line_ranges: list[tuple[int, int]] | None,
) -> bool:
    """Check if a symbol's line range overlaps any of the changed ranges."""
    if not line_ranges:
        return True  # no filter → include all symbols
    props = _props(node)
    start = props.get("start_line")
    end = props.get("end_line")
    if start is None:
        return True  # no line info → include conservatively
    start = int(start)
    end = int(end) if end else start
    for lo, hi in line_ranges:
        if start <= hi and end >= lo:
            return True
    return False


def run_impact(
    file_path: str,
    db_path: str | None,
    line_ranges: list[tuple[int, int]] | None = None,
    *,
    output_json: bool = False,
) -> None:
    """Entry point for the impact subcommand.

    *file_path* is the repo-relative or absolute path of the edited file.
    *line_ranges* optionally narrows which symbols to analyze.
    *db_path* should already be resolved by the caller.
    When *output_json* is True, emit structured JSON instead of human-readable text.
    """
    if not db_path:
        return

    try:
        from opentrace_agent.store import GraphStore
    except Exception:
        return

    try:
        store = GraphStore(db_path, read_only=True)
    except Exception:
        return

    try:
        if output_json:
            _run_json(store, file_path, line_ranges)
        else:
            _run(store, file_path, line_ranges)
    except click.ClickException:
        # User-input errors (e.g., ambiguous match) must surface to the
        # caller; don't swallow them with the generic handler below.
        raise
    except Exception:
        # Best-effort: impact is called from hooks where an unexpected
        # internal error should not crash the consumer.
        pass
    finally:
        try:
            store.close()
        except Exception:
            pass


def _run(
    store: Any,
    file_path: str,
    line_ranges: list[tuple[int, int]] | None,
) -> None:
    """Core logic: find file → find symbols → traverse callers."""
    file_node = _resolve_file_node(store, file_path)
    if file_node is None:
        return

    symbols = _find_defined_symbols(store, file_node, line_ranges)

    if not symbols:
        _print_file_only_impact(store, file_node)
        return

    lines: list[str] = []
    file_props = _props(file_node)
    file_display = file_props.get("path", file_node["name"])
    lines.append(f"[OpenTrace] Impact analysis for {file_display}:")
    if file_display != file_path:
        lines.append(f"  (resolved from {file_path!r})")
    lines.append(f"  {len(symbols)} symbol(s) affected in the graph")
    lines.append("")

    total_callers = 0
    for sym in symbols:
        lines.append(f"  {_symbol_label(sym)}")

        try:
            dependents = store.traverse(
                sym["id"],
                direction="incoming",
                max_depth=_MAX_TRAVERSE_DEPTH,
            )
        except Exception:
            dependents = []

        relevant = [d for d in dependents if d["relationship"]["type"] in _IMPACT_RELS]

        if not relevant:
            lines.append("    (no known callers/dependents)")
        else:
            shown = 0
            for dep in relevant:
                if shown >= _MAX_CALLERS_PER_SYMBOL:
                    remaining = len(relevant) - shown
                    lines.append(f"    ... and {remaining} more")
                    break
                lines.append(_caller_label(dep["node"], dep["relationship"], dep["depth"]))
                shown += 1
                total_callers += 1

        lines.append("")

    if total_callers > 0:
        lines.append(f"  ⚠ {total_callers} dependent(s) may be affected by changes to this file.")
        lines.append("  Consider reviewing these callers for compatibility.")
    else:
        lines.append("  No known dependents found in the graph.")

    output = "\n".join(lines).rstrip()
    if output:
        print(output)


def _run_json(
    store: Any,
    file_path: str,
    line_ranges: list[tuple[int, int]] | None,
) -> None:
    """Emit structured JSON output for machine consumption.

    Shape::

        {
          "requestedFile": "<input path as passed by caller>",
          "file":          "<resolved path in graph, or null if no match>",
          "symbols": [
            {
              "id": "...", "name": "...", "type": "Function",
              "start_line": N, "end_line": M,
              "dependents": [
                {"id": "...", "name": "...", "type": "...",
                 "relationship": "CALLS", "depth": 1, "path": "..."}
              ]
            }
          ],
          "total_dependents": <sum across all symbols>
        }

    ``requestedFile`` always echoes the caller's input so consumers can
    detect when the graph resolved to a different file (e.g. an absolute
    path stripped to a repo-relative form, or a basename-only match).
    """
    file_node = _resolve_file_node(store, file_path)
    if file_node is None:
        print(json.dumps({
            "requestedFile": file_path,
            "file": None,
            "symbols": [],
            "total_dependents": 0,
        }))
        return

    symbols = _find_defined_symbols(store, file_node, line_ranges)

    result_symbols: list[dict[str, Any]] = []
    total_dependents = 0

    for sym in symbols:
        sym_props = _props(sym)
        sym_data: dict[str, Any] = {
            "id": sym["id"],
            "name": sym["name"],
            "type": sym["type"],
            "start_line": sym_props.get("start_line"),
            "end_line": sym_props.get("end_line"),
            "dependents": [],
        }

        try:
            dependents = store.traverse(
                sym["id"],
                direction="incoming",
                max_depth=_MAX_TRAVERSE_DEPTH,
            )
        except Exception:
            dependents = []

        for dep in dependents:
            if dep["relationship"]["type"] in _IMPACT_RELS:
                dep_props = _props(dep["node"])
                sym_data["dependents"].append({
                    "id": dep["node"]["id"],
                    "name": dep["node"]["name"],
                    "type": dep["node"]["type"],
                    "relationship": dep["relationship"]["type"],
                    "depth": dep["depth"],
                    "path": dep_props.get("path"),
                })
                total_dependents += 1

        result_symbols.append(sym_data)

    file_props = _props(file_node)
    print(json.dumps({
        "requestedFile": file_path,
        "file": file_props.get("path") or file_node.get("name"),
        "symbols": result_symbols,
        "total_dependents": total_dependents,
    }, default=str))


def _print_file_only_impact(store: Any, file_node: dict[str, Any]) -> None:
    """When no symbols are indexed, report file-level relationships."""
    neighbors = store._get_neighbors(file_node["id"], "both")

    lines: list[str] = []
    file_props = _props(file_node)
    file_display = file_props.get("path", file_node["name"])
    lines.append(f"[OpenTrace] Impact analysis for {file_display}:")
    lines.append("  (no indexed symbols — showing file-level relationships)")
    lines.append("")

    shown = 0
    for nb_node, nb_rel in neighbors:
        if nb_rel["type"] in _IMPACT_RELS:
            direction = "out" if nb_rel["source_id"] == file_node["id"] else "in"
            arrow = f"--{nb_rel['type']}-->" if direction == "out" else f"<--{nb_rel['type']}--"
            lines.append(f"    {arrow} {nb_node['name']} ({nb_node['type']})")
            shown += 1
            if shown >= 10:
                break

    output = "\n".join(lines).rstrip()
    if output:
        print(output)
