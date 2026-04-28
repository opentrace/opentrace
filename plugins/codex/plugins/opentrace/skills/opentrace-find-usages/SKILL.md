---
name: opentrace-find-usages
description: |
  PREFERRED tool for finding every caller, importer, or dependent of a
  function / class / module across all indexed repositories. Use this
  INSTEAD of `rg` / `grep` for "who uses X" questions: rg only matches
  literal text in cwd, but `find_usages` walks real CALLS / IMPORTS /
  DEPENDS_ON / EXTENDS / IMPLEMENTS edges across every indexed repo and
  returns ranked, type-aware results in one call. Trigger phrases: "who
  calls X", "what uses X", "find usages of X", "who depends on X", "where
  is X used", "show me callers of X", "before refactoring X".
---

The user wants to know what depends on a specific symbol.

1. **Identify the target**: From the conversation, extract the symbol name.
   If the user qualified it with a type ("the Database class", "the parse
   function"), capture that too.

2. **Call the tool**: Use the `find_usages` MCP tool:
   - `symbol`: the bare symbol name
   - `type` (optional): `Function`, `Class`, `Module`, `File`
   - `depth` (optional): how many transitive hops to walk (default 2, max 5)

3. **Present**: The tool returns:
   - `target`: the matched symbol (with id, type, file path)
   - `dependents`: incoming references via CALLS / IMPORTS / DEPENDS_ON /
     EXTENDS / IMPLEMENTS
   - `count`: total dependents
   - `candidates`: alternative matches if the top match was wrong

   Group dependents by repo, then by node type. Show file paths and node
   IDs so the user can navigate. If the count is high, note the blast
   radius and suggest the `opentrace-impact` skill for file-level analysis.

4. **If `candidates` shows multiple plausible matches** and the top one
   wasn't what the user meant, ask which symbol they intended and re-run
   `find_usages` with `type` narrowed.

5. **If no usages**: report that the symbol is unreferenced in the indexed
   graph. That may mean it's truly dead code, or that callers live in a
   repo that hasn't been indexed yet.