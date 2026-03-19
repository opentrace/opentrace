---
name: explore-code
description: |
  Explore code structure, architecture, and component relationships using the OpenTrace
  knowledge graph. Use this skill when the user asks about how code is organized,
  what components exist, how things are connected, or wants to understand the codebase.
  Triggers on questions like "how does X work", "what calls X", "show me the architecture",
  "where is X defined", "what services are there", or general codebase exploration.
allowed-tools: mcp__opentrace_oss__search_graph, mcp__opentrace_oss__get_node, mcp__opentrace_oss__traverse_graph, mcp__opentrace_oss__list_nodes, mcp__opentrace_oss__get_stats, Read, Grep, Glob
---

The user wants to explore or understand code structure. Use the OpenTrace knowledge graph to answer their question.

## Query
$ARGUMENTS

## Instructions

Use the OpenTrace MCP tools to investigate. Follow this approach:

1. **Orient** — Call `get_stats` to see what's indexed (node types and counts). This tells you what's available in the graph.

2. **Search** — Use `search_graph` to find nodes matching the user's query. Use `nodeTypes` to filter when appropriate:
   - Architecture questions → "Service,Repository"
   - Code questions → "Class,Function,Module"
   - Data questions → "Database,DBTable"
   - Infrastructure → "Deployment,Cluster,Namespace"

3. **Inspect** — Use `get_node` on the best matches to see full details and neighbors.

4. **Trace** — Use `traverse_graph` to follow relationships:
   - "What calls X?" → `direction: incoming`
   - "What does X depend on?" → `direction: outgoing`
   - "How are X and Y connected?" → traverse from both and find common nodes

5. **Read source** — If nodes have a `path` property and the user needs code details, use `Read` to show the source.

## Response Guidelines

- Lead with a clear, concise answer before showing supporting details
- Show relationships as paths: `ServiceA --CALLS--> ServiceB --READS--> DatabaseC`
- Group related information (structure, dependencies, consumers)
- Offer to drill deeper if the graph reveals more to explore
