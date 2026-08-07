---
name: cluster
description: |
  Re-run community detection on the existing index.
  Use when: "re-cluster the graph", "/cluster", "split communities again after re-indexing".
allowed-tools: Bash
---

Runs `opentraceai cluster`. Idempotent — clears existing Community nodes +
memberships before writing fresh ones. Leiden via graspologic with a
deterministic Louvain fallback on Python ≥3.13.

## Arguments
$ARGUMENTS

- `--db <path>` — explicit database path (auto-detected by default)
- `--json` — structured JSON output

## Instructions

1. Run `opentraceai cluster $ARGUMENTS`.
2. Show the resulting community count, god-community count, largest community,
   and mean cohesion.
3. Suggest `/analyze` to surface the highlights.
