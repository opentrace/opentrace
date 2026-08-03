# Vault Commands

`opentraceai vault` is the management surface for wiki vaults, plus the ingestion entry point for doc collections that aren't a repo: `vault ingest` compiles a bare folder of exported docs, while repo-walked compilation lives on `opentraceai index --wiki` — see [Indexing](../getting-started/indexing.md). The remaining commands handle *post-compile* operations: listing, inspecting, attaching to graphs, moving between scopes.

## Concept refresher

A **vault** is an indexed collection of documents — labelled, linked, and searchable, with the bodies kept verbatim in the corpus. Nothing is synthesized, so a vault has no pages: only vaults compiled before 2026-08-03, when concept-page synthesis was removed, carry any. Two storage scopes:

- **Local** — `<project>/.opentrace/vaults/<name>/`. Visible only to graphs in that project.
- **Global** — `~/.opentrace/vaults/<name>/` (or `$OT_VAULT_ROOT`). Visible from anywhere via `vault attach`.

Disk is canonical. Each graph holds a derived **mirror** (`KnowledgeVault` + `KnowledgeDoc` nodes, plus `KnowledgeConcept` nodes for a legacy vault that still has pages — they keep being mirrored rather than dropped). The disk vault is rebuilt by re-running `vault ingest` / `index --wiki`; the graph mirror is rebuilt by `vault attach`.

## `vault ingest`

```bash
opentraceai vault ingest ~/Downloads/confluence-export
opentraceai vault ingest ./docs-dump kb --status design_history
opentraceai vault ingest ./handbook --scope global
```

Ingests a **bare folder of doc files** — a Confluence/Notion/SharePoint export, a docs-site checkout, a folder of PDFs — into a corpus-only vault. No git repo required, and unlike `index --wiki` it builds no code tree: the KnowledgeDoc *is* the document (no `File` twins, no `MIRRORS`).

What each doc gets:

- markitdown normalization (HTML/PDF/DOCX/PPTX/... → markdown), body verbatim in the corpus, readable via `load_source`. The walked set is the repo walk's doc extensions **plus `.json`** — in an export folder, structured data (a fleet inventory, a config dump) is a document the same way `.csv` already is
- a navigation label from one LLM call — `title` + one-line summary — plus the extracted entity graph
- a folder-relative `path` stamp (searchable, and the navigation key when export filenames are opaque)
- an epistemic `status` from the path heuristic, or forced for the whole folder with `--status`
- `LINKS_TO` edges for the relative links its author wrote, resolved against the folder root

**Scope semantics.** `--scope local` (default) mirrors into the current project's graph (auto-discovered, or `--db`). When no graph DB exists — you're standing in a bare folder of docs, no repo, nothing indexed — one is **created on the spot** at `./.opentrace/index.db`, so a dir of docs is a complete project by itself: `cd docs-dump && opentraceai vault ingest .` and it's searchable. `--scope global` writes disk-only, like the serve upload route — attach it to a project with `vault attach`. Note the attach path can't reconstruct `path` stamps or `LINKS_TO` (they're graph writes made at ingest time), so prefer a local ingest when you need those.

**Re-ingest is idempotent.** The folder's absolute path is recorded as `spawned_from` (`dir::<path>`), so re-running updates the same vault: unchanged files are skipped by content hash, new files are labelled, and files deleted from the folder are pruned from the graph, corpus, and vault metadata (`--no-prune` to keep them).

The ingest ends with a summary — docs by extension, skips, entities, links, mirror stats — and a per-extension count + cost estimate is printed up front, *before* the LLM spend starts. Coverage is explicit: files the walker skipped as unsupported types are listed (`not walked (unsupported type): 1 × .xyz (...)`) rather than silently omitted, so "N docs indexed" never quietly means "N of M".

## `vault list`

```bash
opentraceai vault list
```

Lists local + global vaults visible from the current project, with attachment status against the current graph.

```
Vaults (3):
  local   internal-docs   attached
  local   research        STALE (disk newer than graph mirror)
  global  refs            (not attached to current graph)
```

A `STALE` row means the disk vault has been re-compiled since this graph last mirrored it — typically because the vault is global and another project recompiled. Run `vault attach <name>` to refresh.

### `--global-only`

```bash
opentraceai vault list --global-only
```

Shows every global vault on the machine, regardless of whether the current graph has it attached. Useful when you're new to a machine and want to discover what's available.

## `vault show`

```bash
opentraceai vault show <name>                      # vault index
opentraceai vault show <name> --page <slug>        # one page body (legacy vaults)
opentraceai vault show <name> --scope global       # disambiguate local vs global
```

Prints the vault metadata + doc/page list (default) or the markdown body of one page. The `--page` form is useful for piping into `less`, `glow`, `pbcopy`, etc. — it only applies to a vault compiled before concept-page synthesis was removed; nothing produces pages now.

```bash
opentraceai vault show research --page concept/diffusion-models | less
opentraceai vault show research --page concept/diffusion-models | pbcopy
```

## `vault attach`

```bash
opentraceai vault attach <name>
opentraceai vault attach <name> --scope global     # disambiguate on collision
opentraceai vault attach <name> --db <path>        # explicit graph DB
```

Mirrors an existing disk vault into the current graph. No LLM cost — just reads `.vault.json` + any page files from disk and writes `KnowledgeVault` / `KnowledgeDoc` nodes (plus `KnowledgeConcept` for a legacy vault that has pages) + `CONTAINS` / `CITES` / `LINKS_TO` edges into the graph.

When to use:

- A global vault was re-compiled in another project and you want your local graph to pick up the new state
- The graph DB was rebuilt and you need to restore the vault mirror
- You're starting a fresh graph that should pre-populate with vaults compiled elsewhere

If a vault with the same name exists both local and global, **local wins** by default. Pass `--scope global` to force global. If neither exists, the command errors with a list of visible vaults:

```
vault 'foo' not found. Visible vaults:
  local   internal-docs
  global  refs
  global  research
```

## `vault detach`

```bash
opentraceai vault detach <name>
opentraceai vault detach <name> --db <path>
```

Removes the current graph's mirror — the disk vault is untouched. KnowledgeDoc nodes shared with other attached vaults are preserved.

## `vault promote` / `vault demote`

```bash
opentraceai vault promote <name>    # local → global
opentraceai vault demote <name>     # global → local (into current project)
```

Moves a vault between scopes by relocating the on-disk directory. Errors if a vault with the same name already exists at the destination.

The **current project's graph mirror is auto-refreshed** so `autoprune` and queries see the new scope immediately. You'll see a confirmation line like:

```
Re-attached to this project's graph: 35 nodes, 146 rels.
```

!!! warning "Other projects' mirrors still go stale"
    Auto-attach only fires for the project whose graph this command can discover (via `find_db()` from cwd). Other projects that previously ran `vault attach <name>` against this vault still hold a mirror tagged with the old scope. Run `vault attach <name>` in each of those, or `vault detach <name>` if they no longer need it.

!!! note "`vault refresh-stale-pages` was removed 2026-08-03"
    It regenerated concept pages that autoprune had stamped `stale_since`. With concept-page synthesis gone there is nothing to regenerate — autoprune still stamps `stale_since` on a legacy page that lost a citation, but the only remedy is deleting the page. The inline `index --wiki --refresh-stale-pages` form went with it.

## Where vaults live on disk

```
<project>/.opentrace/vaults/<name>/   # local
~/.opentrace/vaults/<name>/           # global (override with $OT_VAULT_ROOT)

  pages/concept/<base>.md             # legacy concept pages — vaults compiled
                                      #  before 2026-08-03 only
  .vault.json                         # page metadata, source labels + sha256 dedup state
  .compile-log/<ts>.json              # per-compile audit log
```

The doc corpus (post-markitdown bodies) lives in a sibling `corpus/` dir keyed by sha256, scope-aware:

```
<project>/.opentrace/corpus/<sha>.md   # local vaults attached to this project
~/.opentrace/corpus/<sha>.md           # globals compiled but not yet attached anywhere
```

`vault attach` copies any sha files it finds in the global corpus into the attaching project's local corpus dir — once attached, `KnowledgeDoc.corpus_path` resolves under `<project>/.opentrace/` like any local KnowledgeDoc.

Where legacy pages exist, slugs are `<kind_dir>/<base>` (e.g. `concept/usage`). Concept pages are the only page kind, so everything lives under `concept/`. Pass `<kind_dir>/<base>` to `vault show --page` and to the `/api/vaults/{vault}/pages/{slug}` REST route. A vault compiled today has no slugs — read its documents through `load_source` / the source routes instead.

The `.vault.json` is the authoritative record. Re-attaching a graph mirror reads it — including each doc's navigation label (`title` + one-line summary), so attached KnowledgeDocs keep their labels; re-compiling against the same vault uses its `source_shas` to dedup.

## Cross-project example

Compile once globally, use everywhere:

```bash
# In ~/code/project-a:
opentraceai index ./papers research --wiki --global
opentraceai vault list   # research: attached

# In ~/code/project-b:
opentraceai vault list   # research: not attached
opentraceai vault attach research
opentraceai vault list   # research: attached

# Project A adds a new paper, recompiles
cd ~/code/project-a
opentraceai index ./papers/new-paper.pdf research --wiki --global

# Project B sees the global vault is now ahead of its mirror
cd ~/code/project-b
opentraceai vault list   # research: STALE
opentraceai vault attach research   # re-mirror; no LLM cost
opentraceai vault list   # research: attached
```

## Removing a vault

There's no `vault delete` command — vault management stays attach/detach-focused. To actually remove a vault from disk:

```bash
opentraceai vault detach research            # remove from current graph
rm -rf ~/.opentrace/vaults/research/         # remove from disk (global)
# or for a local:
rm -rf <project>/.opentrace/vaults/research/
```

This is intentional — disk cleanup is straightforward and explicit; we don't risk wiping disk data behind your back.
