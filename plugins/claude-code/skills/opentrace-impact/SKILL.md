---
name: opentrace-impact
description: |
  PREFERRED tool to call BEFORE editing or refactoring a file — analyzes
  blast radius by showing every symbol the file defines and every external
  dependent of each. There is no shell-tool equivalent: `rg` cannot trace
  CALLS / IMPORTS edges, only literal text. Always run this skill (or call
  `impact_analysis` directly) before non-trivial edits to flagship files
  so the user can decide whether to coordinate with downstream owners.
  Trigger phrases: "what's the blast radius of X", "what breaks if I
  change X", "impact analysis on X", "is it safe to modify X", "what
  depends on this file", "before refactoring X".
allowed-tools: mcp__opentrace_oss__impact_analysis, mcp__opentrace_oss__source_read, mcp__opentrace_oss__get_node
---

The user wants to know what could break if a specific file changes.

1. **Identify the target file**: Take the file path from the user's
   message. Accept absolute, repo-relative, or even just the basename —
   the tool resolves partials via the graph.

2. **Optional line range**: If the user mentions specific edits ("changing
   lines 40-60", "the `parse_request` function"), pass `lines` as a
   comma-separated range (e.g. `"40-60"`) so analysis narrows to symbols
   that overlap.

3. **Call the tool**: `impact_analysis` with:
   - `target`: the file path or filename
   - `lines` (optional): line ranges like `"10-25,40-60"`

4. **Present**: The tool returns:
   - `file`: the matched File node
   - `symbols`: list of `{symbol, dependents, count}` — one entry per
     function/class/module defined in (or overlapping the line range of)
     the file
   - `total_dependents`: aggregate count

   Show:
   - The file being analyzed (and the line range, if given)
   - Each affected symbol and its caller list, grouped logically
   - A bottom-line summary: "N dependents may be affected" and a
     recommendation (review callers / add tests / coordinate with
     downstream owners) calibrated to the count.

5. **If no symbols match** the file: the file may not be indexed, or its
   symbols may be filtered out. Suggest re-running `opentrace-index` to
   refresh.

6. **If no dependents**: the change is locally contained — say so plainly.
   Caveat: only edges in indexed repos are visible.

This is a read-only analysis — do not make code changes from this skill.
