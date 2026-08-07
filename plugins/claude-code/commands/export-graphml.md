---
name: export-graphml
description: |
  Export the graph as GraphML (Gephi / yEd / Cytoscape).
  Use when: "/export-graphml", "open this in Gephi".
allowed-tools: Bash
---

Runs `opentraceai export-graph graphml -o <output>`. Includes Community nodes
so downstream tools can render cluster structure alongside the source graph.

## Arguments
$ARGUMENTS

- `-o <output>` — destination `.graphml` path (required)
- `--db <path>` — explicit database path

## Instructions

Run `opentraceai export-graph graphml $ARGUMENTS` and confirm the file was written.
