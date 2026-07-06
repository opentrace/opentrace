# CLI Flag Reference

Detailed reference for every flag on the commands that have substantial surface area. For the conceptual walkthroughs, see [Indexing](../getting-started/indexing.md) and [Wiki & Vaults](../getting-started/wiki.md).

## `opentraceai index`

The unified ingestion command. Walks a path and builds the knowledge graph.

```
opentraceai index [PATH] [OPTIONS]
```

### Argument

| Argument | Default | Description |
|---|---|---|
| `PATH` | `.` | Directory, single file, or URL (arXiv abstract / web / YouTube transcript via markitdown). Must be readable from disk for directories and files |

### Options

**Positionals:**

| Arg | Type | Default | Description |
|---|---|---|---|
| `PATH` | path or URL | `.` | What to index — a directory, a single file, or a URL |
| `VAULT_NAME` | string | auto | Optional second positional. Names the vault for `--wiki`. Default derives from `PATH` — repo basename for git repos, folder basename for plain dirs, file stem for single files, slugified URL path for URLs. **Passing this implies `--wiki`** |

**Flags:**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--db PATH` | path | auto | Database path. Auto-discovered by walking up from cwd looking for `.opentrace/index.db`, stopping at the git root |
| `--repo-id ID` | string | basename | Repository ID stamped on nodes (defaults to directory name) |
| `--batch-size N` | int | 200 | Items per save batch |
| `--wiki` | flag | off | Walks doc files in addition to code. One LLM call per doc produces the `CorpusDoc` navigation label, its entity graph (`Idea` / `Service` / `Module` / `Paper` / `Person` / `Event` nodes + `DERIVED_FROM` edges), and a concept inventory; Plan + Execute then synthesise cross-document `WikiPage` nodes + bodies on disk under a vault. Every repo-walked doc gets a `MIRRORS` edge to its `File` twin (created at link time when the code walk skipped the extension). Vault name comes from the `VAULT_NAME` positional (or path-derived default). Hard-fails when no LLM key is configured |
| `--global` | flag | off | Vault lives at `~/.opentrace/vaults/` (or `$OT_VAULT_ROOT`) instead of `<cwd>/.opentrace/vaults/`. Only meaningful with `--wiki` |
| `--no-prune` | flag | off | Disable autoprune. By default, re-running over a path removes graph state for docs that disappeared from disk (scope-limited to the walked path / vault) |
| `--refresh-stale-pages` | flag | off | After autoprune, regenerate concept pages stamped `stale_since` against their remaining citations. Requires `--wiki` (or a `VAULT_NAME` positional) |
| `-v` / `--verbose` | flag | off | Per-file progress events |

### Common combinations

```bash
# Cheap, fast — code structure only
opentraceai index ./repo

# Compile a local curated vault from docs (labels + entities + pages)
opentraceai index ./docs --wiki                     # vault auto-named
opentraceai index ./docs myvault --wiki             # explicit name

# Compile a global vault visible from other projects
opentraceai index ./papers refs --wiki --global

# Full stack — code + entities + pages + MIRRORS/MENTIONS edges
opentraceai index ./ myproject --wiki

# Re-build a vault, regenerate stale pages in the same run
opentraceai index ./papers research --wiki --refresh-stale-pages

# Re-walk without destroying orphans
opentraceai index ./repo --wiki --no-prune

# Single URL into a vault
opentraceai index https://arxiv.org/abs/1706.03762 --wiki
```

### Cost-affecting flags

| Flag | LLM cost when set |
|---|---|
| `--wiki` | ~1 call per new doc + Plan (1) + Execute (~5–15 concept pages). Sha dedup skips unchanged docs |
| `--refresh-stale-pages` | 1 call per stale page being regenerated |
| All others | 0 |

Pre-flight estimate is printed when any LLM flag is set.

## `opentraceai vault`

Vault management. See [Vault Commands](vault-commands.md) for the conceptual reference.

```
opentraceai vault list [--global-only] [--db PATH]
opentraceai vault show NAME [--scope local|global] [--page SLUG]
opentraceai vault attach NAME [--scope local|global] [--db PATH]
opentraceai vault detach NAME [--db PATH]
opentraceai vault promote NAME
opentraceai vault demote NAME
opentraceai vault refresh-stale-pages [NAME] [--db PATH] [--provider X]
```

### `vault list`

| Flag | Description |
|---|---|
| `--global-only` | Show every global vault on the machine (regardless of attachment). Default shows locals + globals visible from the current project, with attachment status |
| `--db PATH` | Graph DB. Auto-discovered if omitted |

### `vault show`

| Flag | Description |
|---|---|
| `--scope local\|global` | Disambiguate when a vault exists in both scopes. Local wins by default |
| `--page SLUG` | Print one page body to stdout instead of the index |

### `vault attach`

| Flag | Description |
|---|---|
| `--scope local\|global` | Disambiguate on name collision |
| `--db PATH` | Graph DB to write the mirror into |

Errors with a list of visible vaults if `NAME` doesn't exist locally or globally.

### `vault refresh-stale-pages`

Takes an optional positional `NAME` to scope to one vault; without it, refreshes every stale page in the graph.

| Flag | Description |
|---|---|
| `--db PATH` | Graph DB |
| `--provider X` | LLM provider (anthropic / gemini / openai / kimi / local). Default uses autodetect |
| `--api-key KEY` | Provider API key override |
| `--model NAME` | Model override |
| `--base-url URL` | For `--provider local`, the server's base URL |

## `opentraceai cluster`

Run community detection over the graph.

```
opentraceai cluster [--db PATH] [--json]
```

| Flag | Description |
|---|---|
| `--db PATH` | Graph DB |
| `--json` | Output a structured summary instead of human-readable text |

Idempotent — clears existing Community nodes + memberships before writing fresh ones. Uses Leiden when `graspologic` is available, Louvain otherwise.

## `opentraceai analyze`

Surface god nodes, bridges, cross-domain bridges, and cross-cutting communities.

```
opentraceai analyze [--db PATH] [--gods N] [--bridges N] [--json]
```

| Flag | Description |
|---|---|
| `--db PATH` | Graph DB |
| `--gods N` | Top-N god nodes to surface (default 10) |
| `--bridges N` | Top-N cross-community bridges to surface (default 10) |
| `--json` | Output structured JSON with `gods`, `bridges`, `cross_domain_bridges`, `cross_cutting_communities`, `questions` |

Run `cluster` first — bridges + cross-cutting communities depend on community membership.

## `opentraceai export-graph`

Three deterministic exporters — no LLM at export time.

```
opentraceai export-graph graphml  -o FILE [--db PATH]
opentraceai export-graph obsidian -o DIR [--db PATH]
opentraceai export-graph report   -o DIR [--db PATH]
```

| Format | Output |
|---|---|
| `graphml` | Single `.graphml` file (Gephi, yEd, Cytoscape) |
| `obsidian` | Markdown vault — one `.md` per node, folders by community, `[[wikilinks]]` for edges |
| `report` | Folder of linked markdown pages — an `index.md` dashboard (provenance + Mermaid community map), per-community and per-god-node pages, and a `bridges.md` of community- and domain-crossing edges |

## `opentraceai serve` / `opentraceai mcp`

| Flag (both) | Description |
|---|---|
| `--db PATH` | Graph DB |
| `-v` / `--verbose` | Debug logging |

`serve` additionally:

| Flag | Default | Description |
|---|---|---|
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `8787` | Bind port |

`serve` exposes REST + SSE; `mcp` speaks MCP over stdio (used by the Claude Code plugin).

## `opentraceai watch`

Re-index when files change.

!!! warning "Not wired up yet"
    The watcher detects and debounces changes, but the rebuild callback is
    a no-op until incremental indexing lands — nothing is re-indexed today.

```
opentraceai watch PATH [--debounce SECONDS] [--db PATH]
```

| Flag | Default | Description |
|---|---|---|
| `PATH` | required | Directory to watch |
| `--debounce` | 2.0 | Seconds to batch filesystem events before re-running the index |
| `--db PATH` | auto | Graph DB |

Requires the `graph-watch` extra.

## `opentraceai hook`

Install / uninstall a git post-commit hook that runs `opentraceai index --incremental` after each commit.

```
opentraceai hook install
opentraceai hook uninstall
opentraceai hook status
```

The hook is a single-line shell wrapper; runs nothing if `opentraceai` isn't on `PATH`. Failures are non-fatal — the commit succeeds even if indexing breaks.

!!! warning "Not wired up yet"
    `index --incremental` doesn't exist yet, so the installed hook is a safe
    no-op on every commit until it ships. Install/uninstall/status work as
    described.

## Environment variables

| Variable | Effect |
|---|---|
| `OT_VAULT_ROOT` | Override the global vault root (default `~/.opentrace/vaults/`) |
| `OT_LOCAL_LLM_URL` / `OLLAMA_BASE_URL` | Base URL for `--provider local` |
| `OT_LLM_TIMEOUT` | Per-LLM-call timeout in seconds |
| `OT_LLM_MODEL_ANTHROPIC` | Override Anthropic's default model |
| `OT_LLM_MODEL_GEMINI` | Override Gemini's default model |
| `OT_LLM_MODEL_OPENAI` | Override OpenAI's default model |
| `OT_LLM_MODEL_KIMI` | Override Kimi's default model |
| `OT_LLM_MODEL_LOCAL` | Override the local default model |
| `ANTHROPIC_API_KEY` | Auto-detect Anthropic |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Auto-detect Gemini |
| `OPENAI_API_KEY` | Auto-detect OpenAI |
| `MOONSHOT_API_KEY` | Kimi key (not auto-detected; pass `--provider kimi`) |
