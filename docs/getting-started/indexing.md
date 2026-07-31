# Indexing

`opentraceai index` is the single command for building a knowledge graph from any input — code, documents, or both. The same command handles a code repo, a folder of papers, a single PDF, or a URL.

## The mental model

The graph holds three layers:

1. **Code layer** — `File`, `Class`, `Function`, `Variable` nodes from tree-sitter. Always produced.
2. **Entity layer** — `Idea` / `Service` / `Module` / `Paper` / `Person` / `Event` nodes from LLM extraction over ingested docs. Produced by `--wiki`.
3. **Doc layer** — labelled `KnowledgeDoc` nodes, linked to each other by the authors' own links and to their `File` twins, bodies kept verbatim in the corpus. Produced by `--wiki`.

One flag turns on both LLM layers: `--wiki`. Synthesized `KnowledgeConcept` pages are a separate opt-in on top: `--wiki-concept-pages`.

## The commands

### Code only (no LLM)

```bash
opentraceai index ./repo
```

What you get: tree-sitter symbol extraction across supported languages. Doc files (`.md`, `.pdf`, etc.) are skipped. Zero LLM cost.

### Code + docs — the wiki layers

```bash
opentraceai index ./repo myvault --wiki
```

What happens:

1. Standard code walk (tree-sitter)
2. Doc files (PDF, DOCX, PPTX, XLSX, CSV, HTML, MD, TXT, RST, images via OCR, audio/video via transcription) discovered and converted via markitdown
3. Each doc → `KnowledgeDoc` node (`corpus::<sha>`), body persisted to the scope-appropriate corpus dir (`<project>/.opentrace/corpus/<sha>.md` for local vaults and any compile that mirrors to a graph; `~/.opentrace/corpus/<sha>.md` for `--global` compiles, which `vault attach` later copies into a project)
4. Every repo-walked doc's KnowledgeDoc gets a `MIRRORS` edge to its `File` twin and a repo-relative `path` property — the corpus layer and the code tree join in one hop. When the code walk didn't create the File node (extensions like `.rst`/`.txt`/`.html`/PDFs), it is created during linking. Docs not from a repo walk (uploads, URLs) have no edge
5. One LLM call per doc emits the KnowledgeDoc's navigation label (`title` + one-line summary), its entity graph (`Idea` / `Service` / `Module` / `Paper` / `Person` / `Event` nodes with `DERIVED_FROM` edges back to the doc, `SEMANTIC_EDGE` between entities), and a concept inventory — no per-doc page is written; the raw body stays in the corpus
6. Every relative link an author wrote between docs becomes a `KnowledgeDoc -LINKS_TO-> KnowledgeDoc` edge — parsed mechanically from markdown links, reference definitions, and HTML anchors, with no LLM involved. This is the doc-side analogue of the code layer's import edges: it records structure the author declared. Links are resolved against the linking doc's own directory (repo-root-relative `/docs/x.md` also works); external URLs, bare `#fragments`, and paths that escape the repo root are dropped, as is anything that doesn't resolve to another indexed doc
7. Each doc is stamped with an epistemic `status` — `authoritative`, `design_history`, or `design_history_archived` — so retrieval can tell current docs from the design record
8. Graph mirror has `KnowledgeVault` + `KnowledgeDoc` nodes plus `CONTAINS` / `MENTIONS` / `LINKS_TO` / `MIRRORS` edges, and a `DOCUMENTS` edge from the `Repository` to the vault it spawned

The result is a labelled, linked, searchable corpus of the documents themselves — **read verbatim** via `load_source`, never rewritten. Nothing is synthesized by default.

The vault is **local by default** (project-scoped). Pass `--global` for a vault visible to any project. See [Wiki & Vaults](wiki.md) for the full vault model.

Cost: ~1 LLM call per doc. Pre-flight estimate is printed before any call runs.

### Adding synthesized concept pages

```bash
opentraceai index ./repo myvault --wiki --wiki-concept-pages
```

This turns the Resolve → Execute → Verify half of the pipeline back on, on top of everything above:

- A Resolve call clusters the per-doc concept inventories into cross-document themes (1 LLM call)
- Execute writes one `KnowledgeConcept(kind="concept")` per theme (~0.5 LLM calls per doc)
- Pages land at `<project>/.opentrace/vaults/myvault/pages/concept/`
- The mirror gains `KnowledgeConcept` nodes, `CITES` edges (page → the KnowledgeDocs it drew from), and page ↔ page `LINKS_TO` from `[[wiki-links]]` in page bodies

It's opt-in because a synthesized page restates its sources in the model's own voice, which can drop their hedges, tense, and attribution — a failure mode the verbatim corpus cannot have. And concept pages have not yet been shown to beat reading the labelled documents directly.

!!! warning "LLM key required"
    `--wiki` hard-fails up front if no API key is configured. See [Wiki Providers](../reference/wiki-providers.md) for the env var → provider mapping.

## Flag-by-flag reference

### Doc handling

| Flag | What it does |
|---|---|
| `--wiki` | Walks docs + runs the doc-ingestion pipeline: one LLM call per doc (navigation label + entity graph + concept inventory), then the mechanical link pass (`MIRRORS` File twins, doc→doc `LINKS_TO`, epistemic `status`). Corpus-only — bodies stay verbatim, nothing is synthesized. Implies a vault |
| `--wiki-concept-pages` | Also synthesize cross-document concept pages: `KnowledgeConcept` nodes, `pages/concept/*.md` bodies on disk, `CITES` edges, page↔page wiki-links. Off by default; only meaningful with `--wiki` |
| `[VAULT_NAME]` (2nd positional) | Override the auto-derived vault name (defaults to path basename / repo name / file stem / URL slug). Implies `--wiki` when given. Names are unique across scopes — a genuinely new vault whose name is already taken (locally *or* globally) is auto-suffixed `-1`, `-2`, …; re-indexing the same repo reuses the vault it made before rather than suffixing again |
| `--global` | Compile the vault into `~/.opentrace/vaults/` instead of `<cwd>/.opentrace/vaults/`. Only meaningful with `--wiki`. Disk only — run `vault attach <name>` to mirror into this project's graph |

### Re-indexing & cleanup

| Flag | What it does |
|---|---|
| `--no-prune` | Disable autoprune. Default behaviour removes graph state for sources that disappeared from disk between runs (scope-limited to the walked path/vault) |
| `--refresh-stale-pages` | Regenerate existing concept pages stamped `stale_since` by autoprune. Only meaningful with `--wiki`, and only does anything when the vault already has pages |

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
opentraceai index ./one-file.pdf --wiki                    # single file
opentraceai index https://arxiv.org/abs/1706.03762 --wiki  # URL (fetched via markitdown)
```

arXiv abstract URLs are auto-rewritten to the PDF.

## Autoprune

Default-on for `--wiki`. When you re-run on a path:

- KnowledgeDocs the walked set lost since the last run → deleted from graph + corpus body deleted from disk
- Orphaned entities (no remaining `DERIVED_FROM` to a surviving KnowledgeDoc) → deleted
- If the vault has concept pages (from `--wiki-concept-pages`), a `concept` page that cited a deleted doc has the dangling `CITES` edge removed, then:
    - **Still has other citations** → kept, stamped `stale_since=<timestamp>`. Use `vault refresh-stale-pages` or `index --refresh-stale-pages` to regenerate
    - **No remaining citations** → deleted entirely

Scope is **walk-path-limited** (or vault-limited when `--wiki` provided a vault). Re-indexing `./papers` doesn't touch docs you ingested from `./transcripts`.

To opt out:

```bash
opentraceai index ./repo --wiki --no-prune
```

## What gets created on disk

```
<project>/.opentrace/
  index.db                          # graph database
  index.db.wal                      # write-ahead log
  corpus/<sha>.md                   # per-doc markdown bodies (local vaults
                                    #  and attached globals copy here)
  vaults/<name>/                    # local vaults (when --wiki without --global)
    pages/concept/<base>.md         # only with --wiki-concept-pages
    .vault.json
    .compile-log/<ts>.json

~/.opentrace/                       # globals — independent of any project
  vaults/<name>/                    # disk vault from `--wiki --global`
  corpus/<sha>.md                   # raw doc bodies for globals not yet
                                    #  attached anywhere; `vault attach` copies
                                    #  these into <project>/.opentrace/corpus/
```

`--wiki --global` writes the disk vault only — no graph mirror until `vault attach <name>` runs in a project. See [Wiki & Vaults](wiki.md#sharing-a-global-vault-across-projects) for the attach flow.

## Cost model

| Flag combination | LLM cost per re-run |
|---|---|
| `index` | 0 |
| `index --wiki` | ~1 LLM call per new doc. Sha dedup means unchanged docs are free. The link / twin / status passes are mechanical — 0 |
| `--wiki-concept-pages` | On top of `--wiki`: ~1 resolve call + ~0.5 synthesis calls per doc |
| `--refresh-stale-pages` | One LLM call per stale page |
| Autoprune | 0 (deletions only) |

Pre-flight estimate is printed when LLM flags are set. Use `--no-prune` if you're partially re-walking and don't want destruction, and `--refresh-stale-pages` only when you're ready to pay for regeneration.

## Examples

```bash
# Index a repo with docs sitting alongside code (corpus-only)
opentraceai index ./ --wiki

# Same, plus synthesized cross-document concept pages
opentraceai index ./ --wiki --wiki-concept-pages

# Add a paper to an existing global research vault
opentraceai index ./papers/new-paper.pdf research --wiki --global

# Re-index after adding/removing files; refresh anything pruning marks stale
opentraceai index ./papers research --wiki --refresh-stale-pages

# Single URL into a quick vault
opentraceai index https://arxiv.org/abs/1706.03762 --wiki

# Code-only structural index (cheapest, fastest)
opentraceai index ./repo
```

## What's next

- **Bring your vault into another graph** → [Wiki & Vaults](wiki.md)
- **Surface gods / bridges / cross-cutting communities** → run `opentraceai cluster` then `opentraceai analyze`
- **Query the graph programmatically** → [Graph Tools](../reference/graph-tools.md)
- **Configure providers** → [Wiki Providers](../reference/wiki-providers.md)
