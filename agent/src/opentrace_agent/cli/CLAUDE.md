# CLI

Click-based command-line interface for the `opentraceai` binary. Also hosts the two server modes (REST and MCP) that wrap the underlying graph store.

## Commands

```
main.py          — Click root group + the unified index command:
                   • code-only walk (plain `index`; no LLM calls)
                   • --wiki [VAULT_NAME] [--global] — unified doc ingestion:
                     ONE LLM call/doc → KnowledgeDoc label + entities
                     (Idea/Service/… + edges) + concept inventory, then
                     cross-document concept-page synthesis
                   • --no-prune / --refresh-stale-pages for cleanup behaviour
vault_cmd.py     — vault list / show / attach / detach / promote / demote / refresh-stale-pages
analyze_cmd.py   — god nodes, bridges, cross-domain bridges, cross-cutting communities
cluster_cmd.py   — community detection (Leiden → Louvain fallback)
export_graph.py  — graphml / obsidian / report exporters (deterministic, no LLM)
serve.py         — Starlette HTTP server; REST API consumed by the UI
mcp_server.py    — MCP (Model Context Protocol) server for agent clients
watch.py         — debounced filesystem watcher. SCAFFOLDING: the rebuild
                   callback is a no-op shim until incremental indexing lands
hook.py          — git post-commit hook install/uninstall. SCAFFOLDING: the
                   installed hook calls `index --incremental`, which doesn't
                   exist yet, so it no-ops on every commit
augment.py       — Post-process: add AI summaries to existing graph nodes
bench.py         — SWE-bench / accuracy benchmark runner (see /benchmark)
impact.py        — Blast-radius analysis for a given symbol or file
auth.py          — GitHub token onboarding flows
credentials.py   — Token storage helpers
config.py        — pydantic-settings (env prefix OT_)
export_import.py — Dump and reload graph state for backups / cross-machine moves
```

The standalone ``ingest``, ``wiki compile``, ``wiki backfill``, and ``export-graph wiki`` commands were removed during the ingestion unification — all of those flows now route through ``index`` or ``vault attach``. No backward-compat aliases.

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

REST endpoints (full list in `docs/reference/graph-tools.md`):
`/api/health`, `/api/stats`, `/api/metadata`, `/api/graph`, `/api/nodes/*`, `/api/traverse`,
`/api/retrieval/{search,overview,find_path,find_orphans,find_via_relationship_to_type,count_by,provenance,grep}`,
`/api/communities`, `/api/highlights/{gods,bridges,questions}`, plus `/api/source/*` and the vault routes:

- `GET /api/vaults?view=project|global` — project view returns local vaults + globals attached to this project; global view lists every global with an `attached` flag.
- `GET /api/vaults/{vault}/pages` and `GET /api/vaults/{vault}/pages/{slug:path}` — optional `?scope=local|global` to disambiguate; legacy flat disk layouts are migrated on read.
- `POST /api/vaults/{vault}/compile` — multipart upload; accepts a `scope` form field (default `local`) and an `on_conflict` form field (`append` default = compile into the named vault in place; `suffix` = new-vault compile, auto-renames `flask` → `flask-1` if the name is taken in either scope). The stream reports the resolved `vault_name` in each event. Globals are written disk-only — no graph mirror. Runs the (blocking) pipeline in a threadpool via a sync-generator body, so concurrent reads (e.g. `GET /api/vaults`) stay responsive; graph writes are serialized against reads with the store lock.
- `POST /api/vaults/{vault}/attach` / `POST /api/vaults/{vault}/detach` — mirror a global vault into this project's graph (and copy its corpus into `<project>/.opentrace/corpus/`) / remove the mirror.
- `POST /api/vaults/{vault}/promote` / `POST /api/vaults/{vault}/demote` — move a vault between scopes on disk and re-mirror its graph `KnowledgeVault` row with the new scope. Promote (local → `~/.opentrace/vaults/`) also seeds the global corpus so the vault is attachable elsewhere; demote (global → `<project>/.opentrace/vaults/`) copies the corpus into the project. REST-only counterparts of `vault promote` / `vault demote`; 400 if already in the target scope, 409 if a vault of that name already exists in the target scope. Optional `?scope=` disambiguates a local/global name collision.
- `DELETE /api/vaults/{vault}?scope=...` — delete from disk (and graph) for the given scope.

MCP tools mirror the same primitives plus the cross-cutting helpers (`find_pages_mentioning`, `find_entities_mentioned_by`, `find_cross_cutting_communities`). Tool list lives in `plugins/claude-code/CLAUDE.md`.

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
