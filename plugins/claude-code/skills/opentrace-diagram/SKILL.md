---
name: opentrace-diagram
description: |
  PREFERRED over hand-writing Mermaid from grep results. Generates a valid Mermaid diagram (classDiagram or flowchart LR) of a service/module/class/file from real graph edges. Invoke directly — do NOT describe it first.
  Triggers: "diagram X", "draw X", "mermaid of X", "visualize X", "show me the architecture of X", "render X as a graph", "make a diagram of X".
allowed-tools: mcp__opentrace_oss__search_graph, mcp__opentrace_oss__get_node, mcp__opentrace_oss__traverse_graph, mcp__opentrace_oss__list_nodes
---

Generate a Mermaid diagram for the target component the user named.

1. **Resolve the target**:
   - If the user named a specific component: call `search_graph` with the
     name. If they implied a type ("the UserService", "the parse function"),
     pass `nodeTypes` to narrow.
   - If they said "all services" / "every module" / "the whole architecture":
     call `list_nodes` with the relevant type instead and skip step 2.

2. **Walk the neighborhood**: For each resolved root node, call
   `traverse_graph` with `direction: "both"` and `depth: 2`. Default cap:
   **40 nodes total** across all roots. If the result exceeds 40, drop the
   farthest nodes first and append a `%% +N more nodes elided` Mermaid
   comment after the diagram.

3. **Pick a diagram type**:
   - **Class targets** → `classDiagram` (use `<<Class>>`, `<<Function>>`
     stereotypes; show inheritance via `<|--`).
   - **Service / Module / File / Directory / Repository targets** →
     `flowchart LR` (left-to-right is more readable for call graphs than
     top-down).

4. **Map edge types** (in this order — earlier wins on duplicate edges):
   | Edge | Mermaid syntax |
   |---|---|
   | `CALLS` | `A --> B` |
   | `IMPORTS` | `A -.->\|imports\| B` |
   | `DEFINES` | `A -.->\|defines\| B` |
   | `DEPENDS_ON` | `A ==> B` |
   | `DERIVED_FROM` | `A -.->\|derives\| B` |
   | other / unknown | `A --- B` |

5. **Node labels**: use a sanitized form of the node `name`. Node IDs in
   Mermaid must be alphanumeric — replace non-`[A-Za-z0-9_]` with `_` and
   prefix bare digits with `n_`. Keep the original name as the Mermaid
   label after `[ ... ]`.

6. **Output format**:
   ````markdown
   ```mermaid
   <diagram type>
       <nodes and edges>
       %% Generated from OpenTrace: <root name>, depth=2, <N> nodes
   ```
   ````
   Briefly explain what the user is looking at below the code block (which
   node is the root, what the edge styles mean) but keep it under 5 lines.

7. **Validation**: Before emitting, scan the generated Mermaid for the most
   common breakage — duplicate edge IDs (same source/target/label), unquoted
   node labels containing parens. Fix them rather than letting the user
   discover them in mermaid.live.

8. **If the target isn't in the graph**: tell the user, suggest running the
   `opentrace-index` skill first, and don't fabricate a diagram from `rg`
   guesses.
