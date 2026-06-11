---
name: hook
description: |
  Manage the OpenTrace post-commit git hook (install/uninstall/status).
  Use when: "/hook install", "/hook status", "auto-reindex after every commit".
allowed-tools: Bash
---

Runs `opentraceai hook {install,uninstall,status}`. The installed hook calls
`opentraceai index --incremental` after each commit. Failures are non-fatal —
your commit succeeds even if indexing breaks.

## Arguments
$ARGUMENTS

- `install` | `uninstall` | `status`
- `--repo <path>` — repo root (defaults to cwd)

## Instructions

1. Run `opentraceai hook $ARGUMENTS`.
2. On `install`, confirm the hook path and remind the user that the installer
   refuses to overwrite a hand-authored `post-commit`.
