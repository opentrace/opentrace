# CLI

Click-based command-line interface for the `opentraceai` binary. Also hosts the two server modes (REST and MCP) that wrap the underlying graph store.

## Commands

```
main.py          — Click root group; --db override, find_db() discovery
index            — Run the four-stage pipeline against a target path/repo
serve.py         — Starlette HTTP server; REST API consumed by the UI
mcp_server.py    — MCP (Model Context Protocol) server for Claude Code agents
augment.py       — Post-process: add AI summaries to existing graph nodes
bench.py         — SWE-bench / accuracy benchmark runner (see /benchmark)
impact.py        — Blast-radius analysis for a given symbol or file
auth.py          — GitHub token onboarding flows
credentials.py   — Token storage helpers
config.py        — pydantic-settings (env prefix OT_)
export_import.py — Dump and reload graph state for backups / cross-machine moves
```

## Database Discovery

`find_db()` walks up from cwd until it finds `.opentrace/index.db`, stopping at the git root. The walk:

- caps traversal at 10 levels (symlink-loop defense)
- rejects resolved paths that escape the original repo root (symlink-jailbreak defense)
- can be fully bypassed with `--db <path>`

This is a **security boundary** — don't loosen the symlink check casually. If you need to support arbitrary paths, route them through `--db`, not through the discovery logic.

## Server Modes

| Mode | Module | Transport | Consumer | Auth |
|---|---|---|---|---|
| REST | `serve.py` | Starlette HTTP | UI (`ServerGraphStore` in `ui/src/store/`) | None today |
| MCP | `mcp_server.py` | stdio JSON-RPC | Claude Code plugin | OAuth flow (separate) |

REST endpoints: `/api/health`, `/api/stats`, `/api/graph`, `/api/nodes/{id}`, `/api/traverse`, `/api/source/{id}`, `/api/nodes/search`, `/api/nodes/list`, `/api/metadata`. The UI is the contract holder — see `ui/src/store/CLAUDE.md` for the client side.

MCP tools mirror the same operations but with names matching the plugin agents' expectations: `get_stats`, `search_graph`, `list_nodes`, `get_node`, `traverse_graph`. Tool list lives in `claude-code-plugin/CLAUDE.md`.

## Adding a Subcommand

1. New module under `cli/` exporting a `@click.command` (or group)
2. Register on the root group in `main.py`
3. If it needs the DB, accept `--db` and call `find_db(...)` — don't reimplement discovery
4. If it produces long-running output, yield events through `pipeline/types.PipelineEvent` so progress is consistent across CLI / REST / MCP

## Pitfalls

- **REST has no auth.** Anyone with network access to `serve` can read the entire graph. Fine for localhost dev, not for production exposure — document that you're aware before binding non-loopback.
- **MCP `get_stats` may fail under DB lock contention.** The session-start hook in the plugin handles this gracefully; treat lock errors as best-effort, not fatal.
- **`augment` is destructive in spirit.** It updates summary fields in place. Run on a copy if you need the un-summarized graph for debugging.
- **`config.py` settings load eagerly at import time.** Missing required env crashes the CLI before `--help` works — keep required fields to a minimum.
