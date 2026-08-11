# Wiki & Vaults

A **vault** is an indexed collection of documents — papers, design docs, transcripts, notebooks — mirrored into the same knowledge graph as your code, so retrieval tools can pull from both surfaces.

A vault is a **document corpus**: each doc gets a navigation label, an epistemic status, a `MIRRORS` link to its `File` twin, and `LINKS_TO` edges for the links its author wrote — while the body itself is kept **verbatim** and read back through `load_source`. Nothing is summarized into new prose: there is no synthesis step, and no entity graph is extracted from the text.

Vaults are produced two ways, sharing one pipeline:

- **`opentraceai vault ingest <folder>`** — a bare folder of doc files: a Confluence/Notion export, a docs-site checkout, a directory of PDFs. No git repo, no prior `opentraceai index` — if no graph DB exists yet, a docs-only one is created at `./.opentrace/index.db`. The docs-only front door: `cd docs-dump && opentraceai vault ingest .` is the whole setup.
- **`opentraceai index --wiki`** — the same `index` command that handles code. Docs found during the repo walk are ingested alongside the code graph and linked to it (`MIRRORS` File twins).

## Prerequisites

- `opentraceai` installed — see the [CLI install guide](install-cli.md)
- A plain `opentraceai` install — markitdown and the provider SDKs are core dependencies, no extra needed
- An LLM key from one of the [supported providers](../reference/wiki-providers.md), **or** a local OpenAI-compatible server (Ollama, llama.cpp, vLLM)

## Compile your first vault

```bash
# A folder of exported docs → local vault (no repo required)
opentraceai vault ingest ~/Downloads/confluence-export

# Or: docs discovered while indexing a repo
opentraceai index ./papers --wiki
```

What happens (either entry point):

1. The walker discovers PDF / DOCX / Markdown / HTML / etc. under the folder, and prints a per-extension count + cost estimate **before** any LLM spend
2. Each doc is converted to markdown via markitdown, body persisted to the scope-appropriate corpus dir (`<project>/.opentrace/corpus/<sha>.md` for local vaults, `~/.opentrace/corpus/<sha>.md` for globals)
3. One LLM call per doc labels the `KnowledgeDoc` node with a navigation label (a `title` derived mechanically from the filename + a one-line summary from the model). That is the only thing the call produces. Nothing is written in the model's own voice — the raw body stays in the corpus, readable via the `load_source` tool
4. Mechanical passes (no LLM) finish the corpus: a folder-relative `path` stamp, a `LINKS_TO` edge for every relative link an author wrote from one doc to another, and an epistemic `status` stamp (`authoritative` / `design_history` / `design_history_archived`; force one for a whole folder with `vault ingest --status`). Repo walks (`index --wiki`) additionally get a `MIRRORS` edge to each doc's `File` twin — `vault ingest` builds no code tree, so the KnowledgeDoc *is* the document
5. The vault metadata lives at `<project>/.opentrace/vaults/<name>/` and everything is mirrored into this project's graph. Globals are written to disk only — mirror with an explicit `vault attach` (see below).

What you have at this point is a labelled, linked, searchable corpus of the documents as their authors wrote them — no synthesized prose anywhere. Search hits on `KnowledgeDoc` nodes carry `title` / `status` / `one_line_summary` / `path` inline, so an agent can pick which documents to open without reading each one first.

Inspect it:

```bash
opentraceai vault list                          # local + global vaults visible here
opentraceai vault show papers                   # the vault's document index
```

## Doc-to-doc links

The `LINKS_TO` edges between `KnowledgeDoc` nodes are the doc-side analogue of the code graph's import edges: they record structure the **author** declared, not anything a model inferred. They're parsed mechanically out of each doc body — markdown inline links, reference-style definitions, and raw HTML anchors — then resolved against the linking doc's own directory. Repo-root-relative targets (`/docs/guide.md`) work too. External URLs, bare `#fragment` targets, and paths that escape the repo root are dropped, and a link that doesn't resolve to another indexed doc (a code file, an image) simply produces no edge.

## Corpus-wide questions

To ask what *every* document says about something, grep the corpus rather than read a summary of it. The [`grep` retrieval tool](../reference/graph-tools.md) (MCP + `POST /api/retrieval/grep`) sweeps every member doc's normalized body and returns matching lines already labelled with the doc's title and epistemic status. Follow up with `load_source` to read any document that looks worth opening in full.

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

If a local and a global vault do somehow share a name (e.g. both compiled before name de-duplication landed), the local one wins by default. Use `--scope global` on commands that take a name (e.g. `vault show research --scope global`) to disambiguate.

## Vault names are unique

A vault name is unique across **both** scopes — a new vault never reuses a name already taken locally or globally. When the name you'd get is already in use, OpenTrace appends a filesystem-style `-1`, `-2`, … suffix:

```bash
# a global "flask" already exists
opentraceai index ./flask --wiki
# → local vault 'flask-1' (not a second 'flask')
```

This is why `index --wiki` never produces a local *and* a global vault under the same label. Re-indexing is still idempotent: a repo re-index **reuses the vault it created before** (matched by the repo it was spawned from, recorded in `.vault.json`), so running `index ./flask --wiki` again updates `flask-1` in place rather than minting `flask-2`.

In the UI, **"+ Compile new"** auto-suffixes the same way; use a vault row's **append** action to add docs to an existing vault instead of creating a new one.

## Adding to an existing vault

Re-running `index <path> NAME --wiki` against the same vault is incremental:

- Docs whose sha256 already exists in the vault are skipped (no LLM call)
- New docs get labelled and extracted (one LLM call each)

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

- The orphaned `KnowledgeDoc` node + its body in `corpus/` are deleted
- The vault's `.vault.json` entry for that source goes with it

That is the whole of autoprune: the report is two counts, `documents_deleted` and `corpus_files_deleted`. Pruning costs no LLM calls. Nothing is derived from a document, so a vanished doc leaves nothing behind to mark stale.

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
opentraceai vault show research        # document index for one vault:
                                       #  status, title, one-line summary per doc
```

`vault show` doesn't print bodies — those live verbatim in the shared corpus. Read one with the `load_source` tool, or sweep them all with `grep`.

A `STALE` row means the disk vault has been re-compiled since this graph last mirrored it (typically because the vault is global and another project recompiled). Run `vault attach <name>` to refresh.

## Mixing code and docs in one walk

```bash
opentraceai index ./ myproject --wiki
```

What you get from a single command:

- Code structure (`File` / `Class` / `Function` / etc.) from tree-sitter
- Doc bodies (`KnowledgeDoc` nodes + corpus files) from markitdown, kept verbatim
- `MIRRORS` edges joining each repo-walked KnowledgeDoc to its `File` twin in the code tree (the File node is created during linking if the code walk skipped the doc's extension — either twin reaches the other in one hop)
- `LINKS_TO` edges between KnowledgeDocs for the links the docs' authors wrote to each other
- A `DOCUMENTS` edge joining the `Repository` to the vault it spawned — only for vaults built by `index --wiki` over a repo, never for attached globals or dropped-file compiles

Then surface cross-cutting structure:

```bash
opentraceai cluster
opentraceai analyze            # god nodes + bridges + cross-domain bridges + cross-cutting clusters
```

## Where vaults live on disk

```
<project>/.opentrace/vaults/<name>/        # local vault root
~/.opentrace/vaults/<name>/                # global vault root (override with $OT_VAULT_ROOT)

  .vault.json                      — source labels + sha256 dedup state
  .compile-log/<ts>.json           — per-compile audit log
```

That's the whole vault dir: metadata and an audit log, nothing else. A vault holds no bodies of its own — the documents' bodies live in the sibling `corpus/<sha>.md` dir, one file per doc, verbatim after markitdown normalization.

Disk is the source of truth for bodies; the knowledge graph holds metadata and relationships. `vault attach` can always rebuild a graph mirror from disk — doc navigation labels are persisted in `.vault.json`, so attached mirrors keep them.

## What's next

- **Pick a provider** → [Wiki Providers](../reference/wiki-providers.md)
- **All the indexing flags** → [Indexing](indexing.md)
- **Query the graph** → [Graph Tools](../reference/graph-tools.md)
- **Hit a problem?** → [Troubleshooting](troubleshooting.md)
