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
(functions, classes) are defined in that file and then walks incoming
relationships (CALLS, IMPORTS, DEPENDS_ON) to surface the blast radius.
"""

from __future__ import annotations

from typing import Any

# Relationship types that indicate something *depends on* the changed symbol.
_IMPACT_RELS = frozenset({"CALLS", "IMPORTS", "DEPENDS_ON", "EXTENDS", "IMPLEMENTS"})

# Caps to keep output concise.
_MAX_SYMBOLS = 15
_MAX_CALLERS_PER_SYMBOL = 8
_MAX_TRAVERSE_DEPTH = 2


def _symbol_label(node: dict[str, Any]) -> str:
    """Short label: Type Name (line range)."""
    props = node.get("properties") or {}
    start = props.get("start_line")
    end = props.get("end_line")
    loc = f" L{start}-{end}" if start else ""
    return f"{node['type']}: {node['name']}{loc}"


def _caller_label(node: dict[str, Any], rel: dict[str, Any], depth: int) -> str:
    """One-line caller: <--CALLS-- Name (Type) [depth N]."""
    props = node.get("properties") or {}
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
    props = node.get("properties") or {}
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
) -> None:
    """Entry point for the impact subcommand.

    *file_path* is the repo-relative or absolute path of the edited file.
    *line_ranges* optionally narrows which symbols to analyze.
    *db_path* should already be resolved by the caller.
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
        _run(store, file_path, line_ranges)
    except Exception:
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

    # --- 1. Find the file node ------------------------------------------------
    # Try searching by path fragment (use the last components for matching)
    file_nodes = store.search_nodes(file_path, node_types=["File"], limit=5)
    if not file_nodes:
        # Fallback: try just the basename
        import os

        basename = os.path.basename(file_path)
        if basename:
            file_nodes = store.search_nodes(basename, node_types=["File"], limit=5)
    if not file_nodes:
        return

    # Pick the best match (prefer exact path suffix match)
    file_node = file_nodes[0]
    for fn in file_nodes:
        props = fn.get("properties") or {}
        node_path = props.get("path", "")
        if node_path.endswith(file_path) or file_path.endswith(node_path):
            file_node = fn
            break

    # --- 2. Find symbols defined in this file ---------------------------------
    # Traverse outgoing from file to find DEFINED_IN relationships
    # (symbols point DEFINED_IN → file, so from the file's perspective it's incoming)
    neighbors = store._get_neighbors(file_node["id"], "incoming")

    symbols: list[dict[str, Any]] = []
    for nb_node, nb_rel in neighbors:
        if nb_node["type"] not in ("Function", "Class", "Module"):
            continue
        if not _in_line_range(nb_node, line_ranges):
            continue
        symbols.append(nb_node)
        if len(symbols) >= _MAX_SYMBOLS:
            break

    if not symbols:
        # No indexed symbols found — still report the file itself
        _print_file_only_impact(store, file_node)
        return

    # --- 3. For each symbol, find what depends on it --------------------------
    lines: list[str] = []
    file_props = file_node.get("properties") or {}
    file_display = file_props.get("path", file_node["name"])
    lines.append(f"[OpenTrace] Impact analysis for {file_display}:")
    lines.append(f"  {len(symbols)} symbol(s) affected in the graph")
    lines.append("")

    total_callers = 0
    for sym in symbols:
        lines.append(f"  {_symbol_label(sym)}")

        # Walk incoming relationships (things that call/import/depend on this)
        try:
            dependents = store.traverse(
                sym["id"],
                direction="incoming",
                max_depth=_MAX_TRAVERSE_DEPTH,
            )
        except Exception:
            dependents = []

        # Filter to impact-relevant relationships
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


def _print_file_only_impact(store: Any, file_node: dict[str, Any]) -> None:
    """When no symbols are indexed, report file-level relationships."""
    neighbors = store._get_neighbors(file_node["id"], "both")

    lines: list[str] = []
    file_props = file_node.get("properties") or {}
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
