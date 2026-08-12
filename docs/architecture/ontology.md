# Ontology

Full node + edge type reference for the OpenTrace knowledge graph. For the high-level layered view, see [Architecture Overview](overview.md).

## Domains

The graph organises into two domains:

| Domain | What lives there | Produced by |
|---|---|---|
| **code** | `Repository`, `Directory`, `File`, `Class`, `Function`, `Variable`, `Dependency` | `opentraceai index` (tree-sitter) |
| **doc** | `KnowledgeVault`, `KnowledgeDoc` | `opentraceai index --wiki` / `vault ingest` (doc ingestion) |

Doc ingestion is corpus-only: it indexes the documents (labels, epistemic status, doc↔doc links, `File` twins) and keeps their bodies verbatim. A `KnowledgeDoc` carries a title, a one-line summary, and an epistemic `status`; its normalized body sits verbatim in the corpus, readable with `load_source`, enumerable with `list_nodes`, and sweepable with `grep`.

The one auxiliary type, `IndexMetadata`, sits outside the domains and comes from index bookkeeping. Clustering adds no type: it writes a `cluster` property onto the nodes it partitions.

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

### Doc domain

#### `KnowledgeVault`

A named collection of ingested documents (one vault node per disk vault dir).

- `id` — `vault::<name>`
- `name` — display name
- `last_compiled_at` — ISO-8601 timestamp from `.vault.json`
- `scope` — `"local"` or `"global"`
- `mirror_compiled_at` — when this graph's mirror was last written. `vault list` compares against `last_compiled_at` to flag stale mirrors
- `summary`, `vault`

The repo a vault was built from is recorded by the `DOCUMENTS` edge, and on disk
in `.vault.json`'s `spawned_from` — not as a property of this node.

#### `KnowledgeDoc`

A raw ingested artifact — every doc ingested by `index --wiki` (wiki uploads included) uses this shape.

- `id` — `corpus::<sha256-of-raw-bytes>`
- `name` — original filename or title
- `title` — navigation label derived from the filename (set by the per-doc DocExtraction call)
- `one_line_summary` — LLM-written one-liner; `summary` carries a copy so the label feeds FTS via `search_text`
- `sha256`, `filename`, `content_type` (MIME), `acquired_at`
- `corpus_path` — relative path to the body file in `.opentrace/corpus/` (readable via the `load_source` tool)
- `path` — repo-relative path, stamped (alongside the `MIRRORS` edge) when the doc came from a repo walk
- `status` — epistemic label from the doc's location: `authoritative` (current documentation), `design_history` (openspec / ADR / RFC / proposal trees, CHANGELOGs), or `design_history_archived` (design history under an archive folder, likely superseded)
- `source_uri` — original URL when ingested from web; file path when from disk
- `vault` — owning vault name (set when produced via `--wiki`)

### Auxiliary

#### `IndexMetadata`

Per-repo provenance for the most recent `index` run.

- `id` — `_meta:index:<repo_id>`
- `indexed_at`, `duration_seconds`, `repo_id`, `repo_path`, `commit_sha`, `commit_message`, `branch`, `opentraceai_version`, counts

Excluded from default cluster + analysis walks (it's bookkeeping, not data).

## Edge reference

### Structural

| Edge | From → To | Meaning |
|---|---|---|
| `CONTAINS` | parent → child | Hierarchy. `Repository → Directory`, `Directory → File`, `KnowledgeVault → KnowledgeDoc` |
| `DEFINES` | container → symbol | `File → Class/Function`, `Class → Function`, `Class → Variable` |
| `CALLS` | `Function → Function` | Resolved call via 7-strategy resolver |
| `IMPORTS` | `File → Dependency` | Resolved import |
| `DEPENDS_ON` | `Repository → Dependency` | Manifest dependency |
| `DERIVED_FROM` | `Variable → Variable/Function` | Value derivation, resolved by the code pipeline |

### Doc links

| Edge | From → To | Meaning |
|---|---|---|
| `LINKS_TO` | KnowledgeDoc → KnowledgeDoc | A relative link the doc's **author** wrote to another doc — the doc-side analogue of the code graph's `IMPORTS`. Parsed mechanically (no LLM) from markdown inline links, reference-style definitions, and HTML anchors by `graph_writer.parse_doc_links`, then resolved against the linking doc's own directory; repo-root-relative targets (`/docs/x.md`) are supported. External URLs, bare `#fragment` targets, paths escaping the repo root, and targets that aren't another indexed doc produce no edge. Written on repo-walked `--wiki` runs that mirror to the graph — like `MIRRORS` it needs repo-relative paths, so single-file / URL compiles and disk-only global vaults get no doc↔doc edges |

`LINKS_TO` is doc→doc only, and it records links the author wrote — there is no wiki-link syntax to author against.

### Cross-layer

| Edge | From → To | Meaning |
|---|---|---|
| `MIRRORS` | KnowledgeDoc → File | The ingested doc's twin in the code tree. Emitted during `index --wiki` on a directory for every repo-walked doc; the KnowledgeDoc gets a repo-relative `path` property stamped. When the code walk didn't create the File node (extensions like `.rst`/`.txt`/`.html`/PDFs), it is created at link time so the twin always exists. Docs not from a repo walk (uploads, URLs, attached global vaults) have no edge. Bridges the corpus layer and the code tree — either twin reaches the other in one hop, and provenance chains include the mirrored File id |
| `DOCUMENTS` | Repository → KnowledgeVault | The vault spawned from this repo. Written only by `index --wiki` runs where the wiki compile executes alongside a repo walk (the vault also gets a `spawned_from` stamp). Attached globals and vaults compiled from dropped files/URLs never get the edge — they live alongside a repo without documenting it. Joins the wiki layer to the code tree at the root |

## Clusters are a property, not a type

`opentraceai cluster` stamps a `cluster` integer onto every node it
partitions. There is no cluster node and no membership edge, so clustering
leaves the node and edge counts untouched and nothing downstream has to exclude
its output from a census, a degree count, or a traversal.

The per-cluster summary — label, member count, cohesion, god flag — is
recomputed from the partition by `retrieval.clusters` rather than stored, so
there is no second copy to drift from the members it describes.

(The UI viewer has an unrelated, ephemeral feature also called "communities" —
its own on-screen Louvain grouping for colour and layout. It never touches the
graph. See `ui/CLAUDE.md`.)

## Confidence on `CALLS`

`CALLS.confidence` is a plain float from the call resolver — 1.0 for an exact
in-scope match, lower for cross-file and heuristic matches. It is the only
confidence value any producer writes, and it lives on the relationship, never
on a node.

## KnowledgeVault scope as a property

The `KnowledgeVault` node carries a `vault=<name>` property. Two consequences:

- **Scoped retrieval is property equality.** Functions like `search(store, query, vault_scope="research")` filter by `node.properties.vault == "research"` — no graph traversal.
- **KnowledgeVault attach is per-vault.** Mirroring one vault into a graph touches only nodes with that vault tag. Different vaults can share a graph without interfering.

**`KnowledgeDoc` deliberately carries no `vault` property.** A document is content-addressed by sha256, so the same file ingested into two vaults is *one* node; a `vault` property would make the second mirror overwrite the first one's tag. Doc membership is the `KnowledgeVault -CONTAINS-> KnowledgeDoc` edge, and vault-scoped code traverses it rather than filtering a property — see `retrieval/overview.py`'s `_scoped_overview` and `grep.py`'s corpus membership resolution.

## ID conventions summary

| Pattern | Type |
|---|---|
| `<repo>/<rel-path>` | `File` |
| `<file>::<symbol>` | `Class` / `Function` |
| `<file>::<class>::<method>` | `Function` (method) |
| `pkg:<registry>:<name>` | `Dependency` |
| `vault::<name>` | `KnowledgeVault` |
| `corpus::<sha256>` | `KnowledgeDoc` |
| `_meta:index:<repo_id>` | `IndexMetadata` |

The `corpus::` ID is content-hashed — identical content via different ingestion paths lands on one node.
