---
name: export-wiki
description: |
  Export a folder of linked markdown pages — an index dashboard (provenance header, Mermaid community map), per-community and per-god-node pages, and a bridges page.
  Use when: "/export-wiki", "generate docs from the graph".
allowed-tools: Bash
---

Runs `opentraceai export-graph wiki -o <dir>`. Pure algorithmic projection
over the stored graph — no LLM calls at export time.

## Arguments
$ARGUMENTS

- `-o <output>` — destination directory (required)
- `--db <path>` — explicit database path

## Instructions

Run `opentraceai export-graph wiki $ARGUMENTS`. Show the user the resulting
file count and suggest opening `index.md`.
