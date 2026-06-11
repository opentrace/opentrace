---
name: watch
description: |
  Watch a folder and re-index on file changes.
  Use when: "/watch .", "keep the graph up to date as I code".
allowed-tools: Bash
---

Runs `opentraceai watch <path>`. Debounced filesystem watcher backed by
`watchdog`. Ctrl-C to stop.

## Arguments
$ARGUMENTS

- `<path>` — folder to watch (default `.`)
- `--debounce N` — seconds of quiet before triggering a rebuild (default 2.0)
- `--db <path>` — explicit database path

## Instructions

Launch `opentraceai watch $ARGUMENTS` in the foreground. Tell the user the
debounce window and how to stop the watcher.
