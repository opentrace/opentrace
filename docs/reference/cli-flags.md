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
| `VAULT_NAME` | string | auto | Optional second positional. Names the vault for `--wiki`. Default derives from `PATH` — repo basename for git repos, folder basename for plain dirs, file stem for single files, slugified URL path for URLs. **Passing this implies `--wiki`**. Names are unique across scopes: a genuinely new vault whose name is already taken locally or globally is auto-suffixed (`flask` → `flask-1`); re-indexing the same repo reuses the vault it made before instead of suffixing again |

**Flags:**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--db PATH` | path | auto | Database path. Auto-discovered by walking up from cwd looking for `.opentrace/index.db`, stopping at the git root |
| `--repo-id ID` | string | basename | Repository ID stamped on nodes (defaults to directory name) |
| `--batch-size N` | int | 200 | Items per save batch |
| `--wiki` | flag | off | Walks doc files in addition to code. One LLM call per doc produces the `KnowledgeDoc` navigation label, its entity graph (`Idea` / `Service` / `Module` / `Paper` / `Person` / `Event` nodes + `DERIVED_FROM` edges), and a concept inventory. A mechanical pass then adds a `MIRRORS` edge to each repo-walked doc's `File` twin (created at link time when the code walk skipped the extension), `LINKS_TO` edges between docs from the authors' own relative links, and an epistemic `status` stamp. **Corpus-only** — doc bodies stay verbatim and are read via `load_source`; nothing is synthesized. Vault name comes from the `VAULT_NAME` positional (or path-derived default). Hard-fails when no LLM key is configured |
| `--wiki-concept-pages` | flag | off | Also synthesise cross-document concept pages: `KnowledgeConcept` nodes, `pages/concept/*.md` bodies on disk, `CITES` edges to the cited docs, and page ↔ page `LINKS_TO` wiki-links. Off by default — a synthesized page restates its sources in the model's own voice, which can drop their hedges, tense, and attribution, and concept pages have not yet been shown to beat reading the labelled documents directly. Requires `--wiki` (or a `VAULT_NAME` positional) |
| `--global` | flag | off | Vault lives at `~/.opentrace/vaults/` (or `$OT_VAULT_ROOT`) instead of `<cwd>/.opentrace/vaults/`. Only meaningful with `--wiki` |
| `--no-prune` | flag | off | Disable autoprune. By default, re-running over a path removes graph state for docs that disappeared from disk (scope-limited to the walked path / vault) |
| `--refresh-stale-pages` | flag | off | After autoprune, regenerate existing concept pages stamped `stale_since` against their remaining citations. Requires `--wiki` (or a `VAULT_NAME` positional); only does anything for a vault that already has pages |
| `-v` / `--verbose` | flag | off | Per-file progress events |

### Common combinations

```bash
# Cheap, fast — code structure only
opentraceai index ./repo

# Index docs into a local vault (labels + entities + doc links, bodies verbatim)
opentraceai index ./docs --wiki                     # vault auto-named
opentraceai index ./docs myvault --wiki             # explicit name

# Same, plus synthesized cross-document concept pages
opentraceai index ./docs myvault --wiki --wiki-concept-pages

# Compile a global vault visible from other projects
opentraceai index ./papers refs --wiki --global

# Full stack — code + entities + doc corpus + MIRRORS/LINKS_TO/MENTIONS edges
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
| `--wiki` | ~1 call per new doc. Sha dedup skips unchanged docs. The link / twin / status passes are mechanical — 0 |
| `--wiki-concept-pages` | On top of `--wiki`: ~1 resolve call + ~0.5 synthesis calls per doc |
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
