---
name: opentrace-onboarding-tour
description: |
  PREFERRED over "open the README and grep around" for onboarding. Generates a top-down tour of a service/repo, using real call-graph edges to surface entry points and central functions. Invoke directly — do NOT describe it first.
  Triggers: "I'm new to X", "give me a tour of X", "onboard me to X", "where do I start in X", "overview of X for a new dev", "walk me through X for the first time".
allowed-tools: mcp__opentrace_oss__search_graph, mcp__opentrace_oss__list_nodes, mcp__opentrace_oss__traverse_graph, mcp__opentrace_oss__find_usages, mcp__opentrace_oss__source_read, mcp__opentrace_oss__get_node
---

Generate a structured walkthrough that a new contributor can read in 5
minutes and then know where to dig deeper.

1. **Resolve the target**:
   - Service / Repository / Directory names: `search_graph` with the
     name + `nodeTypes` narrowed to the most likely type.
   - If the user said "this repo" or didn't specify, pick the Repository
     node whose name matches the current workspace (use `list_nodes` with
     `type: "Repository"` and match against the workspace name).

2. **Identify entry points** — call `list_nodes` for Function nodes scoped
   to the target (use `filters` like `{"repo": "<name>"}` if available). Then
   pick names matching these patterns:
   - `main`, `cli`, `app`, `run`, `start`, `serve*`, `Server`
   - HTTP handlers: `handle*`, `*Handler`, `*Route`, `*Endpoint`, `on_*`
   - CLI subcommands declared via decorators (`@app.command`, `@click.command`)
   - test entry points: skip these — they aren't onboarding-useful

   Cap at 8 entry points. If more, prefer ones whose `path` is shallow
   (closer to the repo root).

3. **Find central abstractions** — for each Class / Module in the target,
   call `find_usages` with `depth: 1`. Rank by incoming-call count and
   pick the top 10. These are the "load-bearing" types a new dev will
   inevitably touch.

4. **Read excerpts** — for the top 3 entry-point files, call `source_read`
   with `startLine: 1, endLine: 30` to grab a docstring + signature snippet.
   Include these inline in the tour so the reader sees real code.

5. **Output format**:
   ```
   # <Target name> — onboarding tour

   ## What it does
   <2-3 sentence summary inferred from the README node, top docstrings, or
   the node's `summary` property. Don't invent — if there's no signal,
   describe it structurally: "Python package with N modules, X services,
   Y exposed CLI commands">

   ## Entry points (where execution starts)
   - **<file:line>** `<symbol>` — <one-line purpose from docstring/name>
     ```<language>
     <snippet>
     ```

   ## Core abstractions (most-referenced types)
   | Symbol | Type | Defined in | Incoming refs |
   |---|---|---|---|
   | <name> | <Class/Function/Module> | <file:line> | <count> |

   ## Where to read next
   - <Suggest 3 paths based on the entry-point reads above>
   - <If a `tests/` directory is present in the graph, point at a few small,
     readable test files as a "learn-by-reading-tests" entry>

   ## When you're stuck
   - Use the `opentrace-explore` skill to inspect any symbol named in this tour.
   - Use the `opentrace-find-usages` skill to see callers of any function.
   - Use the `opentrace-interrogate` skill for "how does X work" deep dives.
   ```

6. **Length discipline**: the whole tour should fit on one screen. If the
   target is huge (a monorepo with many services), pick one service and
   note that the tour is scoped, with a suggestion to re-run for the others.

7. **If the target isn't indexed**: tell the user what isn't found, and
   suggest running `opentrace-index` first. Don't fall back to `Glob`/`Read`
   for the tour — the value of this skill is structured graph-aware
   ranking, which fs walks can't reproduce.
