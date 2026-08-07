# CLI

Click-based command-line interface for the `opentraceai` binary. Also hosts the two server modes (REST and MCP) that wrap the underlying graph store.

## Commands

```
main.py          — Click root group + the unified index command:
                   • code-only walk (plain `index`; no LLM calls)
                   • --wiki [VAULT_NAME] [--global] — unified doc ingestion:
                     ONE LLM call/doc → the KnowledgeDoc's one-line summary;
                     docs are linked to File twins (MIRRORS) and to each other
                     by the authors' own relative links (LINKS_TO), and bodies
                     stay verbatim in the corpus. Corpus-only — nothing is
                     synthesized
                   • --no-prune for cleanup behaviour
vault_cmd.py     — vault ingest / list / show / attach / detach / promote /
                   demote. `vault show` prints the vault's document index
                   (Documents: count, then status / title / one-line summary
                   per doc) — bodies are not printed, read one with
                   `load_source` or sweep them all with `grep`.
                   `vault ingest <folder>` is the docs-only
                   ingestion path: walks a bare folder (no git repo), corpus-only
                   compile, stamps folder-relative `path` + author LINKS_TO edges,
                   but builds NO code tree — no File twins, MIRRORS, or DOCUMENTS.
                   Idempotent re-runs via spawned_from = "dir::<abs folder>";
                   deleted docs are pruned (graph autoprune + meta.sources).
                   Needs no existing project: when find_db comes up empty, a
                   docs-only graph is created at ./.opentrace/index.db.
                   Walks DOC_EXTENSIONS + .json (data-as-docs; ingest-specific —
                   `_ingest_extensions()`); the prune keep-set MUST walk the same
                   extension set as the ingest walk, or a doc ingested under an
                   added extension is pruned on the next run as if it had
                   vanished from disk (`_walk_ingest_files` is the single walker
                   both use). Files skipped by type are REPORTED in the
                   summary, never silent ("14 docs" over a 15-file folder must
                   not read as full coverage)
analyze_cmd.py   — god nodes, bridges, cross-domain bridges, cross-cutting communities
                   (all Community-based; needs `opentraceai cluster` first)
cluster_cmd.py   — community detection (Leiden → Louvain fallback)
export_graph.py  — graphml / obsidian / report exporters (deterministic, no LLM)
serve.py         — Starlette HTTP server; REST API consumed by the UI
mcp_server.py    — MCP (Model Context Protocol) server for agent clients
augment.py       — Post-process: add AI summaries to existing graph nodes
bench.py         — SWE-bench / accuracy benchmark runner; its own console script
                   (`opentraceai-bench`), not an `opentraceai` subcommand
impact.py        — Blast-radius analysis for a given symbol or file
get_node.py      — `get-node`: single node + its 1-hop neighbors
traverse.py      — `traverse`: BFS walk from a starting node
source_search.py — `source-search`: full-text search across the graph
source_grep.py   — `source-grep`: regex sweep over indexed file contents
workspace.py     — Resolves the `--workspace` DB under ~/.opentrace/workspaces/
auth.py          — GitHub token onboarding flows
credentials.py   — Token storage helpers
config.py        — pydantic-settings (env prefix OT_)
export_import.py — Dump and reload graph state for backups / cross-machine moves
```

Doc ingestion routes through ``index --wiki`` or ``vault ingest`` / ``vault attach``; there is no standalone ``ingest`` or ``wiki`` command group.

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
plus `/api/source/*` and the vault routes:

Community analysis (god nodes, bridges, cross-cutting communities, suggested
questions) is deliberately NOT on REST — it is reachable via `opentraceai
analyze`, the MCP tools, and the report exporter. Routes for it existed briefly
to back a `KnowledgeHighlightsPanel` that was never built, and were removed
rather than shipped unconsumed.

- `GET /api/vaults?view=project|global` — project view returns local vaults + globals attached to this project; global view lists every global with an `attached` flag. Document bodies are read as node content through `/api/source/*`; there is no vault-scoped body route.
- `POST /api/vaults/{vault}/compile` — multipart upload. Corpus-only, like every other compile path: documents are indexed, nothing is synthesized. Accepts a `scope` form field (default `local`) and an `on_conflict` form field (`append` default = compile into the named vault in place; `suffix` = new-vault compile, auto-renames `flask` → `flask-1` if the name is taken in either scope). The stream reports the resolved `vault_name` in each event. Globals are written disk-only — no graph mirror. Runs the (blocking) pipeline in a threadpool via a sync-generator body, so concurrent reads (e.g. `GET /api/vaults`) stay responsive; graph writes are serialized against reads with the store lock.
- `POST /api/vaults/{vault}/attach` / `POST /api/vaults/{vault}/detach` — mirror a global vault into this project's graph (and copy its corpus into `<project>/.opentrace/corpus/`) / remove the mirror.
- `POST /api/vaults/{vault}/promote` / `POST /api/vaults/{vault}/demote` — move a vault between scopes on disk and re-mirror its graph `KnowledgeVault` row with the new scope. Promote (local → `~/.opentrace/vaults/`) also seeds the global corpus so the vault is attachable elsewhere; demote (global → `<project>/.opentrace/vaults/`) copies the corpus into the project. REST-only counterparts of `vault promote` / `vault demote`; 400 if already in the target scope, 409 if a vault of that name already exists in the target scope. Optional `?scope=` disambiguates a local/global name collision.
- `DELETE /api/vaults/{vault}?scope=...` — delete from disk (and graph) for the given scope.

MCP tools mirror the same primitives plus `find_cross_cutting_communities`. Tool list lives in `plugins/claude-code/CLAUDE.md`.

"Which documents discuss X" is answered by `grep` (exhaustive, verbatim, pre-labelled). There is no doc→topic edge to traverse.

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
