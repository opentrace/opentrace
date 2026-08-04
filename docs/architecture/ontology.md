# Ontology

Full node + edge type reference for the OpenTrace knowledge graph. For the high-level layered view, see [Architecture Overview](overview.md).

## Domains

The graph organises into three domains:

| Domain | What lives there | Produced by |
|---|---|---|
| **code** | `Repository`, `Directory`, `File`, `Class`, `Function`, `Variable`, `Dependency` | `opentraceai index` (tree-sitter) |
| **page** | `KnowledgeVault`, `KnowledgeDoc` | `opentraceai index --wiki` / `vault ingest` (doc ingestion) |
| **page** | `KnowledgeConcept` | nothing — see below |
| **entity** | `Idea`, `Service`, `Module`, `Paper`, `Person`, `Event` | nothing — see below |

Doc ingestion is corpus-only: it indexes the documents (labels, epistemic status, doc↔doc links, `File` twins) and keeps their bodies verbatim.

### Types that remain valid but are no longer produced

Two layers were measured and removed. Their node and edge types stay in the ontology so a graph built before the removal is still readable, and a re-compile of such a graph keeps mirroring what it already has. **Nothing writes them on a fresh index.**

- **`KnowledgeConcept` + `CITES` — removed 2026-08-03.** A concept-page synthesis stage produced them. It measured 88.4% against a 98.6% control: restating a source strips its hedges, tense, and attribution.
- **The entity domain (`Idea`, `Paper`, `Person`, `Event`) + `DERIVED_FROM`, `SEMANTIC_EDGE`, `MENTIONS`, `Hyperedge`, `PARTICIPATES_IN` — removed 2026-08-04.** An LLM pass extracted typed entities from each document and linked them. Five measurements retired it: **zero agent usage across three benchmark runs** once corpus `grep` existed; entity nodes **crowded labelled documents out of the top search slots** (short names win BM25); extraction was only **~65% stable run to run**; names **fragmented one concept into five nodes** ("Cold chain", "Cold-chain integrity", "Cold-chain monitoring", …); and the same real-world thing landed under **two different types** (`Midwest Beef Co` as both `Service` and `Person`). "Which documents discuss X" is now answered by `grep` over the corpus — exhaustive, verbatim, and pre-labelled with each doc's title and status.

  Note that `Service` and `Module` are *also* pre-existing runtime node types written by other producers, so those two names remain in active use.

What replaced both: the document itself. A `KnowledgeDoc` carries a title, a one-line summary, and an epistemic `status`; its normalized body is verbatim in the corpus, readable with `load_source`, enumerable with `list_nodes`, and sweepable with `grep`.

Auxiliary types (`Community`, `Hyperedge`, `IndexMetadata`) are produced by cluster / analyze / index-bookkeeping and aren't part of any domain.

## Node reference

### Code domain

#### `Repository`

A code repository.

- `id` — repo identifier (typically `owner/name` or `local/<basename>`)
- `name` — display name
- `ref` — branch or tag
- `source_uri` — URL when cloned remote
- `provider` — `github` / `gitlab` / etc.
- `default_branch`, `summary`
- `local_path` — filesystem path when locally indexed (used by `retrieval.grep`)

#### `Directory`

A directory in a repo.

- `id` — `<repo_id>/<rel-path>`
- `path`, `summary`

#### `File`

A source file (tree-sitter-parsed).

- `id` — `<repo_id>/<rel-path>`
- `path`, `extension`, `language`, `lines`
- `source_uri` — `<repo>/blob/<ref>/<path>` for cloned remotes

#### `Class`

A class / struct / interface / record / type alias.

- `id` — `<file_id>::<class-name>`
- `name`, `language`, `start_line`, `end_line`, `signature`, `docs`
- `kind` — `"class" | "struct" | "interface" | "record" | "dataclass" | "type_alias"`
- `superclasses` (string[]), `interfaces` (string[])

#### `Function`

A function or method.

- `id` — `<file_id>::<function-name>` or `<class_id>::<method-name>`
- `name`, `language`, `start_line`, `end_line`, `signature`, `docs`

#### `Variable`

A field / parameter / module-level variable.

- `id` — `<scope_id>::<var-name>`
- `kind` — `"parameter" | "local" | "field"`
- `type_annotation`, `exported`

#### `Dependency`

External package from a manifest (`package.json`, `pyproject.toml`, `go.mod`, etc.).

- `id` — `pkg:<registry>:<name>`
- `version`, `registry`

### Entity domain (no longer produced)

Retained for reading graphs built before 2026-08-04 — see [above](#types-that-remain-valid-but-are-no-longer-produced). All entity-type nodes share the same shape:

- `id` — `<source-stem>_<entity-slug>` (lowercased, [a-z0-9_])
- `name` — human-readable label
- `derived_from` — id of the `KnowledgeDoc` the entity came from
- `source_uri` — copied from the originating doc for quick reference
- `vault` — vault name when produced via `--wiki`

The type discriminator (`Idea` / `Service` / `Module` / `Paper` / `Person` / `Event`) is the node type itself, with `Idea` as the catch-all bucket.

### Knowledge domain

#### `KnowledgeVault`

A named collection of ingested documents (one vault node per disk vault dir), plus any legacy concept pages the vault still carries.

- `id` — `vault::<name>`
- `name` — display name
- `last_compiled_at` — ISO-8601 timestamp from `.vault.json`
- `scope` — `"local"` or `"global"`
- `mirror_compiled_at` — when this graph's mirror was last written. `vault list` compares against `last_compiled_at` to flag stale mirrors
- `spawned_from` — repo id when the vault was built by `index --wiki` over that repository (paired with the `DOCUMENTS` edge); empty for uploads/URL compiles and attached globals
- `summary`, `vault`

#### `KnowledgeConcept`

A single synthesized page in a vault. **Nothing produces these** — synthesis was removed 2026-08-03, so only a vault compiled before then has any. Those pages keep being read from disk and mirrored, so the type is still live in the read path (`vault show --page`, `read_vault_page`, `provenance`, the UI renderer). Body lives on disk under `pages/<slug>.md`, where the slug is `<kind_dir>/<base>` — e.g. `concept/usage.md`. Concept pages are the only page kind: per-doc content isn't paged, it lives on the labelled `KnowledgeDoc` node (see below) with the raw body in the corpus.

- `id` — `<vault>::<slug>` (e.g. `kb::concept/revenue`)
- `name` — page title
- `slug` — `<kind_dir>/<base>` (e.g. `concept/revenue`)
- `kind` (`"concept"`), `one_line_summary`, `revision`, `last_updated`
- `vault` — owning vault name
- Provenance (stamped when the page was compiled): `agent`, `model`, `session`, `confidence` (0.0–1.0), `confidence_tier` (`EXTRACTED` / `INFERRED` / `AMBIGUOUS`)
- `stale_since` — ISO-8601 timestamp set by autoprune when a cited KnowledgeDoc was removed but the page still has other citations. There is no refresh path; delete the page instead

`concept` pages carry `INFERRED` / 0.75 confidence — a fixed value, never self-rated.

#### `KnowledgeDoc`

A raw ingested artifact — every doc ingested by `index --wiki` (wiki uploads included) uses this shape.

- `id` — `corpus::<sha256-of-raw-bytes>`
- `name` — original filename or title
- `title` — navigation label derived from the filename (set by the per-doc DocExtraction call)
- `one_line_summary` — LLM-written one-liner; `summary` carries a copy so the label feeds FTS via `search_text`
- `sha256`, `filename`, `content_type` (MIME), `size_bytes`, `acquired_at`
- `corpus_path` — relative path to the body file in `.opentrace/corpus/` (readable via the `load_source` tool)
- `path` — repo-relative path, stamped (alongside the `MIRRORS` edge) when the doc came from a repo walk
- `status` — epistemic label from the doc's location: `authoritative` (current documentation), `design_history` (openspec / ADR / RFC / proposal trees, CHANGELOGs), or `design_history_archived` (design history under an archive folder, likely superseded)
- `source_uri` — original URL when ingested from web; file path when from disk
- `vault` — owning vault name (set when produced via `--wiki`)

### Auxiliary

#### `Community`

A cluster detected by Leiden or Louvain.

- `id`, `name`, `community_id`, `cohesion` (0.0–1.0), `members` (count), `is_god` (top-10% by size)

#### `Hyperedge`

A set of three or more entities that act as one unit (a workflow, a layered design, a recurring theme). Proposed by an LLM pass that ran after entity extraction — **no longer produced** (see [above](#types-that-remain-valid-but-are-no-longer-produced)).

- `id`, `name`, `relation`, `confidence` (tier), `confidence_score`, `source_file`

#### `IndexMetadata`

Per-repo provenance for the most recent `index` run.

- `id` — `_meta:index:<repo_id>`
- `indexed_at`, `duration_seconds`, `repo_id`, `repo_path`, `commit_sha`, `commit_message`, `branch`, `opentraceai_version`, counts

Excluded from default cluster + analysis walks (it's bookkeeping, not data).

## Edge reference

### Structural

| Edge | From → To | Meaning |
|---|---|---|
| `CONTAINS` | parent → child | Hierarchy. `Repository → Directory`, `Directory → File`, `KnowledgeVault → KnowledgeConcept/KnowledgeDoc` |
| `DEFINES` | container → symbol | `File → Class/Function`, `Class → Function`, `Class → Variable` |
| `CALLS` | `Function → Function` | Resolved call via 7-strategy resolver |
| `IMPORTS` | `File → Dependency` | Resolved import |
| `DEPENDS_ON` | `Repository → Dependency` | Manifest dependency |

### Entity provenance (no longer produced)

Retained for reading graphs built before 2026-08-04 — see [above](#types-that-remain-valid-but-are-no-longer-produced).

| Edge | From → To | Meaning |
|---|---|---|
| `DERIVED_FROM` | entity → KnowledgeDoc | Entity came from analyzing this doc. Carries `transform="llm_extraction"` |
| `SEMANTIC_EDGE` | entity → entity | LLM-proposed relationship. Carries `relation`, `confidence` tier, `confidence_score`, `source_file`, optional `source_location`, optional `weight` |

`DERIVED_FROM` is also written between `Variable` nodes by the code pipeline's derivation resolution — that use is unaffected and current.

### Knowledge provenance

| Edge | From → To | Meaning |
|---|---|---|
| `CITES` | concept page → KnowledgeDoc | Direct provenance link, keyed by doc sha (one hop). `retrieval.provenance` walks this for wiki nodes. Only exists where concept pages do — legacy vaults; nothing writes new ones |
| `LINKS_TO` | KnowledgeDoc → KnowledgeDoc | A relative link the doc's **author** wrote to another doc — the doc-side analogue of the code graph's `IMPORTS`. Parsed mechanically (no LLM) from markdown inline links, reference-style definitions, and HTML anchors by `graph_writer.parse_doc_links`, then resolved against the linking doc's own directory; repo-root-relative targets (`/docs/x.md`) are supported. External URLs, bare `#fragment` targets, paths escaping the repo root, and targets that aren't another indexed doc produce no edge. Written on repo-walked `--wiki` runs that mirror to the graph — like `MIRRORS` it needs repo-relative paths, so single-file / URL compiles and disk-only global vaults get no doc↔doc edges |
| `LINKS_TO` | KnowledgeConcept → KnowledgeConcept | `[[Title]]` wiki-link in a page body. Pages reference each other by title; graph_writer resolves to slug. Legacy vaults only |

### Cross-layer

| Edge | From → To | Meaning |
|---|---|---|
| `MENTIONS` | KnowledgeConcept/KnowledgeDoc → entity | **No longer produced** (see [above](#types-that-remain-valid-but-are-no-longer-produced)). Bridged the page and entity layers by matching an entity's name in a doc body. Use `grep` for "which documents discuss X" |
| `MIRRORS` | KnowledgeDoc → File | The ingested doc's twin in the code tree. Emitted during `index --wiki` on a directory for every repo-walked doc; the KnowledgeDoc gets a repo-relative `path` property stamped. When the code walk didn't create the File node (extensions like `.rst`/`.txt`/`.html`/PDFs), it is created at link time so the twin always exists. Docs not from a repo walk (uploads, URLs, attached global vaults) have no edge. Bridges the corpus layer and the code tree — either twin reaches the other in one hop, and provenance chains include the mirrored File id |
| `DOCUMENTS` | Repository → KnowledgeVault | The vault spawned from this repo. Written only by `index --wiki` runs where the wiki compile executes alongside a repo walk (the vault also gets a `spawned_from` stamp). Attached globals and vaults compiled from dropped files/URLs never get the edge — they live alongside a repo without documenting it. Joins the wiki layer to the code tree at the root |

### Auxiliary

| Edge | From → To | Meaning |
|---|---|---|
| `MEMBER_OF_COMMUNITY` | any node → Community | Cluster membership |
| `PARTICIPATES_IN` | entity → Hyperedge | Group-relationship membership. **No longer produced** |

## Confidence rubric

All confidence values snap to the discrete rubric, never the soft 0.5 default:

| Tier | Score set | When |
|---|---|---|
| `EXTRACTED` | `{1.0}` | The source states the relationship itself — a reader could point at the line that asserts it |
| `INFERRED` | `{0.55, 0.65, 0.75, 0.85, 0.95}` | Concluded from context rather than from any explicit statement. Usually right, weighted below EXTRACTED. Legacy `concept` pages sit at 0.75 |
| `AMBIGUOUS` | `{0.1, 0.15, 0.2, 0.25, 0.3}` | A candidate the producer could neither confirm nor rule out — kept so review tooling can surface it rather than lose it |

`round_confidence(tier, score)` snaps an LLM-supplied score to the closest legal value.

## KnowledgeVault scope as a property

Every node in the page domain produced from a vault carries a `vault=<name>` property (entity-domain nodes in pre-2026-08-04 graphs carry it too). Two consequences:

- **Scoped retrieval is property equality.** Functions like `search(store, query, vault_scope="research")` filter by `node.properties.vault == "research"` — no graph traversal.
- **KnowledgeVault attach is per-vault.** Mirroring one vault into a graph touches only nodes with that vault tag. Different vaults can share a graph without interfering.

## ID conventions summary

| Pattern | Type |
|---|---|
| `<repo>/<rel-path>` | `File` |
| `<file>::<symbol>` | `Class` / `Function` |
| `<file>::<class>::<method>` | `Function` (method) |
| `pkg:<registry>:<name>` | `Dependency` |
| `<stem>_<entity-slug>` | Idea / Service / Module / Paper / Person / Event (legacy; no longer produced) |
| `vault::<name>` | `KnowledgeVault` |
| `<vault>::<kind_dir>/<base>` | `KnowledgeConcept` (e.g. `kb::concept/revenue`) |
| `corpus::<sha256>` | `KnowledgeDoc` |
| `_meta:index:<repo_id>` | `IndexMetadata` |

The `corpus::` ID is content-hashed — identical content via different ingestion paths lands on one node.
