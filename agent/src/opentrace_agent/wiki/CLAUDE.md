# Wiki

Knowledge-compilation pipeline that turns raw doc files into a folder of interconnected markdown pages (the "vault") and mirrors the result into the graph store. Driven by ``opentraceai index --wiki`` — there is no separate ``wiki compile`` command anymore.

This is now the **single doc-ingestion path**: the one per-doc LLM call (`doc_extraction.py`) emits the CorpusDoc's navigation label (title + one-line summary), the concept inventory, AND the knowledge-graph entities + edges in a single shot. There are **no per-document wiki pages** — the raw doc body lives in the corpus and is read directly (`load_source`); concept pages are the only page kind. The entities are merged (`pipeline/entity_merge.py`) and mirrored to the graph alongside the vault. The old standalone `pipeline/entity_extraction.py` stage has been removed.

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
  doc_extraction.py   — Extract + Map: 1 LLM call/doc → CorpusDoc label (title
                        + one-liner) AND that doc's concept inventory
                        (topic/subject/gloss) AND the entity graph
  resolve.py          — Resolve stage: cluster concept mentions into concept
                        pages by (topic, subject); diff vs vault → create/extend
                        plan (OT_WIKI_CONCEPT_MIN_SOURCES floor)
  execute.py          — Synthesis stage: per-action create/extend LLM calls
  persist.py          — Persist stage: atomic disk writes + .vault.json update
  graph_writer.py     — Mirror vault to graph: Vault/Page/CorpusDoc +
                        CONTAINS/CITES/LINKS_TO/MENTIONS + MIRRORS edges
  pipeline.py         — Composer (sync generator); accepts scope= + project_root=
                        + graph_store=; also exports refresh_stale_pages()
```

## Concept discovery (Map → Resolve → Synthesise)

Concept pages are discovered by inventorying concepts per document, then
clustering them — not by one planner call enumerating everything (which
under-generated: it satisficed and missed central multi-doc concepts).

1. **Map** (folded into `doc_extraction.py`, cheap model): the per-doc call
   emits the CorpusDoc's navigation label (one-line summary; the display title is
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
   stays reachable through its labelled CorpusDoc node (raw body via
   `load_source`).
4. **Synthesise** (`execute.py`): one call per concept page, reading the **raw
   source bodies** (the corpus markdown on each `NormalizedSource`) — grounding
   synthesis in the full source yields more accurate, detailed pages (the
   LLM-wiki pattern). Provenance is structural (`CITES` edges to CorpusDoc nodes),
   so pages do not wiki-link documents; `[[links]]` are concept ↔ concept only.

Subject granularity is decided automatically by Level 1 above (no configuration)
— a single-library corpus collapses its sub-components into one subject, a
multi-entity corpus keeps its entities distinct.

## Storage layout

```
<project>/.opentrace/vaults/<name>/   # local scope (default for --wiki)
~/.opentrace/vaults/<name>/           # global scope; override root via $OT_VAULT_ROOT
  pages/concept/<base>.md         # multi-source synthesis pages (only kind)
  .vault.json
  .compile-log/<iso-ts>.json
```

Slugs are `<kind_dir>/<base>` (e.g. `concept/usage`). Concept is the only page kind; the kind folder stays so a future kind slots in without a layout migration. Generated by `wiki.slugify.unique_slug(title, kind=...)`; the folder name comes from `kind_dir(kind)`.

**Disk is the source of truth for page bodies.** The graph holds metadata + relationships, with bodies referenced by `corpus_path`. LadybugDB caps STRING properties at ~4 KB; vault page bodies typically run 5–20 KB, so they live on disk and are referenced by relative path.

The body of each raw document (post-markitdown) lives at a scope-aware corpus dir. `CorpusDoc` nodes carry `corpus_path` (stored relative to `.opentrace/`) pointing there:

- **Local vaults** (or any compile that's mirroring to a graph store) → `<db_dir>/corpus/<sha>.md`, typically `<project>/.opentrace/corpus/`.
- **Global vaults compiled without a graph store** → `~/.opentrace/corpus/<sha>.md` (or `$OT_VAULT_ROOT`'s parent + `/corpus/`). On `vault attach`, the corpus is copied sha-by-sha into the attaching project's corpus dir so `CorpusDoc.corpus_path` resolves locally.

The helper APIs are `sources.markdown.corpus_dir_for_scope(scope, project_root)`, `write_corpus_markdown_to(dir, sha, md)`, and `copy_corpus_between_scopes(...)`.

## Scope

Vaults are scoped at compile time:

- ``scope="local"`` → ``<project_root>/.opentrace/vaults/<name>/``. Visible only to graphs in that project. The default for ``opentraceai index --wiki``.
- ``scope="global"`` → ``~/.opentrace/vaults/<name>/`` (or ``$OT_VAULT_ROOT``). Attachable from any project via ``opentraceai vault attach <name>``.

The `Vault` graph node carries `scope` + `mirror_compiled_at`. `mirror_compiled_at` is set by `write_vault_to_graph` on every run; `vault list` compares it against the disk vault's `last_compiled_at` to flag stale mirrors.

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

- `Vault` — id `vault::<name>`. Carries `vault` (denormalised), `last_compiled_at`, `summary`, `scope`, `mirror_compiled_at`, and `spawned_from` (repo id) when the vault was built by `index --wiki` over a repo. `spawned_from` is stamped by `link_vault_to_repo` after the mirror and carried forward on re-mirrors.
- `Page` nodes — id `<vault>::<slug>` where slug is `<kind_dir>/<base>` (e.g. `kb::concept/usage`). Carries `slug`/`vault`/`kind` (`concept`)/`one_line_summary`/`revision`/`last_updated`. Pages compiled this run get `agent`/`model`/`session` provenance stamped plus `confidence` + `confidence_tier` (concept → INFERRED/0.75). Pages not in `compiled_slugs` keep their existing provenance.
- `CorpusDoc` nodes — id `corpus::<sha256-of-raw-bytes>`. Carries `sha256`/`filename`/`content_type`/`size_bytes`/`acquired_at`/`corpus_path` plus the navigation label: `title` and `one_line_summary`/`summary` (the `summary` copy feeds `build_search_text` so CorpusDocs are FTS-findable by label), and `path` (repo-relative) when the doc came from a repo walk. Labels come from this run's extraction or, on re-mirror/attach, from `.vault.json`'s `IngestedSource` (which persists them) or the previously-written node. Sha-keyed deduplication across vaults.
- `CONTAINS` — Vault → Page, Vault → CorpusDoc.
- `CITES` — concept page → CorpusDoc, direct by sha (one hop; no intermediate pages).
- `LINKS_TO` — per `[[Title]]` occurrence in any page body (concept ↔ concept).
- `MENTIONS` — per entity name match in a concept-page body OR a document's raw corpus markdown (case-insensitive except for Person). Bridges content ↔ entity layers: `Page → entity` and `CorpusDoc → entity`. Matching over raw bodies gives per-document granularity with better coverage than any summary (the raw body is a superset). **Deduped against `DERIVED_FROM`**: a `CorpusDoc → entity` MENTIONS is skipped when that entity was extracted *from* that doc (`entity -DERIVED_FROM-> doc` already encodes it, and is the stronger claim) — see `write_vault_to_graph(derived_pairs=...)`. So MENTIONS from a doc is exactly the entities it references but did NOT originate. Consumers wanting "every doc referencing X" union MENTIONS with incoming `DERIVED_FROM` (the `retrieval.cross_cutting` helpers do this).
- `MIRRORS` — CorpusDoc → File, written by `link_corpus_doc_mirrors` after an `index --wiki` directory run for every repo-walked doc. When the code walk didn't produce the File node (extensions outside `INCLUDED_EXTENSIONS` — `.rst`/`.txt`/`.html`/PDFs), `_ensure_file_twin` creates it (plus any missing ancestor Directory nodes) so the twin always exists. No edge for docs that didn't come from a repo walk (uploads, URLs, attached global vaults). Entities always anchor to CorpusDocs (`DERIVED_FROM`); if code-derived entities are ever introduced they anchor to File, and MIRRORS keeps the two worlds joined.
- `DOCUMENTS` — Repository → Vault, written by `link_vault_to_repo` in the same `index --wiki` post-compile step as MIRRORS. Marks the vault as spawned from that repo (paired with the `spawned_from` vault property). Attached globals and dropped-file compiles never get it — they live alongside a repo without documenting it.

Graph-write failures are caught and emitted as non-fatal warnings — the on-disk vault stays valid. Recover with:

```
opentraceai vault attach <name>
```

## Wiki-link parser

`graph_writer.parse_wiki_links(body)` extracts targets from `[[Title]]` and `[[Title|alias]]` Obsidian-style forms. Targets are stripped of whitespace and deduped in document order. The renderer in `ui/src/components/wiki/` uses the same syntax.

Resolution accepts both bare and kinded forms: `[[Title]]` matches unambiguously when only one kind has that title; `[[concept/Title]]` always resolves to the named kind. Bare targets whose title appears in multiple kinds drop to "broken" so the page surfaces the ambiguity rather than silently picking one.

## Stale tracking + refresh

Autoprune (in `pipeline/autoprune.py`) stamps `stale_since=<iso-timestamp>` on concept pages whose cited CorpusDoc was removed but the page has other remaining citations. Pages with no remaining citations are deleted entirely. No LLM cost during pruning.

Refresh via `wiki.ingest.pipeline.refresh_stale_pages(graph_store, vault_name=..., ...)` — re-runs `_execute_extend` against the page's current `CITES` set, clears `stale_since`, bumps `revision`. Exposed as:

- `opentraceai vault refresh-stale-pages` (standalone)
- `opentraceai index --wiki --refresh-stale-pages` (inline with the next compile)

## Provenance chain

For wiki nodes, `retrieval.provenance(node_id)` walks the `CITES` chain:

- concept Page → CorpusDoc, direct by sha (with sha256 + filename + acquired_at, plus the MIRRORS File twin id when present)
- CorpusDoc returns its own metadata

`agent`/`model`/`session`/`confidence` provenance is stamped at the page level.

## Still deferred

- Pages are LLM-managed. Human edits to `pages/<slug>.md` are not preserved across compilations (next compile overwrites).
- Per-page LLM self-rated confidence — the rubric is wired but pages always default to `INFERRED`/0.75 today. Future: have Execute return a per-page tier.
- Production blob store — currently local disk ([OT-1745](https://linear.app/opentrace/issue/OT-1745)).
- Per-vault ingestions are serialized via `fcntl.flock` on `.vault.json`.

## Public docs

User-facing references (keep in lockstep with this file):

- `docs/getting-started/wiki.md` — end-to-end vault workflow
- `docs/getting-started/indexing.md` — `index --wiki` flags
- `docs/reference/vault-commands.md` — `vault` subcommand reference
- `docs/reference/cli-flags.md` — full flag list
- `docs/architecture/ontology.md` — node + edge type catalog
