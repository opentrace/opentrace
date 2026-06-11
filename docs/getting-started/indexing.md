# Indexing

`opentraceai index` is the single command for building a knowledge graph from any input — code, documents, or both. The same command handles a code repo, a folder of papers, a single PDF, or a URL.

## The mental model

The graph holds three layers:

1. **Code layer** — `File`, `Class`, `Function`, `Variable` nodes from tree-sitter. Always produced.
2. **Entity layer** — `Idea` / `Service` / `Module` / `Paper` / `Person` / `Event` nodes from LLM extraction. Produced by `--extract-entities`.
3. **Page layer** — `WikiPage` (file_summary + concept) curated narratives. Produced by `--build-pages`.

Each flag turns on one layer. Combine them freely.

## The commands

### Code only (no LLM)

```bash
opentraceai index ./repo
```

What you get: tree-sitter symbol extraction across supported languages. Doc files (`.md`, `.pdf`, etc.) are skipped. Zero LLM cost.

### Code + entity extraction over docs

```bash
opentraceai index --extract-entities ./repo
```

What happens:

1. Standard code walk (tree-sitter)
2. Doc files (PDF, DOCX, PPTX, XLSX, CSV, HTML, MD, TXT, RST, images via OCR, audio/video via transcription) discovered and converted via markitdown
3. Each doc → `Source` node, body persisted to the scope-appropriate corpus dir (`<project>/.opentrace/corpus/<sha>.md` for local vaults and any compile that mirrors to a graph; `~/.opentrace/corpus/<sha>.md` for `--global` compiles, which `vault attach` later copies into a project)
4. LLM extraction runs over each doc body **and** each code file body → `Idea` / `Service` / `Module` / `Paper` / `Person` / `Event` entity nodes
5. `DERIVED_FROM` edges connect each entity to the file/source it came from
6. `SEMANTIC_EDGE` edges connect entities to each other when the LLM proposes a relationship

Cost: ~1 LLM call per source file. Pre-flight estimate is printed before any call runs.

!!! warning "LLM key required"
    `--extract-entities` hard-fails up front if no API key is configured. See [Wiki Providers](../reference/wiki-providers.md) for the env var → provider mapping.

### Code + curated wiki pages

```bash
opentraceai index --build-pages ./repo myvault
```

Walks docs (same classification as `--extract-entities`), but instead of flat entities, runs the wiki Plan + Execute pipeline:

1. Each doc → `WikiPage(kind="file_summary")` (1 LLM call per source)
2. Plan stage decides which themes deserve a page (1 LLM call)
3. Execute stage writes one `WikiPage(kind="concept")` per theme (1 LLM call per page, typically 5–15 pages)
4. Pages land at `<project>/.opentrace/vaults/myvault/pages/`
5. Graph mirror has `WikiVault` + `WikiPage` + `Source` nodes plus `CONTAINS` / `CITES` / `LINKS_TO` edges

The vault is **local by default** (project-scoped). Pass `--global` for a vault visible to any project. See [Wiki & Vaults](wiki.md) for the full vault model.

### Full stack

```bash
opentraceai index --extract-entities --build-pages ./repo myvault
```

Code structure + flat entities + curated pages + `MENTIONS` edges connecting pages to the entities they discuss. The expensive option — useful when you want the entire cross-cutting view.

## Flag-by-flag reference

### Doc handling

| Flag | What it does |
|---|---|
| `--extract-entities` | Walks docs + runs LLM entity extraction over code AND docs |
| `--build-pages` | Walks docs + runs Plan+Execute curation. Implies a vault |
| `[VAULT_NAME]` (2nd positional) | Override the auto-derived vault name (defaults to path basename / repo name / file stem / URL slug). Implies `--build-pages` when given |
| `--global` | Compile the vault into `~/.opentrace/vaults/` instead of `<cwd>/.opentrace/vaults/`. Only meaningful with `--build-pages`. Disk only — run `vault attach <name>` to mirror into this project's graph |

### Re-indexing & cleanup

| Flag | What it does |
|---|---|
| `--no-prune` | Disable autoprune. Default behaviour removes graph state for sources that disappeared from disk between runs (scope-limited to the walked path/vault) |
| `--refresh-stale-pages` | Regenerate concept pages stamped `stale_since` by autoprune. Only meaningful with `--build-pages` |

### Standard

| Flag | What it does |
|---|---|
| `--db <path>` | Override DB location (auto-discovered via `.opentrace/index.db` walk-up otherwise) |
| `--repo-id <id>` | Override repo identifier (defaults to directory name) |
| `--batch-size <n>` | Tune save batch size; 200 by default |
| `-v` / `--verbose` | Per-file progress events |

## Input shapes

`index` accepts any of:

```bash
opentraceai index ./my-repo                                # directory walk
opentraceai index ./one-file.pdf --extract-entities        # single file
opentraceai index https://arxiv.org/abs/1706.03762 --extract-entities   # URL (fetched via markitdown)
```

arXiv abstract URLs are auto-rewritten to the PDF.

## Autoprune

Default-on for `--extract-entities` and `--build-pages`. When you re-run on a path:

- Sources that walked-set lost since the last run → deleted from graph + corpus body deleted from disk
- Orphaned entities (no remaining `DERIVED_FROM`) → deleted
- `file_summary` page 1:1 with a deleted source → deleted
- `concept` page that cited a deleted source:
    - **Still has other citations** → kept, stamped `stale_since=<timestamp>`. Use `vault refresh-stale-pages` or `index --refresh-stale-pages` to regenerate
    - **No remaining citations** → deleted entirely

Scope is **walk-path-limited** (or vault-limited when `--build-pages` provided a vault). Re-indexing `./papers` doesn't touch sources you ingested from `./transcripts`.

To opt out:

```bash
opentraceai index --extract-entities --no-prune ./repo
```

## What gets created on disk

```
<project>/.opentrace/
  index.db                          # graph database
  index.db.wal                      # write-ahead log
  corpus/<sha>.md                   # per-source markdown bodies (local vaults
                                    #  and attached globals copy here)
  vaults/<name>/                    # local vaults (when --build-pages without --global)
    pages/concept/<base>.md
    pages/file-summary/<base>.md
    .vault.json
    .compile-log/<ts>.json

~/.opentrace/                       # globals — independent of any project
  vaults/<name>/                    # disk vault from `--build-pages --global`
  corpus/<sha>.md                   # raw source bodies for globals not yet
                                    #  attached anywhere; `vault attach` copies
                                    #  these into <project>/.opentrace/corpus/
```

`--build-pages --global` writes the disk vault only — no graph mirror until `vault attach <name>` runs in a project. See [Wiki & Vaults](wiki.md#sharing-a-global-vault-across-projects) for the attach flow.

## Cost model

| Flag combination | LLM cost per re-run |
|---|---|
| `index` | 0 |
| `index --extract-entities` | ~1 LLM call per source file. Sha dedup means unchanged files are free |
| `index --build-pages` | ~1 LLM call per new source + Plan (1) + Execute (~5-15 concept pages) |
| `--extract-entities --build-pages` | Sum of the two |
| `--refresh-stale-pages` | One LLM call per stale page |
| Autoprune | 0 (deletions only) |

Pre-flight estimate is printed when LLM flags are set. Use `--no-prune` if you're partially re-walking and don't want destruction, and `--refresh-stale-pages` only when you're ready to pay for regeneration.

## Examples

```bash
# Index a repo with docs sitting alongside code
opentraceai index --extract-entities --build-pages ./

# Add a paper to an existing global research vault
opentraceai index --build-pages --global ./papers/new-paper.pdf research

# Re-index after adding/removing files; refresh anything pruning marks stale
opentraceai index --build-pages --refresh-stale-pages ./papers research

# Single URL into a quick vault
opentraceai index --build-pages https://arxiv.org/abs/1706.03762

# Code-only structural index (cheapest, fastest)
opentraceai index ./repo
```

## What's next

- **Bring your vault into another graph** → [Wiki & Vaults](wiki.md)
- **Surface gods / bridges / cross-cutting communities** → run `opentraceai cluster` then `opentraceai analyze`
- **Query the graph programmatically** → [Graph Tools](../reference/graph-tools.md)
- **Configure providers** → [Wiki Providers](../reference/wiki-providers.md)
