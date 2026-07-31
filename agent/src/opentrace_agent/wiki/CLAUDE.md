# Wiki

Doc-ingestion pipeline that indexes raw doc files into the graph store (the "vault") and, optionally, compiles cross-document concept pages. Driven by ``opentraceai index --wiki`` — there is no separate ``wiki compile`` command anymore.

This is the **single doc-ingestion path**: the one per-doc LLM call (`doc_extraction.py`) emits the KnowledgeDoc's navigation label (title + one-line summary), the concept inventory, AND the knowledge-graph entities + edges in a single shot. There are **no per-document wiki pages** — the raw doc body lives in the corpus and is read directly (`load_source`). The entities are merged (`pipeline/entity_merge.py`) and mirrored to the graph alongside the vault. The old standalone `pipeline/entity_extraction.py` stage has been removed.

## Corpus-only is the default; synthesis is opt-in

`run_compile(..., synthesize_pages=False)` is the default, and the CLI only sets it True under `--wiki-concept-pages`. So a plain `index --wiki` runs **Acquire → Normalize → Extract → Persist → Mirror** and stops: labelled KnowledgeDoc nodes, the entity graph, doc↔doc `LINKS_TO`, `MIRRORS` File twins, epistemic `status`, bodies verbatim in the corpus. No `KnowledgeConcept` nodes, no `pages/concept/*.md`, no `CITES` edges, and no flagship LLM calls beyond the per-doc extraction.

The agent-facing contract for this layer lives in `cli/mcp_server.py` and is load-bearing — the benchmark showed a capability the tools don't advertise is a capability that doesn't exist:

- **`load_source` on a KnowledgeDoc returns `status` + `statusNote`** alongside the body, plus `title`/`path`/`summary`. It originally returned filename/sha/body only, so the epistemic label was invisible at the moment of reading and the arm never once distinguished a proposal from shipped behaviour. A label that doesn't travel with the text does nothing.
- **`list_nodes` names the doc types** (`KnowledgeDoc`, `KnowledgeConcept`, the entity types) and states that it — not ranked `search_graph` — is what can establish absence. The arm called it *zero* times in 201 tool calls while the code arm called it 9×, and lost the corpus-enumeration question, because the docstring listed only code types.

Why the default flipped: synthesizing a page restates its sources in the model's own voice, which can strip their hedges, tense, and attribution — a failure mode a verbatim body structurally cannot have (four successive grounding patches all chased instances of it). And concept pages have not been shown to beat reading the labelled documents directly: on the code-Q&A benchmark the arm that read raw docs scored 98.6% while the vault arm lost ground when pages were consulted. So the corpus layer — whose value *is* measured (retrieval, labels, status) — ships on by default, and synthesis has to earn its way back in. Everything under Resolve/Execute/Verify below therefore only runs under `--wiki-concept-pages`.

## Layout

```
paths.py              — vault dir resolution + path-traversal validation;
                        scope-aware (local vs global) + resolve_vault_scope()
vault.py              — VaultMetadata pydantic model + .vault.json read/write
slugify.py            — title → slug, collision suffix, tombstones
index.py              — vault index (slug, title, summary) read from .vault.json
llm.py                — multi-provider client wrapper + BYOK key resolver
                        (delegates to sources/_llm_common.py for BACKENDS)
ingest/
  types.py            — WikiPipelineEvent, WikiPhase, Plan/PlanCreate/PlanExtend,
                        ConceptMention, ResolvedConcept, SourceInput,
                        NormalizedSource (with corpus_path)
  sources.py          — Acquire stage: file inputs + sha256 dedup
  normalize.py        — Normalize stage: lazy-imported markitdown wrapper
  doc_extraction.py   — Extract + Map: 1 LLM call/doc → KnowledgeDoc label (title
                        + one-liner) AND that doc's concept inventory
                        (topic/subject/gloss) AND the entity graph
  resolve.py          — Resolve stage (--wiki-concept-pages only): cluster
                        concept mentions into concept pages by (topic, subject);
                        diff vs vault → create/extend plan
                        (OT_WIKI_CONCEPT_MIN_SOURCES floor)
  execute.py          — Synthesis stage (--wiki-concept-pages only): per-action
                        create/extend LLM calls
  persist.py          — Persist stage: atomic disk writes + .vault.json update
  graph_writer.py     — Mirror vault to graph: Vault/Page/KnowledgeDoc +
                        CONTAINS/CITES/LINKS_TO/MENTIONS + MIRRORS edges;
                        parse_doc_links() + link_doc_to_doc_links() for the
                        authors' own doc→doc references
  pipeline.py         — Composer (sync generator); accepts scope= + project_root=
                        + graph_store= + synthesize_pages=; also exports
                        refresh_stale_pages()
```

## Concept discovery (Map → Resolve → Synthesise)

**Opt-in — everything in this section runs only under `--wiki-concept-pages`**
(`run_compile(synthesize_pages=True)`). The Map step is the exception: it is
folded into the per-doc extraction call and so runs on every compile, costing
nothing extra.

Concept pages are discovered by inventorying concepts per document, then
clustering them — not by one planner call enumerating everything (which
under-generated: it satisficed and missed central multi-doc concepts).

1. **Map** (folded into `doc_extraction.py`, cheap model): the per-doc call
   emits the KnowledgeDoc's navigation label (one-line summary; the display title is
   derived mechanically from the filename) plus that doc's concepts, each
   qualified by `topic` (subject matter), `subject` (the real-world entity it's
   a property *of* — the product/system, not the file), and a one-line `gloss`,
   plus the entity graph. No page body is generated — the raw doc is retained in
   the corpus and read directly. A doc too large to read in one extraction call
   is split on heading boundaries (`_chunk_markdown`), each part processed, and
   the parts merged into one label + one concept/entity inventory. Because the
   extraction output is small, the binding constraint is input context, so the
   threshold is generous (`DEFAULT_MAX_DOC_CHARS`, override
   `OT_WIKI_MAX_DOC_CHARS`) and the chunker is a rare safety net — small/medium
   docs (the common case) stay a single call.
2. **Resolve** (`resolve.py`, flagship model): cluster `ConceptMention`s in two
   passes, each over the small set of distinct *labels* (not the bulk mentions),
   so both fit a single call with a corpus-wide view:
   - **Level 1 — `_canonicalize_subjects`**: the only stage that sees every
     subject at once, so it's where "one system or many?" is decided. Folds
     aliases, case variants, and a project's companion packages (e.g. `pydantic`
     + `pydantic-core` + `pydantic-settings` → `pydantic`) into one canonical
     subject; keeps genuinely distinct entities (competitors, third-party tools)
     apart. This makes mono- vs multi-subject behaviour *emerge from the data* —
     there is no corpus-mode flag (a per-doc heuristic can't make a corpus-wide
     call).
   - **Level 2 — `_cluster_topics`**: with subjects canonical, the distinct
     `(subject, topic)` pairs (each carrying sample glosses) are organised into
     concept **pages at wiki granularity** — a broad concept and its finer
     sub-aspects become ONE page, with the sub-aspects recorded as a `sections`
     outline (page-vs-section, never keep-vs-drop: every pair is placed, nothing
     dropped). It's **scale-adaptive**: a small topic set (≤ `THEME_THRESHOLD`)
     groups in one open call; a large set uses a **two-step** approach —
     `_discover_themes` proposes the broad top-level pages first, then
     `_assign_to_themes` files every topic under one as a section. Committing to
     a small page set up front is what stops a large corpus fragmenting into a
     page-per-topic (an open "cluster these" call over hundreds of pairs
     satisfices toward fine granularity). Each page's `source_shas` is the union
     of every mention of a member pair — **derived from pair membership, never
     echoed by the model** (a garbled id can't drop a source). The `sections`
     outline is threaded through the plan into synthesis so each sub-topic is
     written as a `##` section. Every stage degrades gracefully (theme failure →
     open call → identity); unplaced pairs survive as their own page.
3. **Diff + floor** (`concepts_to_plan`): a concept whose title matches an
   existing concept page → EXTEND (no floor); a new concept is CREATEd only with
   ≥ `OT_WIKI_CONCEPT_MIN_SOURCES` sources (default 2) — single-source content
   stays reachable through its labelled KnowledgeDoc node (raw body via
   `load_source`).
4. **Synthesise** (`execute.py`): one call per concept page, reading the **raw
   source bodies** (the corpus markdown on each `NormalizedSource`) — grounding
   synthesis in the full source yields more accurate, detailed pages (the
   LLM-wiki pattern). Provenance is structural (`CITES` edges to KnowledgeDoc nodes),
   so pages do not wiki-link documents; `[[links]]` are concept ↔ concept only.

Subject granularity is decided automatically by Level 1 above (no configuration)
— a single-library corpus collapses its sub-components into one subject, a
multi-entity corpus keeps its entities distinct.

## Storage layout

```
<project>/.opentrace/vaults/<name>/   # local scope (default for --wiki)
~/.opentrace/vaults/<name>/           # global scope; override root via $OT_VAULT_ROOT
  pages/concept/<base>.md         # synthesis pages — --wiki-concept-pages only
  .vault.json
  .compile-log/<iso-ts>.json
```

A default (corpus-only) compile writes `.vault.json` + `.compile-log/` and leaves `pages/` empty — the doc bodies live in the corpus dir described below, not in the vault.

Slugs are `<kind_dir>/<base>` (e.g. `concept/usage`). Concept is the only page kind; the kind folder stays so a future kind slots in without a layout migration. Generated by `wiki.slugify.unique_slug(title, kind=...)`; the folder name comes from `kind_dir(kind)`.

**Disk is the source of truth for page bodies.** The graph holds metadata + relationships, with bodies referenced by `corpus_path`. LadybugDB caps STRING properties at ~4 KB; vault page bodies typically run 5–20 KB, so they live on disk and are referenced by relative path.

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
name was suffixed on first creation. The serve compile route takes an
`on_conflict` form field (`suffix` for a new-vault compile, `append` to update in
place).

## Graph mirror

`run_compile(graph_store=..., scope="local"|"global")` mirrors the post-compile vault state into the graph after disk writes succeed:

- `KnowledgeVault` — id `vault::<name>`. Carries `vault` (denormalised), `last_compiled_at`, `summary`, `scope`, `mirror_compiled_at`, and `spawned_from` (repo id) when the vault was built by `index --wiki` over a repo. `spawned_from` is stamped by `link_vault_to_repo` after the mirror and carried forward on re-mirrors.
- `KnowledgeConcept` nodes — id `<vault>::<slug>` where slug is `<kind_dir>/<base>` (e.g. `kb::concept/usage`). Carries `slug`/`vault`/`kind` (`concept`)/`one_line_summary`/`revision`/`last_updated`. Pages compiled this run get `agent`/`model`/`session` provenance stamped plus `confidence` + `confidence_tier` (concept → INFERRED/0.75). Pages not in `compiled_slugs` keep their existing provenance.
- `KnowledgeDoc` nodes — id `corpus::<sha256-of-raw-bytes>`. Carries `sha256`/`filename`/`content_type`/`size_bytes`/`acquired_at`/`corpus_path` plus the navigation label: `title` and `one_line_summary`/`summary` (the `summary` copy feeds `build_search_text` so KnowledgeDocs are FTS-findable by label), and `path` (repo-relative) when the doc came from a repo walk. Labels come from this run's extraction or, on re-mirror/attach, from `.vault.json`'s `IngestedSource` (which persists them) or the previously-written node. Sha-keyed deduplication across vaults.
- `CONTAINS` — Vault → Page, Vault → KnowledgeDoc.
- `CITES` — concept page → KnowledgeDoc, direct by sha (one hop; no intermediate pages). `--wiki-concept-pages` only.
- `LINKS_TO` — two distinct producers, same edge type:
  - **KnowledgeDoc → KnowledgeDoc** — the authors' *own* cross-references, parsed mechanically (no LLM) from each doc's relative markdown links, reference-style definitions, and raw HTML anchors by `parse_doc_links` and written by `link_doc_to_doc_links` in the same post-compile step as MIRRORS. The doc-side analogue of the code graph's import edges: it records structure a human declared, never anything a model inferred. Targets resolve against the linking doc's own directory (`/docs/x.md` is treated as repo-root-relative); external URLs, fragment-only links, and paths escaping the repo root are dropped, and resolution itself is the filter — a link to a `.py` file or an image finds no KnowledgeDoc and is skipped. Repo-walked runs only (needs repo-relative paths).
  - **KnowledgeConcept → KnowledgeConcept** — per `[[Title]]` occurrence in a page body. `--wiki-concept-pages` only.
- `MENTIONS` — per entity name match in a concept-page body OR a document's raw corpus markdown (case-insensitive except for Person). Bridges content ↔ entity layers: `Page → entity` and `KnowledgeDoc → entity`. Matching over raw bodies gives per-document granularity with better coverage than any summary (the raw body is a superset). **Deduped against `DERIVED_FROM`**: a `KnowledgeDoc → entity` MENTIONS is skipped when that entity was extracted *from* that doc (`entity -DERIVED_FROM-> doc` already encodes it, and is the stronger claim) — see `write_vault_to_graph(derived_pairs=...)`. So MENTIONS from a doc is exactly the entities it references but did NOT originate. Consumers wanting "every doc referencing X" union MENTIONS with incoming `DERIVED_FROM` (the `retrieval.cross_cutting` helpers do this).
- `MIRRORS` — KnowledgeDoc → File, written by `link_corpus_doc_mirrors` after an `index --wiki` directory run for every repo-walked doc. When the code walk didn't produce the File node (extensions outside `INCLUDED_EXTENSIONS` — `.rst`/`.txt`/`.html`/PDFs), `_ensure_file_twin` creates it (plus any missing ancestor Directory nodes) so the twin always exists. No edge for docs that didn't come from a repo walk (uploads, URLs, attached global vaults). Entities always anchor to KnowledgeDocs (`DERIVED_FROM`); if code-derived entities are ever introduced they anchor to File, and MIRRORS keeps the two worlds joined.
- `DOCUMENTS` — Repository → Vault, written by `link_vault_to_repo` in the same `index --wiki` post-compile step as MIRRORS. Marks the vault as spawned from that repo (paired with the `spawned_from` vault property). Attached globals and dropped-file compiles never get it — they live alongside a repo without documenting it.

Graph-write failures are caught and emitted as non-fatal warnings — the on-disk vault stays valid. Recover with:

```
opentraceai vault attach <name>
```

## Link parsers

Two parsers, one per producer of `LINKS_TO` (see the graph-mirror section):

**`graph_writer.parse_wiki_links(body)`** — page ↔ page. Extracts targets from `[[Title]]` and `[[Title|alias]]` Obsidian-style forms. Targets are stripped of whitespace and deduped in document order. The renderer in `ui/src/components/wiki/` uses the same syntax.

Resolution accepts both bare and kinded forms: `[[Title]]` matches unambiguously when only one kind has that title; `[[concept/Title]]` always resolves to the named kind. Bare targets whose title appears in multiple kinds drop to "broken" so the page surfaces the ambiguity rather than silently picking one.

**`graph_writer.parse_doc_links(body)`** — doc → doc, and the one that runs by default. Extracts in-repo relative targets from inline markdown links (`[t](./guide.md)`, angle-bracket and `%20` forms included), reference-style definitions (`[g]: docs/guide.md`), and raw HTML anchors. Fragments and query strings are stripped (`guide.md#setup` → `guide.md`); external targets (`http:`, `mailto:`, protocol-relative `//`) and fragment-only links are dropped; results are deduped in document order.

`link_doc_to_doc_links(store, named_blobs)` then resolves each target against the linking doc's own directory via `posixpath` (leading `/` means repo-root-relative), drops anything normalizing outside the repo root, and merges one edge per distinct target pair — so `guide.md`, `./guide.md`, and `guide.md#top` collapse to a single edge, and self-links are skipped. Bodies come from the corpus (post-markitdown, so an `.html` doc's anchors are already markdown) with a raw-bytes decode as fallback. Docs dropped by the content gate have no node and are silently skipped.

## Stale tracking + refresh

Only relevant to vaults that have concept pages (compiled under `--wiki-concept-pages`); a corpus-only vault has nothing to go stale.

Autoprune (in `pipeline/autoprune.py`) stamps `stale_since=<iso-timestamp>` on concept pages whose cited KnowledgeDoc was removed but the page has other remaining citations. Pages with no remaining citations are deleted entirely. No LLM cost during pruning.

Refresh via `wiki.ingest.pipeline.refresh_stale_pages(graph_store, vault_name=..., ...)` — re-runs `_execute_extend` against the page's current `CITES` set, clears `stale_since`, bumps `revision`. Exposed as:

- `opentraceai vault refresh-stale-pages` (standalone)
- `opentraceai index --wiki --refresh-stale-pages` (inline with the next compile)

## Provenance chain

For wiki nodes, `retrieval.provenance(node_id)` walks the `CITES` chain:

- concept Page → KnowledgeDoc, direct by sha (with sha256 + filename + acquired_at, plus the MIRRORS File twin id when present)
- KnowledgeDoc returns its own metadata

`agent`/`model`/`session`/`confidence` provenance is stamped at the page level.

## Measured value — read this before optimising anything here

**[VALUE-ASSESSMENT.md](VALUE-ASSESSMENT.md)** is the self-contained finding from
six A/B benchmark runs (~$165). Short version: for docs that already live in the
repo, read by a frontier model that can open files, this layer shows **no
detectable answer-quality benefit and ~18% higher cost**. Three clean runs, all
negative, sign stable across both arm slots.

The mechanistic reason matters more than the scores, because it doesn't depend on
the benchmark being trustworthy: every component here is either inferable from the
path (the gloss, the status), noisier than the raw text (the entity graph), or a
lossy subset of it (`LINKS_TO` covers 189 of 401 files) — because the source is
already perfectly indexed by the filesystem. An index earns its keep by
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
- The untested case is the one the feature was designed for: docs *outside* the
  repo, or a corpus too large to sweep. That needs a new question set, not another
  run.

## Still deferred

- **Concept pages: recommend dropping, not deferring.** The pages variant is the
  worst result on record (88.4% vs a 98.6% control, −10.2pp) — see
  VALUE-ASSESSMENT.md. `--wiki-concept-pages` remains an experiment flag; OT-1732's
  scope still lists pages as a deliverable and should be updated.
- **Concepts as bodiless graph nodes** — the safe salvage of the concept map if the gap above shows up: key a node on `(topic, subject)` from the mentions the extraction call already produces, hang each doc's own gloss on the doc→concept edge, and never fuse the glosses into one prose body. Structure without restatement. `resolve.py`'s clustering would survive as node-merging (exact-match keying fragments: "validation" vs "data validation").
- Pages are LLM-managed. Human edits to `pages/<slug>.md` are not preserved across compilations (next compile overwrites).
- Per-page LLM self-rated confidence — the rubric is wired but pages always default to `INFERRED`/0.75 today. Future: have Execute return a per-page tier.
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
