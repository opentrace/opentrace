---
name: export-obsidian
description: |
  Export an Obsidian-compatible vault — one .md per node, folder per community.
  Use when: "/export-obsidian", "open this graph in Obsidian".
allowed-tools: Bash
---

Runs `opentraceai export-graph obsidian -o <vault>`. Wikilinks
(`[[other-node]]`) replace edge labels so Obsidian's graph view renders the
structure.

## Arguments
$ARGUMENTS

- `-o <output>` — destination directory (required)
- `--db <path>` — explicit database path

## Instructions

Run `opentraceai export-graph obsidian $ARGUMENTS`. Remind the user that
unassigned nodes land in `_uncategorised/` — run `/cluster` first for a
better folder layout.
