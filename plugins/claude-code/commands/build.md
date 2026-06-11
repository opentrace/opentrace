---
name: build
description: |
  Build a knowledge graph over the current folder (or a path / GitHub URL).
  Runs the native OpenTrace pipeline: index → cluster → analyze.
  Use when: "build the knowledge graph", "/build", "full pipeline on this folder".
allowed-tools: Bash, Read
---

End-to-end native build: `opentraceai index → cluster → analyze`. No external
indexer dependency — all stages are first-class OpenTrace commands.

## Arguments
$ARGUMENTS

Recognised forms:

- `<path>` — default `.`
- `https://github.com/<owner>/<repo>` — uses `opentraceai fetch-and-index`

## Instructions

1. **Resolve target.** If `$ARGUMENTS` looks like a GitHub URL, run
   `opentraceai fetch-and-index <url>`. Otherwise run `opentraceai index <path>`
   (default `.`).

2. **Cluster.** Run `opentraceai cluster` to detect communities (Leiden with
   Louvain fallback) and write Community nodes + memberships back to the DB.

3. **Analyze.** Run `opentraceai analyze --json` to get god nodes,
   cross-community bridges, and suggested questions.

4. **Report.** Show the top god nodes (degree-sorted) and any cross-community
   bridges found. Offer the most interesting suggested question for follow-up.

## Optional follow-ups

- `/export-graphml -o out.graphml` — escape to Gephi/Cytoscape
- `/export-obsidian -o vault/` — Obsidian vault
- `/export-wiki -o wiki/` — linked markdown report folder
- `/watch <path>` — re-index on file change
