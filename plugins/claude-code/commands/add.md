---
name: add
description: |
  Ingest a URL or document (PDF, Word, EPub, HTML, image, audio, video) into the graph.
  Use when: "/add <url>", "ingest this paper", "add a design doc".
allowed-tools: Bash
---

Runs `opentraceai ingest <path-or-url>`. The document is converted to markdown
via Microsoft `markitdown` and stored as a `Source` node. arXiv abstract URLs
are auto-rewritten to the PDF. X/Twitter URLs are not supported in v1.

## Arguments
$ARGUMENTS

- `<path-or-url>` — file path or http(s) URL

## Instructions

1. Run `opentraceai ingest $ARGUMENTS`.
2. Report the `Source` node ID and markdown-char count.
3. If the resulting Source is substantial (>500 chars), suggest a follow-up
   `/cluster` so the new content lands in a community.
