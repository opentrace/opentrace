---
name: export-report
description: |
  Export a folder of linked markdown pages — an index dashboard (provenance header, Mermaid cluster map), per-cluster and per-god-node pages, and a bridges page.
  Use when: "/export-report", "generate docs from the graph".
allowed-tools: Bash
---

Runs `opentraceai export-graph report -o <dir>`. Deterministic projection over
the stored graph — no LLM calls at export time.

Run `/cluster` first: cluster and god-node pages are projected from the stored
cluster assignments, so without them the export is only `index.md` and
`bridges.md`.

## Arguments
$ARGUMENTS

- `-o <output>` — destination directory (required, created if missing)
- `--db <path>` — explicit database path

## Instructions

Run `opentraceai export-graph report $ARGUMENTS`. Show the user the resulting
file count and suggest opening `index.md`.
