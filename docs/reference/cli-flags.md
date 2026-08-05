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
| `--wiki` | flag | off | Walks doc files in addition to code. One LLM call per doc produces the `KnowledgeDoc` navigation label — a one-line summary, with the `title` derived mechanically from the filename — and nothing else. A mechanical pass then adds a `MIRRORS` edge to each repo-walked doc's `File` twin (created at link time when the code walk skipped the extension), `LINKS_TO` edges between docs from the authors' own relative links, and an epistemic `status` stamp. **Corpus-only** — doc bodies stay verbatim and are read via `load_source`; nothing is synthesized. Vault name comes from the `VAULT_NAME` positional (or path-derived default). Hard-fails when no LLM key is configured |
| `--global` | flag | off | Vault lives at `~/.opentrace/vaults/` (or `$OT_VAULT_ROOT`) instead of `<cwd>/.opentrace/vaults/`. Only meaningful with `--wiki` |
| `--no-prune` | flag | off | Disable autoprune. By default, re-running over a path removes graph state for docs that disappeared from disk (scope-limited to the walked path / vault) |
| `-v` / `--verbose` | flag | off | Per-file progress events |

!!! note "Removed 2026-08-03 / 2026-08-04"
    `--wiki-concept-pages` and `--refresh-stale-pages` no longer exist. Concept-page synthesis was removed 2026-08-03 after it measured **88.4% against a 98.6% control (−10.2pp)** on the doc-Q&A benchmark; the rest of the layer, including `vault show --page`, went 2026-08-04. Corpus `grep` answers the same cross-document questions with verbatim, pre-labelled lines, and `load_source` reads a body. See the "Closed" section of `agent/src/opentrace_agent/wiki/CLAUDE.md`.

### Common combinations

```bash
# Cheap, fast — code structure only
opentraceai index ./repo

# Index docs into a local vault (labels + doc links, bodies verbatim)
opentraceai index ./docs --wiki                     # vault auto-named
opentraceai index ./docs myvault --wiki             # explicit name

# Compile a global vault visible from other projects
opentraceai index ./papers refs --wiki --global

# Full stack — code + doc corpus + MIRRORS/LINKS_TO edges
opentraceai index ./ myproject --wiki

# Re-walk without destroying orphans
opentraceai index ./repo --wiki --no-prune

# Single URL into a vault
opentraceai index https://arxiv.org/abs/1706.03762 --wiki
```

### Cost-affecting flags

| Flag | LLM cost when set |
|---|---|
| `--wiki` | ~1 call per new doc. Sha dedup skips unchanged docs. The link / twin / status passes are mechanical — 0 |
| All others | 0 |

Pre-flight estimate is printed when any LLM flag is set.

## `opentraceai vault`

Vault management. See [Vault Commands](vault-commands.md) for the conceptual reference.

```
opentraceai vault ingest FOLDER [NAME] [--scope local|global] [--db PATH] [--status X] [...]
opentraceai vault list [--global-only] [--db PATH]
opentraceai vault show NAME [--scope local|global]
opentraceai vault attach NAME [--scope local|global] [--db PATH]
opentraceai vault detach NAME [--db PATH]
opentraceai vault promote NAME
opentraceai vault demote NAME
```

### `vault ingest`

Ingest a bare folder of doc files (a Confluence/Notion/docs-site export — no git repo required) into a corpus-only vault. `NAME` defaults to the folder's name; re-running on the same folder updates the same vault in place.

| Flag | Description |
|---|---|
| `--scope local\|global` | `local` (default) mirrors into the project graph; `global` writes disk-only — attach later with `vault attach` |
| `--db PATH` | Graph DB to mirror into. Auto-discovered if omitted; created at `./.opentrace/index.db` when none exists (local scope only) |
| `--provider X` | LLM provider (anthropic / gemini / openai / kimi / local). Default uses autodetect |
| `--api-key KEY` | Provider API key override |
| `--model NAME` | Model override |
| `--base-url URL` | For `--provider local`, the server's base URL |
| `--status X` | Force an epistemic status (`authoritative` / `design_history` / `design_history_archived`) on every doc, overriding the path heuristic |
| `--exclude-design-history` | Skip proposal/spec/ADR trees and CHANGELOGs instead of labelling them |
| `--no-prune` | Keep vault entries for docs deleted from the folder |
| `-v` | Per-file progress for cheap stages too |

### `vault list`

| Flag | Description |
|---|---|
| `--global-only` | Show every global vault on the machine (regardless of attachment). Default shows locals + globals visible from the current project, with attachment status |
| `--db PATH` | Graph DB. Auto-discovered if omitted |

### `vault show`

Prints the vault's document index — a `Documents:` count, then status / title / one-line summary per doc. Bodies aren't printed; read them with `load_source` or sweep them with `grep`.

| Flag | Description |
|---|---|
| `--scope local\|global` | Disambiguate when a vault exists in both scopes. Local wins by default |

`--page SLUG` was deleted 2026-08-04 with the concept-page layer — see the note under `index` above.

### `vault attach`

| Flag | Description |
|---|---|
| `--scope local\|global` | Disambiguate on name collision |
| `--db PATH` | Graph DB to write the mirror into |

Errors with a list of visible vaults if `NAME` doesn't exist locally or globally.

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
