# Wiki & Vaults

A **vault** is a folder of LLM-curated markdown pages compiled from any input — papers, design docs, transcripts, notebooks. Vault pages are linked to each other via `[[wiki-link]]` syntax and mirrored into the same knowledge graph as your code, so retrieval tools can pull from both surfaces.

Vaults are produced by the same `opentraceai index` command that handles code — no separate compile step. Pass `--wiki` and you get a vault.

## Prerequisites

- `opentraceai` installed — see the [CLI install guide](install-cli.md)
- The `graph` extra installed (`uv tool install opentraceai[graph]` or via the install guide), for markitdown + LLM SDKs
- An LLM key from one of the [supported providers](../reference/wiki-providers.md), **or** a local OpenAI-compatible server (Ollama, llama.cpp, vLLM)

## Compile your first vault

```bash
# Single folder of docs → local vault
opentraceai index ./papers --wiki
```

What happens:

1. The walker discovers PDF / DOCX / Markdown / HTML / etc. under `./papers`
2. Each doc is converted to markdown via markitdown, body persisted to the scope-appropriate corpus dir (`<project>/.opentrace/corpus/<sha>.md` for local vaults, `~/.opentrace/corpus/<sha>.md` for globals)
3. One LLM call per doc labels the `CorpusDoc` node with a navigation label (a `title` derived from the filename + a one-line summary) and extracts its entity graph and concept inventory. No per-doc page is written — the raw body stays in the corpus, readable via the `load_source` tool
4. A `Plan` LLM call identifies concept-level themes across docs. A theme needs at least 2 supporting docs (`OT_WIKI_CONCEPT_MIN_SOURCES`) to get a page — single-doc content stays reachable through its labelled CorpusDoc node, so paging it would just duplicate the doc
5. An `Execute` LLM call writes one `Page(kind="concept")` per theme, each citing its CorpusDocs directly via `CITES` edges
6. The result lives at `<project>/.opentrace/vaults/papers/pages/` and is mirrored into this project's graph. Globals are written to disk only — mirror with an explicit `vault attach` (see below).

Inspect it:

```bash
opentraceai vault list                          # local + global vaults visible here
opentraceai vault show papers                   # page index for one vault
opentraceai vault show papers --page concept/<base>   # one page body to stdout
```

## Vault scopes — local vs global

Vaults can live in two places:

=== "Local (default)"

    Lives at `<project>/.opentrace/vaults/<name>/`. Visible only to graphs in that project. Best when the vault is tied to a specific codebase or initiative.

    ```bash
    opentraceai index ./papers research --wiki
    # → <cwd>/.opentrace/vaults/research/
    ```

=== "Global"

    Lives at `~/.opentrace/vaults/<name>/` (or `$OT_VAULT_ROOT`). Visible from any project — attach it into one or more graphs via `vault attach`. Best for personal knowledge that travels across repos.

    ```bash
    opentraceai index ./papers research --wiki --global
    # → ~/.opentrace/vaults/research/         (disk only — no graph mirror)

    opentraceai vault attach research          # mirror into this project's graph
    ```

    Compiling a global produces a **disk-only** artifact. Mirroring into a project's graph is a separate, explicit `vault attach` (zero LLM cost — just re-reads disk and copies the doc corpus into `<project>/.opentrace/corpus/`).

When both a local and a global vault share a name, the local one wins by default. Use `--scope global` on commands that take a name (e.g. `vault show research --scope global`) to disambiguate.

## Adding to an existing vault

Re-running `index <path> NAME --wiki` against the same vault is incremental:

- Docs whose sha256 already exists in the vault are skipped (no LLM call)
- New docs get labelled and extracted (one LLM call each)
- Plan reconsiders the corpus and may extend existing concept pages or create new ones

```bash
opentraceai index ./papers research --wiki
opentraceai index ./transcripts research --wiki        # adds to research, not a new vault
opentraceai index https://arxiv.org/abs/1706.03762 research --wiki
```

## Sharing a global vault across projects

Compile once, attach from anywhere:

```bash
# In ~/code/project-a:
opentraceai index ./papers research --wiki --global
opentraceai vault attach research   # mirror into A's graph

# In ~/code/project-b:
opentraceai vault attach research   # mirror the same global vault into B's graph
                                    # zero LLM cost — re-reads disk and copies
                                    # ~/.opentrace/corpus/<sha>.md files into B's
                                    # local corpus
```

Compiling does **not** auto-attach — the same `vault attach` step runs in the project that created the vault too. This keeps the meaning of "attached" symmetric across projects.

`vault attach` is the replacement for the old `wiki backfill`. Use it when:

- A global vault has been re-compiled elsewhere and you want this graph to pick up the changes
- You're starting a fresh graph and want to mirror existing vaults
- The previous mirror was lost (graph DB rebuilt)

`vault detach <name>` removes the mirror from the current graph without touching the disk vault.

## Moving vaults between scopes

```bash
opentraceai vault promote research   # local → global; disk dir moves to ~/.opentrace/vaults/
opentraceai vault demote research    # global → local; disk dir moves into the current project
```

Note: graph mirrors that pointed at the old scope are now stale. Run `vault attach research` in each affected project to refresh.

## Autoprune — keeping the vault in sync with disk

By default, re-running `index --wiki` detects docs that disappeared from disk between runs and cleans them up:

- The orphaned `CorpusDoc` node + its body in `corpus/` are deleted
- Concept pages that cited the removed doc have the dangling citation removed:
    - If the page still has other citations → kept, stamped `stale_since=<timestamp>`
    - If the page has no remaining citations → deleted entirely

Stale pages don't auto-regenerate (zero LLM cost during pruning). Refresh them on demand:

```bash
opentraceai vault refresh-stale-pages research                     # standalone
opentraceai index ./papers research --wiki --refresh-stale-pages   # inline
```

To opt out of pruning on a particular run (e.g. you're partially re-indexing):

```bash
opentraceai index ./papers research --wiki --no-prune
```

Autoprune is **scope-limited** to the walked path. Re-indexing `./papers` doesn't touch docs you ingested from `./transcripts`.

## Listing & inspecting

```bash
opentraceai vault list
# Vaults (3):
#   local   internal-docs   attached
#   local   research        STALE (disk newer than graph mirror)
#   global  refs            (not attached to current graph)

opentraceai vault list --global-only   # every global on the machine
opentraceai vault show research        # page index for one vault
opentraceai vault show research --page concept/some-base   # print one page body to stdout
```

A `STALE` row means the disk vault has been re-compiled since this graph last mirrored it (typically because the vault is global and another project recompiled). Run `vault attach <name>` to refresh.

## Mixing code and docs in one walk

```bash
opentraceai index ./ myproject --wiki
```

What you get from a single command:

- Code structure (`File` / `Class` / `Function` / etc.) from tree-sitter
- Doc bodies (`CorpusDoc` nodes + corpus files) from markitdown
- `MIRRORS` edges joining each repo-walked CorpusDoc to its `File` twin in the code tree (the File node is created during linking if the code walk skipped the doc's extension — either twin reaches the other in one hop)
- A `DOCUMENTS` edge joining the `Repository` to the vault it spawned (plus a `spawned_from` stamp on the vault) — only for vaults built by `index --wiki` over a repo, never for attached globals or dropped-file compiles
- Flat entities (`Idea` / `Service` / `Module` / `Paper` / `Person` / `Event`) from LLM extraction over the ingested docs
- Curated wiki pages (`Page`) about cross-document themes
- `MENTIONS` edges connecting pages **and** docs to the entities they discuss (matched against page bodies and raw corpus markdown)
- `DERIVED_FROM` edges connecting entities to the CorpusDoc they came from

Then surface cross-cutting structure:

```bash
opentraceai cluster
opentraceai analyze            # god nodes + bridges + cross-domain bridges + cross-cutting communities
```

## Where vaults live on disk

```
<project>/.opentrace/vaults/<name>/        # local vault root
~/.opentrace/vaults/<name>/                # global vault root (override with $OT_VAULT_ROOT)

  pages/concept/<base>.md          — multi-source synthesis pages
  .vault.json                      — page metadata, source labels + sha256 dedup state
  .compile-log/<ts>.json           — per-compile audit log
```

Slugs are `<kind_dir>/<base>` — e.g. `concept/usage`. Concept pages are the only page kind, so everything lives under the `concept/` folder. Open the vault in Obsidian and pages show up there; `[[wiki-links]]` in page bodies point concept-to-concept only. Source attribution isn't a wiki-link — it's the structural `CITES` edge from each concept page to the `CorpusDoc` nodes it drew from.

Disk is the source of truth for page bodies; the knowledge graph holds metadata and relationships. `vault attach` can always rebuild a graph mirror from disk — doc navigation labels are persisted in `.vault.json`, so attached mirrors keep them.

## What's next

- **Pick a provider** → [Wiki Providers](../reference/wiki-providers.md)
- **All the indexing flags** → [Indexing](indexing.md)
- **Query the graph** → [Graph Tools](../reference/graph-tools.md)
- **Hit a problem?** → [Troubleshooting](troubleshooting.md)
