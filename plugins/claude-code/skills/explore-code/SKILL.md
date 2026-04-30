---
name: explore-code
description: |
  Explore code structure, architecture, files, directories, and component relationships using
  the OpenTrace knowledge graph. Use this skill for ANY question about the codebase that the
  graph might answer — including browsing, searching, and understanding code organization.

  Triggers on:
  - Structure: "how does X work", "what calls X", "show me the architecture", "where is X defined"
  - Browsing: "what's in X", "show me X", "look at X", "list the files in X", "what directories are there"
  - Discovery: "find X", "what examples exist", "what services/classes/files are there"
  - Exploration: "walk me through X", "give me an overview", "help me understand X"
  - General: any question about repo structure, code organization, or component relationships
allowed-tools: mcp__opentrace_oss__search_graph, mcp__opentrace_oss__get_node, mcp__opentrace_oss__traverse_graph, mcp__opentrace_oss__list_nodes, mcp__opentrace_oss__get_stats, Read, Grep, Glob
---

The user wants to explore or understand something about the codebase. Use the OpenTrace knowledge graph to answer their question.

## Query
$ARGUMENTS

## Instructions

Use the OpenTrace MCP tools to investigate. Follow this approach:

1. **Orient** — Call `get_stats` to see what's indexed (node types and counts). This tells you what's available in the graph.

2. **Search** — Use `search_graph` to find nodes matching the user's query. Use `nodeTypes` to filter when appropriate:
   - Architecture questions → "Service,Repository"
   - Code questions → "Class,Function,Module"
   - File/directory browsing → "File,Directory"
   - Data questions → "Database,DBTable"
   - Infrastructure → "Deployment,Cluster,Namespace"
   - Unsure → omit `nodeTypes` to search everything

3. **Inspect** — Use `get_node` on the best matches to see full details and neighbors.

4. **Trace** — Use `traverse_graph` to follow relationships:
   - "What calls X?" → `direction: incoming`
   - "What does X depend on?" → `direction: outgoing`
   - "What's in X?" → `direction: outgoing` (CONTAINS relationships)
   - "How are X and Y connected?" → traverse from both and find common nodes

5. **List** — Use `list_nodes` when the user wants to see all items of a type (e.g. all services, all files in a directory).

6. **Read source** — If nodes have a `path` property and the user needs code details, use `Read` to show the source.

## Response Guidelines

- Lead with a clear, concise answer before showing supporting details
- Show relationships as paths: `ServiceA --CALLS--> ServiceB --READS--> DatabaseC`
- Group related information (structure, dependencies, consumers)
- Offer to drill deeper if the graph reveals more to explore
- If the graph doesn't have the data, say so and fall back to `Glob`/`Grep`/`Read`
