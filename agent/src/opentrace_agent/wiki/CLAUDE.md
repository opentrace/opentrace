# Wiki

Doc-ingestion pipeline that indexes raw doc files into the graph store (the "vault"). Two CLI entry points share the pipeline: ``opentraceai index --wiki`` (repo walks — docs linked to the code tree) and ``opentraceai vault ingest <folder>`` (bare folders of exported docs — no git repo, no code tree; see `cli/vault_cmd.py`). There is no separate ``wiki compile`` command anymore.

This is the **single doc-ingestion path**: the one per-doc LLM call (`doc_extraction.py`) emits exactly one thing — the KnowledgeDoc's one-line summary, which together with a filename-derived title is its navigation label. There are **no wiki pages** and **no entity layer**: the raw doc body lives in the corpus and is read directly (`load_source`), swept verbatim (`grep`), or enumerated (`list_nodes`). What this module produces is a **document index**, not a knowledge graph over doc content.

## Corpus-only — nothing is synthesized

`run_compile()` runs **Acquire → Normalize → Extract → Persist → Mirror** and stops: labelled KnowledgeDoc nodes, doc↔doc `LINKS_TO`, `MIRRORS` File twins, epistemic `status`, bodies verbatim in the corpus. There is no synthesis stage and no flag to turn one on — the concept-page pipeline (Resolve/Execute/Verify, `--wiki-concept-pages`, `refresh-stale-pages`) was **removed 2026-08-03**. No new vault gets `KnowledgeConcept` nodes, `pages/concept/*.md`, or `CITES` edges. The LLM-extracted **entity layer** was **removed 2026-08-04** (see [Closed](#closed)); no new vault gets `Idea`/`Service`/`Module`/`Paper`/`Person`/`Event` nodes, `DERIVED_FROM`, `SEMANTIC_EDGE`, or `MENTIONS` edges.

`KnowledgeConcept` is still a valid node type and the whole **read** surface still exists (`vault show --page`, MCP `read_vault_page` / `list_vault_pages`, `CITES` in `retrieval/provenance.py`, `retrieval/overview.py` counts, the UI wiki renderer, `parse_wiki_links`, `pipeline._read_all_page_bodies`). A vault compiled *before* the removal still carries pages on disk and in `.vault.json`, and a re-compile must keep mirroring them rather than silently dropping them from the graph. Short version: **nothing produces pages any more; legacy pages stay readable.**

The agent-facing contract for this layer lives in `cli/mcp_server.py` and is load-bearing — the benchmark showed a capability the tools don't advertise is a capability that doesn't exist:

- **`load_source` on a KnowledgeDoc returns `status` + `statusNote`** alongside the body, plus `title`/`path`/`summary`. It originally returned filename/sha/body only, so the epistemic label was invisible at the moment of reading and the arm never once distinguished a proposal from shipped behaviour. A label that doesn't travel with the text does nothing.
- **`list_nodes` names the doc types** (`KnowledgeDoc`, `KnowledgeConcept`) and states that it — not ranked `search_graph` — is what can establish absence. The arm called it *zero* times in 201 tool calls while the code arm called it 9×, and lost the corpus-enumeration question, because the docstring listed only code types.

Why synthesis is gone: a synthesized page restates its sources in the model's own voice, which strips their hedges, tense, and attribution — a failure mode a verbatim body structurally cannot have (four successive grounding patches all chased instances of it). It measured accordingly: concept pages scored **88.4% against a 98.6% control (−10.2pp)**, the worst result on record. Corpus `grep` now answers "what do all the docs say about X" with verbatim lines from every document, pre-labelled with title and status — strictly better than a layer of paraphrase glosses, by the same standard that killed synthesis.

The per-doc `concepts` field went with it, for an independent reason: it was measurably **competing with the entity inventory for the same content** (removing it raised entity yield ~20%). That finding outlived the thing it was measured against — the entity inventory is gone too — but the mechanism is the one durable lesson here: **fields in one extraction schema are not independent.** Each one you add competes with the others for the model's attention on the same document. The call now asks for one field, and adding a second needs a measurement, not an argument.

## Layout

```
paths.py              — vault dir resolution + path-traversal validation;
                        scope-aware (local vs global) + resolve_vault_scope()
vault.py              — VaultMetadata pydantic model + .vault.json read/write
slugify.py            — title → slug, collision suffix, tombstones
index.py              — vault index (slug, title, summary) read from .vault.json
llm.py                — multi-provider client wrapper + BYOK key resolver;
                        each client carries a UsageTally recording the billed
                        token usage every provider response reports — surfaced
                        on run_compile's DONE event (detail["llm_usage"]) and
                        printed in the ingest summary next to the pre-flight
                        estimate, so estimate drift is contradicted on every
                        run (the estimate once ran 6.5x stale unnoticed)
                        (delegates to sources/_llm_common.py for BACKENDS)
ingest/
  types.py            — WikiPipelineEvent, WikiPhase, SourceInput,
                        NormalizedSource (with corpus_path), CompiledPage
  sources.py          — Acquire stage: file inputs + sha256 dedup
  normalize.py        — Normalize stage: lazy-imported markitdown wrapper
  doc_extraction.py   — Extract: 1 LLM call/doc → the KnowledgeDoc's one-line
                        summary. Nothing else.
  persist.py          — Persist stage: atomic disk writes + .vault.json update
  graph_writer.py     — Mirror vault to graph: Vault/Page/KnowledgeDoc +
                        CONTAINS/CITES/LINKS_TO + MIRRORS edges;
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

**Do not add a second field to this call without measuring it.** Two have been
added and removed already (`concepts`, then `entities`/`edges`), and in both
cases the field measurably competed with what else the call was asked for.
Fields in one schema are not independent.

## Storage layout

```
<project>/.opentrace/vaults/<name>/   # local scope (default for --wiki)
~/.opentrace/vaults/<name>/           # global scope; override root via $OT_VAULT_ROOT
  pages/concept/<base>.md         # legacy only — nothing writes these now
  .vault.json
  .compile-log/<iso-ts>.json
```

A compile writes `.vault.json` + `.compile-log/` and leaves `pages/` empty — the doc bodies live in the corpus dir described below, not in the vault. `pages/` is non-empty only for a vault compiled before synthesis was removed; those bodies are still read back and mirrored (`_read_all_page_bodies`).

Slugs are `<kind_dir>/<base>` (e.g. `concept/usage`). Concept is the only page kind. Generated by `wiki.slugify.unique_slug(title, kind=...)`; the folder name comes from `kind_dir(kind)`. Retained for reading legacy pages.

**Disk is the source of truth for page bodies.** The graph holds metadata + relationships, with bodies referenced by `corpus_path`. LadybugDB caps STRING properties at ~4 KB; doc bodies typically run 5–20 KB, so they live on disk and are referenced by relative path.

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

- `KnowledgeVault` — id `vault::<name>`. Carries `vault` (denormalised), `last_compiled_at`, `summary`, `scope`, `mirror_compiled_at`, and `spawned_from` (repo id, or `dir::<abs path>` for `vault ingest` folders) when the vault was built over a walked source. For repos it's stamped by `link_vault_to_repo` after the mirror and carried forward on re-mirrors; `vault ingest` stamps it directly on the disk metadata.
- `KnowledgeConcept` nodes — **legacy only**; no compile creates one any more (`compiled_slugs` is always empty, so no page gets fresh provenance). Still mirrored when a pre-removal vault has them: id `<vault>::<slug>` where slug is `<kind_dir>/<base>` (e.g. `kb::concept/usage`), carrying `slug`/`vault`/`kind` (`concept`)/`one_line_summary`/`revision`/`last_updated` and whatever `agent`/`model`/`session`/`confidence` provenance they already had (concept → INFERRED/0.75).
- `KnowledgeDoc` nodes — id `corpus::<sha256-of-raw-bytes>`. Carries `sha256`/`filename`/`content_type`/`size_bytes`/`acquired_at`/`corpus_path` plus the navigation label: `title` and `one_line_summary`/`summary` (the `summary` copy feeds `build_search_text` so KnowledgeDocs are FTS-findable by label), and `path` (root-relative) when the doc came from a walked source — repo-relative on `index --wiki`, folder-relative on `vault ingest` (stamped by `stamp_doc_paths`, which both producers share; the ingest path passes `status_override` through so `--status` isn't undone by the stamp's path heuristic). Labels come from this run's extraction or, on re-mirror/attach, from `.vault.json`'s `IngestedSource` (which persists them) or the previously-written node. Sha-keyed deduplication across vaults.
- `CONTAINS` — Vault → KnowledgeDoc (and Vault → Page for legacy pages).
- `CITES` — concept page → KnowledgeDoc, direct by sha (one hop; no intermediate pages). Legacy only — no new edges are written, but the type stays so provenance still walks pre-removal vaults.
- `LINKS_TO` — two distinct producers, same edge type:
  - **KnowledgeDoc → KnowledgeDoc** — the authors' *own* cross-references, parsed mechanically (no LLM) from each doc's relative markdown links, reference-style definitions, and raw HTML anchors by `parse_doc_links` and written by `link_doc_to_doc_links` in the same post-compile step as MIRRORS. The doc-side analogue of the code graph's import edges: it records structure a human declared, never anything a model inferred. Targets resolve against the linking doc's own directory (`/docs/x.md` is treated as repo-root-relative); external URLs, fragment-only links, and paths escaping the repo root are dropped, and resolution itself is the filter — a link to a `.py` file or an image finds no KnowledgeDoc and is skipped. Runs whenever the ingest has root-relative paths — repo walks (`index --wiki`, repo root) and folder ingests (`vault ingest`, folder root standing in for it) — but not single-file/URL/dropped-file compiles.
  - **KnowledgeConcept → KnowledgeConcept** — per `[[Title]]` occurrence in a page body. Legacy only; reachable solely from pages a pre-removal compile left on disk.
- `MENTIONS` / `DERIVED_FROM` / `SEMANTIC_EDGE` — **gone as of 2026-08-04** with the entity layer. Nothing writes them; a pre-existing graph's edges are left in place and stay traversable via the generic `traverse_graph`. "Every doc that discusses X" is now a `grep` sweep, not a traversal.
- `MIRRORS` — KnowledgeDoc → File, written by `link_corpus_doc_mirrors` after an `index --wiki` directory run for every repo-walked doc. When the code walk didn't produce the File node (extensions outside `INCLUDED_EXTENSIONS` — `.rst`/`.txt`/`.html`/PDFs), `_ensure_file_twin` creates it (plus any missing ancestor Directory nodes) so the twin always exists. No edge for docs that didn't come from a repo walk (uploads, URLs, attached global vaults, and `vault ingest` folders — deliberately: there's no repo, the KnowledgeDoc IS the document, so ingest stamps `path` via `stamp_doc_paths` without creating File twins).
- `DOCUMENTS` — Repository → Vault, written by `link_vault_to_repo` in the same `index --wiki` post-compile step as MIRRORS. Marks the vault as spawned from that repo (paired with the `spawned_from` vault property). Attached globals and dropped-file compiles never get it — they live alongside a repo without documenting it.

Graph-write failures are caught and emitted as non-fatal warnings — the on-disk vault stays valid. Recover with:

```
opentraceai vault attach <name>
```

## Link parsers

Two parsers, one per producer of `LINKS_TO` (see the graph-mirror section). Only the second runs on a compile today; the first is kept for legacy page bodies and the UI renderer.

**`graph_writer.parse_wiki_links(body)`** — page ↔ page. Extracts targets from `[[Title]]` and `[[Title|alias]]` Obsidian-style forms. Targets are stripped of whitespace and deduped in document order. The renderer in `ui/src/components/wiki/` uses the same syntax.

Resolution accepts both bare and kinded forms: `[[Title]]` matches unambiguously when only one kind has that title; `[[concept/Title]]` always resolves to the named kind. Bare targets whose title appears in multiple kinds drop to "broken" so the page surfaces the ambiguity rather than silently picking one.

**`graph_writer.parse_doc_links(body)`** — doc → doc, and the one a compile actually runs. Extracts in-repo relative targets from inline markdown links (`[t](./guide.md)`, angle-bracket and `%20` forms included), reference-style definitions (`[g]: docs/guide.md`), and raw HTML anchors. Fragments and query strings are stripped (`guide.md#setup` → `guide.md`); external targets (`http:`, `mailto:`, protocol-relative `//`) and fragment-only links are dropped; results are deduped in document order.

`link_doc_to_doc_links(store, named_blobs)` then resolves each target against the linking doc's own directory via `posixpath` (leading `/` means repo-root-relative), drops anything normalizing outside the repo root, and merges one edge per distinct target pair — so `guide.md`, `./guide.md`, and `guide.md#top` collapse to a single edge, and self-links are skipped. Bodies come from the corpus (post-markitdown, so an `.html` doc's anchors are already markdown) with a raw-bytes decode as fallback. Docs dropped by the content gate have no node and are silently skipped.

## Stale tracking

Only reachable for vaults that still have legacy concept pages; a vault compiled today has nothing to go stale.

Autoprune (in `pipeline/autoprune.py`) stamps `stale_since=<iso-timestamp>` on concept pages whose cited KnowledgeDoc was removed but which have other remaining citations. Pages with no remaining citations are deleted entirely. No LLM cost during pruning. Its third sweep — deleting entities orphaned by a removed doc — went with the entity layer.

There is no refresh path: a stale page can only be repaired by deleting it, since nothing regenerates page bodies. `refresh_stale_pages()` and its two CLI surfaces (`vault refresh-stale-pages`, `index --wiki --refresh-stale-pages`) were removed with synthesis.

## Provenance chain

For wiki nodes, `retrieval.provenance(node_id)` walks the `CITES` chain:

- KnowledgeDoc returns its own metadata (this is the only case a vault compiled today produces)
- legacy concept Page → KnowledgeDoc, direct by sha (with sha256 + filename + acquired_at, plus the MIRRORS File twin id when present)

`agent`/`model`/`session`/`confidence` provenance was stamped at the page level; only pre-removal pages carry it. The third `derived` branch (walk `DERIVED_FROM` from an entity back to its source doc) went with the entity layer; those types now return `kind="unknown"`.

## Measured value — read this before optimising anything here

**[VALUE-ASSESSMENT.md](VALUE-ASSESSMENT.md)** is the self-contained finding from
six A/B benchmark runs (~$165). Short version: for docs that already live in the
repo, read by a frontier model that can open files, this layer shows **no
detectable answer-quality benefit and ~18% higher cost**. Three clean runs, all
negative, sign stable across both arm slots.

The mechanistic reason matters more than the scores, because it doesn't depend on
the benchmark being trustworthy: every component here is either inferable from the
path (the gloss, the status), noisier than the raw text (the entity graph — since
removed), or a lossy subset of it (`LINKS_TO` covers 189 of 401 files) — because
the source is already perfectly indexed by the filesystem. An index earns its keep by
substituting for expensive search, and in-repo that search is nearly free.

Consequences for anyone working in this module:

- `--wiki` is opt-in and nothing needs unshipping. What's bounded is the *claim*:
  "your docs in one graph with your code" is supported; "better answers" is not.
- **Don't re-attempt these** — both worked technically and changed no outcome:
  annotating `find_orphans` with its population (the agent read the caveat, used
  it correctly, still lost the question), and levelling the File/KnowledgeDoc read
  caps (fixed the diagnosed question, verdict unchanged).
- The benchmark **cannot detect benefit** — the control arm sits at 97–99%. Treat
  "no significant difference" from it as uninformative, not as evidence of absence.
- The designed-for case — docs *outside* the repo — now has a harness
  (`vault-benchmark-2/out-of-repo/`) and one smoke datapoint (2026-07-31,
  15-doc clean corpus): a vault-ONLY arm (no file tools at all) tied full
  native file access on quality at comparable cost. That supports
  **sufficiency** (vault-only ≈ having the files — the access claim), not
  superiority; the informative fixture (real messy export, 50+ docs) hasn't
  been run. Recurring measured weakness across all benchmarks: exhaustiveness
  on coverage questions (ranked retrieval + selective reading stops early;
  the arm calls `list_nodes` and still under-reads). The pre-registered
  response shipped 2026-07-31: `retrieval/grep.py` now sweeps a vault's
  CORPUS (every member doc's normalized body, hits joined to doc
  id/title/status — see retrieval/CLAUDE.md), giving a vault-only agent the
  same exhaustive contact the folder arm won those questions with. Effect on
  coverage questions is not yet re-measured.

## Closed

- **The LLM-extracted entity layer: removed 2026-08-04.** `Idea` / `Service` /
  `Module` / `Paper` / `Person` / `Event` nodes, their `DERIVED_FROM` /
  `SEMANTIC_EDGE` edges, and the `MENTIONS` bridge from content to them are no
  longer produced. **Do not re-add this.** Five measurements closed it, and the
  first is the decisive one:

  1. **Zero usage across three benchmark runs.** Once corpus `grep` existed, the
     agent never once reached for an entity node to answer a question. An index
     layer nothing queries is pure cost.
  2. **It crowded out the documents it came from.** Entity names are short, BM25
     normalises by length, so entities took ~half the top-3 FTS slots on a
     25-doc index — ahead of the labelled docs they were extracted from. The
     mitigation (an `exclude_llm_entities` default on `search_graph`) worked, and
     went away with the layer: filtering a layer out of the default search is a
     tell that the layer isn't earning its place.
  3. **Names fragmented one concept into five nodes.** "Cold chain",
     "Cold-chain integrity", "Cold-chain monitoring", … each became its own
     node, so the abstraction that was supposed to join documents about one
     subject instead split them.
  4. **One real-world thing landed under two types.** `Midwest Beef Co` was
     extracted as both a `Service` and a `Person`, in the same corpus.
  5. **Extraction was only ~65% stable run to run.** Re-ingesting the same
     corpus produced a materially different graph, so nothing downstream could
     treat entity presence or absence as a fact.

  It also produced a whole class of bugs whose only cause was the layer existing
  — `MENTIONS` restating `DERIVED_FROM` (twice: once from `derived_pairs` not
  covering re-compiles, once from stale edges needing a self-heal pass). And a
  separate measurement showed the `entities`/`edges` fields were *competing with
  the doc summary* inside the same extraction call.

  What replaced it is what the benchmark actually used: **normalized bodies, a
  title + one-line summary, epistemic `status`, author-written doc→doc
  `LINKS_TO`, exhaustive `grep` and `list_nodes`, verbatim `load_source`.** The
  node types stay in `store/constants.py` and the proto (they are also legacy
  runtime types, and leaving them keeps older graphs readable) — they are simply
  types nothing writes.

- **Concept pages: dropped 2026-08-03.** The pages variant was the worst result
  on record (88.4% vs a 98.6% control, −10.2pp) — see VALUE-ASSESSMENT.md. The
  synthesis pipeline (`resolve.py`, `execute.py`, `verify.py`,
  `refresh_stale_pages`, `--wiki-concept-pages`, `--refresh-stale-pages`,
  `OT_WIKI_CONCEPT_MIN_SOURCES`) is gone. The read surface stays for legacy
  vaults.
- **Concepts as bodiless graph nodes — closed, not deferred.** This was the safe
  salvage of the concept map: key a node on `(topic, subject)` from the per-doc
  mentions, hang each doc's own gloss on the doc→concept edge, never fuse the
  glosses into prose. Two findings closed it. (1) The `concepts` field was
  *competing* with the entity inventory for the same content — removing it raised
  entity yield ~20%. That argument is now moot (the entity inventory is gone too)
  but the conclusion is unchanged and strengthened: the layer this proposed was a
  variant of the one removed 2026-08-04. (2) Corpus `grep` answers the query the
  concept layer existed to answer
  ("what does the corpus say about X") with verbatim lines from every doc,
  pre-labelled with title/status — no restatement, no clustering to get wrong.

## Still deferred

- **OT-1732's success criterion 1 is not met.** It asks for "quality matching or
  exceeding what the same agent achieves over a folder of markdown files"; for
  in-repo docs the measured answer is no. Its *scope* is the seven MCP retrieval
  primitives, which are built and working — the comparison bar is what fails.
  Recorded on the ticket 2026-07-31; the open decision is whether to re-scope that
  criterion to the out-of-repo case.
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
