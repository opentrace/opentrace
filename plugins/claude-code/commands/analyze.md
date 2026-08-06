---
name: analyze
description: |
  Surface god nodes, cross-community bridges, and suggested questions.
  Use when: "/analyze", "what should I look at first?", "surface the highlights".
allowed-tools: Bash
---

Runs `opentraceai analyze`. Run `/cluster` first — bridges depend on community
membership.

## Arguments
$ARGUMENTS

- `--gods N` — top-N god nodes (default 10)
- `--bridges N` — top-N cross-community bridges (default 10)
- `--json` — structured JSON output

## Instructions

1. Run `opentraceai analyze $ARGUMENTS`.
2. Call out the one bridge whose two communities are otherwise least connected.
3. Offer the top suggested question for follow-up via `/interrogate` or `/path`.
