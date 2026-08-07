# Wiki

Doc-ingestion pipeline that indexes raw doc files into the graph store (the "vault"). Two CLI entry points share the pipeline: ``opentraceai index --wiki`` (repo walks — docs linked to the code tree) and ``opentraceai vault ingest <folder>`` (bare folders of exported docs — no git repo, no code tree; see `cli/vault_cmd.py`).

This is the **single doc-ingestion path**: the one per-doc LLM call (`doc_extraction.py`) emits exactly one thing — the KnowledgeDoc's one-line summary, which together with a filename-derived title is its navigation label. The raw doc body lives in the corpus and is read directly (`load_source`), swept verbatim (`grep`), or enumerated (`list_nodes`). What this module produces is a **document index**, not a knowledge graph over doc content.

## Corpus-only — nothing is synthesized

`run_compile()` runs **Acquire → Normalize → Extract → Persist → Mirror** and stops: labelled KnowledgeDoc nodes, doc↔doc `LINKS_TO`, `MIRRORS` File twins, epistemic `status`, bodies verbatim in the corpus. There is no synthesis stage and no flag to turn one on. Corpus `grep` is what answers "what do all the docs say about X" — verbatim lines from every document, pre-labelled with title and status.

The agent-facing contract for this layer lives in `cli/mcp_server.py` and is load-bearing: a capability the tools don't advertise is a capability that doesn't exist. Two rules follow:

- **`load_source` on a KnowledgeDoc must return `status` + `statusNote`** alongside the body, plus `title`/`path`/`summary`. A label that doesn't travel with the text does nothing — without it an agent cannot tell a proposal from shipped behaviour at the moment of reading.
- **`list_nodes`'s docstring must name `KnowledgeDoc`** and state that it — not ranked `search_graph` — is what establishes absence. An agent will not call a tool for a type the docstring never mentions.

## Layout

```
paths.py              — vault dir resolution + path-traversal validation;
                        scope-aware (local vs global) + resolve_vault_scope()
vault.py              — VaultMetadata pydantic model + .vault.json read/write
slugify.py            — title → filesystem-safe slug; sole caller is vault
                        *naming* (repo/folder/filename → vault name)
llm.py                — multi-provider client wrapper + BYOK key resolver;
                        each client carries a UsageTally recording the billed
                        token usage every provider response reports — surfaced
                        on run_compile's DONE event (detail["llm_usage"]) and
                        printed in the ingest summary next to the pre-flight
                        estimate, so a stale estimate is contradicted by real
                        usage on every run
                        (delegates to sources/_llm_common.py for BACKENDS)
ingest/
  types.py            — WikiPipelineEvent, WikiPhase, SourceInput,
                        NormalizedSource (with corpus_path)
  sources.py          — Acquire stage: file inputs + sha256 dedup
  normalize.py        — Normalize stage: lazy-imported markitdown wrapper
  doc_extraction.py   — Extract: 1 LLM call/doc → the KnowledgeDoc's one-line
                        summary. Nothing else.
  persist.py          — Persist stage: .vault.json source index + compile log
                        (bodies are written to the corpus by the composer)
  graph_writer.py     — Mirror vault to graph: KnowledgeVault + KnowledgeDoc +
                        CONTAINS + MIRRORS edges;
                        parse_doc_links() + link_doc_to_doc_links() for the
                        authors' own doc→doc references; stamp_doc_paths()
                        stamps root-relative path/paths/status WITHOUT File
                        twins (the `vault ingest` half of what
                        link_corpus_doc_mirrors does for repo walks; takes
                        status_override so --status survives the post-compile
                        stamp instead of being re-derived from the path)
  pipeline.py         — Composer (sync generator); accepts scope= +
                        project_root= + graph_store=
```

## Extract — the only LLM stage

One call per newly-ingested doc (`doc_extraction.py`), on the cheap tier
(`role="wiki_summary"`, override `OT_WIKI_SUMMARY_MODEL`). It emits exactly ONE
field: a one-line summary. That plus the display title — derived mechanically
from the filename by `_title_from_filename` / `_qualify_title`, no LLM — is the
KnowledgeDoc's navigation label. No page body and no entities are generated; the
raw doc is retained in the corpus and read directly.

A doc too large to read in one call is split on heading boundaries
(`_chunk_markdown`), each part processed, and the parts merged back into one
label (`_merge_chunk_results` takes the first non-empty summary). Because the
extraction output is small, the binding constraint is input context, so the
threshold is generous (`DEFAULT_MAX_DOC_CHARS`, override
`OT_WIKI_MAX_DOC_CHARS`) and the chunker is a rare safety net — small/medium
docs (the common case) stay a single call.

**Keep this call to one field.** Fields in one extraction schema are not
independent — each one competes with the others for the model's attention on
the same document, so adding a second degrades the summary you already have.
Treat a new field as a change to the quality of every existing one.

## Storage layout

```
<project>/.opentrace/vaults/<name>/   # local scope (default for --wiki)
~/.opentrace/vaults/<name>/           # global scope; override root via $OT_VAULT_ROOT
  .vault.json
  .compile-log/<iso-ts>.json
```

A vault dir holds **only** `.vault.json` + `.compile-log/`. Document bodies live in the shared, sha-keyed corpus dir described below, never under the vault.

**Disk is the source of truth for document bodies.** The graph holds metadata + relationships, with bodies referenced by `corpus_path`. LadybugDB caps STRING properties at ~4 KB; doc bodies typically run 5–20 KB, so they live on disk and are referenced by relative path.

The body of each raw document (post-markitdown) lives at a scope-aware corpus dir. `KnowledgeDoc` nodes carry `corpus_path` (stored relative to `.opentrace/`) pointing there:

- **Local vaults** (or any compile that's mirroring to a graph store) → `<db_dir>/corpus/<sha>.md`, typically `<project>/.opentrace/corpus/`.
- **Global vaults compiled without a graph store** → `~/.opentrace/corpus/<sha>.md` (or `$OT_VAULT_ROOT`'s parent + `/corpus/`). On `vault attach`, the corpus is copied sha-by-sha into the attaching project's corpus dir so `KnowledgeDoc.corpus_path` resolves locally.

The helper APIs are `sources.markdown.corpus_dir_for_scope(scope, project_root)`, `write_corpus_markdown_to(dir, sha, md)`, and `copy_corpus_between_scopes(...)`.

## Scope

Vaults are scoped at compile time:

- ``scope="local"`` → ``<project_root>/.opentrace/vaults/<name>/``. Visible only to graphs in that project. The default for ``opentraceai index --wiki``.
- ``scope="global"`` → ``~/.opentrace/vaults/<name>/`` (or ``$OT_VAULT_ROOT``). Attachable from any project via ``opentraceai vault attach <name>``.

The `KnowledgeVault` graph node carries `scope` + `mirror_compiled_at`. `mirror_compiled_at` is set by `write_vault_to_graph` on every run; `vault list` compares it against the disk vault's `last_compiled_at` to flag stale mirrors.

`paths.resolve_vault_scope(name, project_root=...)` finds a vault by name (local first, then global) and returns `(scope, vault_dir)`.

**Names are unique across BOTH scopes.** A new vault never reuses a name already
taken locally or globally — `paths.unique_vault_name(name, project_root=...)`
appends a filesystem-style `-1`, `-2`, … suffix until free. This keeps the two
scopes from ever showing two different vaults under one label. Re-indexing a repo
must stay idempotent, so `index --wiki` reuses the vault it produced before
(matched by `spawned_from`) rather than suffixing anew — see the CLI's
`_resolve_index_vault_name`. `VaultMetadata.spawned_from` (persisted in
`.vault.json`) is the stable repo→vault key that makes this work even when the
name was suffixed on first creation. `vault ingest` uses the same mechanism with
`spawned_from = "dir::<abs folder path>"` — repo ids never contain `::`, so the
two producers can't collide. Its re-ingest also prunes: graph-side via
`autoprune_after_index`, and disk-side `_prune_vault_meta_sources` drops
`meta.sources` entries for deleted docs (every compile re-mirrors ALL of
`meta.sources`, so without the meta prune a deleted doc is resurrected each run
and the metadata grows forever). The serve compile route takes an
`on_conflict` form field (`suffix` for a new-vault compile, `append` to update in
place).

## Graph mirror

`run_compile(graph_store=..., scope="local"|"global")` mirrors the post-compile vault state into the graph after disk writes succeed:

- `KnowledgeVault` — id `vault::<name>`. Carries `vault` (denormalised), `last_compiled_at`, `summary`, `scope`, and `mirror_compiled_at`. The repo/folder it was built from is NOT a property here — it lives in `.vault.json`'s `spawned_from` (the one `_resolve_index_vault_name` reads), mirrored into the graph only as the `DOCUMENTS` edge. A vault-node copy existed and was never read back.
- `KnowledgeDoc` nodes — id `corpus::<sha256-of-raw-bytes>`. Carries `sha256`/`filename`/`content_type`/`acquired_at`/`corpus_path` plus the navigation label: `title` and `one_line_summary`/`summary` (the `summary` copy feeds `build_search_text` so KnowledgeDocs are FTS-findable by label), and `path` (root-relative) when the doc came from a walked source — repo-relative on `index --wiki`, folder-relative on `vault ingest` (stamped by `stamp_doc_paths`, which both producers share; the ingest path passes `status_override` through so `--status` isn't undone by the stamp's path heuristic). Labels come from this run's extraction or, on re-mirror/attach, from `.vault.json`'s `IngestedSource` (which persists them) or the previously-written node. Sha-keyed deduplication across vaults.
- `CONTAINS` — Vault → KnowledgeDoc. The only edge `write_vault_to_graph` writes besides the doc nodes themselves.
- `LINKS_TO` — **KnowledgeDoc → KnowledgeDoc**, one producer. The authors' *own* cross-references, parsed mechanically (no LLM) from each doc's relative markdown links, reference-style definitions, and raw HTML anchors by `parse_doc_links` and written by `link_doc_to_doc_links` in the same post-compile step as MIRRORS. The doc-side analogue of the code graph's import edges: it records structure a human declared, never anything a model inferred. Targets resolve against the linking doc's own directory (`/docs/x.md` is treated as repo-root-relative); external URLs, fragment-only links, and paths escaping the repo root are dropped, and resolution itself is the filter — a link to a `.py` file or an image finds no KnowledgeDoc and is skipped. Runs whenever the ingest has root-relative paths — repo walks (`index --wiki`, repo root) and folder ingests (`vault ingest`, folder root standing in for it) — but not single-file/URL/dropped-file compiles. Written by `link_doc_to_doc_links` in the post-compile step, **not** by `write_vault_to_graph`, which has no root-relative paths to resolve against.
- `MIRRORS` — KnowledgeDoc → File, written by `link_corpus_doc_mirrors` after an `index --wiki` directory run for every repo-walked doc. When the code walk didn't produce the File node (extensions outside `INCLUDED_EXTENSIONS` — `.rst`/`.txt`/`.html`/PDFs), `_ensure_file_twin` creates it (plus any missing ancestor Directory nodes) so the twin always exists. No edge for docs that didn't come from a repo walk (uploads, URLs, attached global vaults, and `vault ingest` folders — deliberately: there's no repo, the KnowledgeDoc IS the document, so ingest stamps `path` via `stamp_doc_paths` without creating File twins).
- `DOCUMENTS` — Repository → Vault, written by `link_vault_to_repo` in the same `index --wiki` post-compile step as MIRRORS. Marks the vault as spawned from that repo — this edge IS the graph-side record of it. Attached globals and dropped-file compiles never get it — they live alongside a repo without documenting it.

Graph-write failures are caught and emitted as non-fatal warnings — the on-disk vault stays valid. Recover with:

```
opentraceai vault attach <name>
```

## Link parser

One parser, for the one producer of `LINKS_TO`. Authors write ordinary relative markdown links; `[[wiki-link]]` syntax is not supported anywhere in the product.

**`graph_writer.parse_doc_links(body)`** — doc → doc. Extracts in-repo relative targets from inline markdown links (`[t](./guide.md)`, angle-bracket and `%20` forms included), reference-style definitions (`[g]: docs/guide.md`), and raw HTML anchors. Fragments and query strings are stripped (`guide.md#setup` → `guide.md`); external targets (`http:`, `mailto:`, protocol-relative `//`) and fragment-only links are dropped; results are deduped in document order.

`link_doc_to_doc_links(store, named_blobs)` then resolves each target against the linking doc's own directory via `posixpath` (leading `/` means repo-root-relative), drops anything normalizing outside the repo root, and merges one edge per distinct target pair — so `guide.md`, `./guide.md`, and `guide.md#top` collapse to a single edge, and self-links are skipped. Bodies come from the corpus (post-markitdown, so an `.html` doc's anchors are already markdown) with a raw-bytes decode as fallback. Docs dropped by the content gate have no node and are silently skipped.

## Autoprune

`pipeline/autoprune.py` runs after `index --wiki` / `vault ingest` and deletes graph state for documents that vanished from disk between runs: the `KnowledgeDoc` node, its edges, and its corpus body. That is the whole sweep. **There is no staleness concept in this module.** Nothing synthesizes a derived artefact, so nothing can fall out of date with respect to its source; a document is either present or pruned. No LLM cost during pruning.

## Provenance chain

`retrieval.provenance(node_id)` on a `KnowledgeDoc` returns the document's own identity: sha256, filename, root-relative path, ingest time, and the `MIRRORS` File twin id when present. A `KnowledgeVault` returns an empty chain (no body of its own).

**A document is its own provenance, so the "chain" is one entry.** Nothing restates a document, so there is nothing to trace back through. Node types outside the wiki and code branches return `kind="unknown"`.

## Still deferred

- Production blob store — currently local disk ([OT-1745](https://linear.app/opentrace/issue/OT-1745)).
- Per-vault ingestions are serialized via `fcntl.flock` on `.vault.json`.

## Public docs

User-facing references (keep in lockstep with this file):

- `docs/getting-started/wiki.md` — end-to-end vault workflow
- `docs/getting-started/indexing.md` — `index --wiki` flags
- `docs/getting-started/install-cli.md` — first-run examples
- `docs/reference/vault-commands.md` — `vault` subcommand reference
- `docs/reference/cli-flags.md` — full flag list
- `docs/reference/graph-tools.md` — MCP tools + REST routes
- `docs/reference/wiki-providers.md` — LLM backends + model roles
- `docs/architecture/ontology.md` — node + edge type catalog
- `docs/architecture/overview.md` — the four layers + data flow
