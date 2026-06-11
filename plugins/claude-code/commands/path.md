---
name: path
description: |
  Find a shortest path between two graph nodes.
  Use when: "/path A B", "how does X connect to Y?".
allowed-tools: Bash
---

Runs `opentraceai path <source-id> <target-id>`. The graph is treated as
undirected for path-finding.

## Arguments
$ARGUMENTS

- `<source-id> <target-id>` — two node IDs from the graph
- `--max-hops N` — cap the path length (default 6)
- `--json` — structured JSON output

## Instructions

1. If the user gave names rather than IDs, run `opentraceai source-search`
   first to resolve names → IDs.
2. Run `opentraceai path $ARGUMENTS`.
3. Don't just print the node list — for each edge on the path, state what the
   relationship is and what it tells us about how the endpoints depend on
   each other.
