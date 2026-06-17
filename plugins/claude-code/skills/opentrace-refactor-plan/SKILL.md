---
name: opentrace-refactor-plan
description: |
  PREFERRED over `rg`-then-open-each-match for any rename/refactor. Produces a structured per-site checklist with paths, line numbers, context snippets, and suggested edit patterns, using real CALLS/IMPORTS edges. Invoke directly — do NOT describe it first.
  Triggers: "plan a refactor of X", "rename X across the codebase", "what would I need to change to refactor X", "all call sites of X with edit suggestions", "draft a refactor plan for X".
allowed-tools: mcp__opentrace_oss__find_usages, mcp__opentrace_oss__source_read, mcp__opentrace_oss__get_node, mcp__opentrace_oss__impact_analysis, mcp__opentrace_oss__keyword_search
---

Produce an actionable rename / refactor plan for the symbol the user named.
This is a planning skill — **do not make code changes from it**. Output is
read for the user to review and act on (manually or via a separate edit
turn).

1. **Resolve the symbol**:
   - Extract the bare name from the user's request.
   - Call `find_usages` with the name; if multiple candidates, use
     `keyword_search` with `nodeTypes` narrowed to disambiguate.
   - Capture the user's intent: rename to what? extract to a new module?
     change signature? — this shapes the "suggested edit" column below.

2. **Walk every call site**: from the `find_usages` result, for each
   `dependent` node:
   - Read its `path` and (if present) `line` / `lineNumber` properties via
     `get_node` if not already on the dependent.
   - Call `source_read` with `startLine = max(1, line - 3)` and
     `endLine = line + 3` to get a 7-line context window. Skip nodes where
     no source is retrievable (deleted file, external dep).

   **Scale cap**: hard limit the per-site `source_read` calls to **30**.
   For a heavily-used symbol with 500+ call sites, 500 sequential MCP
   calls would take minutes and produce an unreadable wall of snippets.
   Instead:
   - Sort call sites by file, then by line.
   - Read snippets for the first 30 sites (preferring file diversity:
     at most 5 snippets per file before moving to the next file).
   - For the remaining sites, list them path:line only — no snippet.
   - In the output header, say: "Showing snippets for 30 of <N> sites.
     Run again with scope=<repo>/<dir>/ to drill into a subset."

3. **Pull the blast radius**: call `impact_analysis` on the file that
   *defines* the symbol. This catches transitively-affected symbols (e.g.
   a renamed method changes the signature of every override; an extracted
   helper changes the line count of every function below it).

4. **Output format**:
   ```
   # Refactor plan: <symbol> → <intended change>

   **Definition**: <file:line> (`<type>`)
   **Direct call sites**: <N>  |  **Transitive dependents**: <M>

   ## Per-site checklist

   ### <repo>/<file>
   - [ ] **L<line>** — `<one-line context snippet>`
         Suggested edit: <pattern>

   ### <next file>
   ...

   ## Risks & verification
   - <Anything from impact_analysis that suggests tests likely to break>
   - <Public API concerns if the defining file is `__init__.py`, `index.ts`, etc.>
   - <Cross-repo callers, with note that all of them must be coordinated>

   ## Suggested test commands
   - <make test / pytest path / npm test, based on file extensions in the plan>
   ```

5. **Grouping**: group call sites by repo, then by file. Inside each file,
   sort by line number. If a file has >10 sites, collapse with a count and
   show the first 5 + last 5.

6. **Suggested edit column**:
   - For a **pure rename**: show the literal `s/old/new/g` form per line.
   - For a **signature change**: show the diff (`- old(a, b)` → `+ new(a, b, c)`).
   - For an **extract**: show "move to `<new module>`, update import to
     `from <new module> import <symbol>`".

7. **End with a "next step"**: suggest the user review the plan and then
   either (a) ask Claude to execute the edits one file at a time, or
   (b) use a sed/codemod script for mechanical renames. Don't initiate the
   edits from this skill.

8. **If the symbol has zero usages**: report that, suggest re-running
   `opentrace-index` on any external callers that live outside the indexed
   tree, and note that the refactor is locally contained.
