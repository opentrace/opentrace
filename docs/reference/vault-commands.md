# Vault Commands

`opentraceai vault` is the management surface for compiled wiki vaults. Compilation itself lives on `opentraceai index --wiki` — see [Indexing](../getting-started/indexing.md). These commands handle the *post-compile* operations: listing, inspecting, attaching to graphs, moving between scopes.

## Concept refresher

A **vault** is a folder of LLM-curated markdown pages produced from one or more documents. Two storage scopes:

- **Local** — `<project>/.opentrace/vaults/<name>/`. Visible only to graphs in that project.
- **Global** — `~/.opentrace/vaults/<name>/` (or `$OT_VAULT_ROOT`). Visible from anywhere via `vault attach`.

Disk is canonical. Each graph holds a derived **mirror** (`KnowledgeVault` + `KnowledgeConcept` + `KnowledgeDoc` nodes). The disk vault is rebuilt by re-running `index --wiki`; the graph mirror is rebuilt by `vault attach`.

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
opentraceai vault show <name>                      # page index
opentraceai vault show <name> --page <slug>        # one page body
opentraceai vault show <name> --scope global       # disambiguate local vs global
```

Prints the vault metadata + page list (default) or the markdown body of one page. The `--page` form is useful for piping into `less`, `glow`, `pbcopy`, etc.

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

Mirrors an existing disk vault into the current graph. No LLM cost — just reads `.vault.json` + page files from disk and writes `KnowledgeVault` / `KnowledgeConcept` / `KnowledgeDoc` nodes + `CONTAINS` / `CITES` / `LINKS_TO` edges into the graph.

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

The **current project's graph mirror is auto-refreshed** so `autoprune` / `refresh-stale-pages` / queries see the new scope immediately. You'll see a confirmation line like:

```
Re-attached to this project's graph: 35 nodes, 146 rels.
```

!!! warning "Other projects' mirrors still go stale"
    Auto-attach only fires for the project whose graph this command can discover (via `find_db()` from cwd). Other projects that previously ran `vault attach <name>` against this vault still hold a mirror tagged with the old scope. Run `vault attach <name>` in each of those, or `vault detach <name>` if they no longer need it.

## `vault refresh-stale-pages`

```bash
opentraceai vault refresh-stale-pages <name>             # one vault
opentraceai vault refresh-stale-pages                     # all stale pages in the graph
opentraceai vault refresh-stale-pages --provider gemini   # specific LLM
```

Re-runs Plan + Execute for concept pages stamped `stale_since` by autoprune. Pages become stale when a cited doc is removed but the page still has other citations — they're kept (no LLM cost) but flagged so you can refresh on demand.

`refresh-stale-pages` is also available inline on `index`:

```bash
opentraceai index ./papers research --wiki --refresh-stale-pages
```

## Where vaults live on disk

```
<project>/.opentrace/vaults/<name>/   # local
~/.opentrace/vaults/<name>/           # global (override with $OT_VAULT_ROOT)

  pages/concept/<base>.md             # multi-source synthesis pages
  .vault.json                         # page metadata, source labels + sha256 dedup state
  .compile-log/<ts>.json              # per-compile audit log
```

The doc corpus (post-markitdown bodies) lives in a sibling `corpus/` dir keyed by sha256, scope-aware:

```
<project>/.opentrace/corpus/<sha>.md   # local vaults attached to this project
~/.opentrace/corpus/<sha>.md           # globals compiled but not yet attached anywhere
```

`vault attach` copies any sha files it finds in the global corpus into the attaching project's local corpus dir — once attached, `KnowledgeDoc.corpus_path` resolves under `<project>/.opentrace/` like any local KnowledgeDoc.

Slugs are `<kind_dir>/<base>` (e.g. `concept/usage`). Concept pages are the only page kind, so everything lives under `concept/`. Pass `<kind_dir>/<base>` to `vault show --page` and to the `/api/vaults/{vault}/pages/{slug}` REST route.

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
