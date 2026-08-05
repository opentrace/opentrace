# Retrieval

Agent-facing graph-retrieval primitives. Each module exposes one
read-only function that takes a `GraphStore` and returns a JSON-serialisable
dict. The MCP server, REST routes, and the UI chat tool all wrap these.

## Files

```
__init__.py    — Public API; re-exports the read-only primitives
search.py      — Ranked FTS with snippets + vault/recency/confidence metadata
overview.py    — <500-token orientation: counts + top concepts + recently-updated
paths.py       — find_path (Python-composed BFS) + find_via_relationship_to_type
existence.py   — find_orphans (two-query set difference)
counts.py      — count_by (global or descendants-of-parent)
provenance.py  — Trust chain for code (commit_sha + line range) and wiki (the doc's own identity)
grep.py        — Regex match via ripgrep over a Repository or Vault scope
```

## Convention

All functions follow the [store CLAUDE.md](../store/CLAUDE.md) parameterisation rule:

- Values are bound via `$param` or used in `LIMIT N` after integer casting.
- Node types and relationship types are inlined as Cypher literals against the
  generic `Node`/`RELATES` tables. There is no LLM-supplied label substitution
  anywhere in this module.
- Read-only by construction. No function in this module writes to the store.

## Tool surface

| Tool           | This module                                    | Notes |
|----------------|------------------------------------------------|-------|
| Search         | `search.search`                                | FTS-only on the CLI; vector + RRF deferred |
| Overview       | `overview.overview`                            | <500 tokens, vault-scoped variant |
| Node-fetch     | (in `cli/mcp_server.py::get_node`)             | Wraps `GraphStore.get_node` + `traverse(depth=1)`; adds `target_summary` per neighbour |
| Traversal      | (in `GraphStore.traverse`)                     | Edge-type set, vault scope, confidence threshold |
| Provenance     | `provenance.provenance`                        | Code + wiki branches; null payload for unknown types |
| Grep           | `grep.grep`                                    | ripgrep over Repository.local_path, or a Vault's corpus bodies |
| Query (typed)  | `paths.find_path`, `paths.find_via_relationship_to_type`, `existence.find_orphans`, `counts.count_by` | Replaces the spec's raw-Cypher escape hatch — convention-compliant typed templates |

## Search semantics

`search` runs FTS via `GraphStore._fts_search` then enriches each hit with:

- **`snippet`** — anchored on the first query token found in `name + summary`,
  windowed to ~200 chars
- **`vault`** — read from the node's `vault` property (set by Phase 4
  `graph_writer` on the `KnowledgeVault`; null for code nodes and KnowledgeDocs)
- **`recency`** — `last_updated` property; null when not stamped
- **`confidence`** — `confidence` property; null when not stamped, which is
  everything the wiki layer writes. Nothing on the doc side has ever carried a
  meaningful value here (the one wiki-side stamp went with the concept-page
  layer on 2026-08-04); resolver-stamped `CALLS` edges are its only live user.
- **`fileTwin`** — on a `KnowledgeDoc` hit, the id of the `File` node it
  `MIRRORS` (absent when there is none), so the code-tree view stays one hop away

**Doc/File twin collapse.** An indexed document is two nodes — the `File` the
code walk saw and the `KnowledgeDoc` the doc pass created — and both are
FTS-indexed, so one document could take two result slots. `_collapse_doc_file_twins`
merges each pair into a single `KnowledgeDoc` hit (it carries title, summary,
and `status`), promoted to whichever of the two ranked better and annotated with
`fileTwin`. It runs **before** the `limit` cut so the freed slot is actually
reused — collapsing afterwards would free nothing. Pairing follows the MIRRORS
edge, never a path-string match, so same-named docs in different repos don't merge.

Measured on a 25-doc index: duplicates in the top 5 went from 8/12 queries to
0/12, and `KnowledgeDoc` reached the top 3 on 10/12. The root cause of the
inversion is worth knowing — BM25 normalises by length, so the `File`'s short
`search_text` outscores the `KnowledgeDoc`'s *identical tokens plus a gloss*
(it beat its own twin in 15 of 22 pairs). **Enriching a node demotes it** — the
same inversion that let short-named extracted entity nodes outrank the glossed
docs they came from, one of the reasons that layer was removed. A field-weighted
ranking would fix the class of problem; this collapse fixes the worst instance.

**Doc-hit triage fields.** `KnowledgeDoc` hits carry `title` / `status` /
`one_line_summary` (≤120 chars, matching `list_nodes`'s compact projection) /
`path` inline, so an agent picks which docs to open from the results alone
instead of paying a `load_source` round-trip per hit. Other node types stay
lean.

**No entity exclusion any more.** `search` used to take an
`exclude_llm_entities` flag (MCP-default-on) because doc-extracted entities —
the second instance of the BM25 problem above — took ~half the top-3 slots on
the same 25-doc index, crowding out the labelled docs they came from. The layer
that produced them was **removed 2026-08-04** (see the wiki CLAUDE.md), so the
flag, its `_is_llm_entity` discriminator, and the `entities_excluded` counter
are gone with it. Nodes of those types in a pre-existing graph are returned like
any other node — there is nothing left to filter, and hiding a legacy graph's
contents would be worse than ranking it.

Falls back to `GraphStore.search_nodes` substring matching when FTS is
unavailable (e.g. before the index is built).

## Provenance semantics

Two branches keyed off node type (a third, `derived`, walked `DERIVED_FROM`
from an LLM-extracted entity to its source document — removed 2026-08-04 with
the entity layer; those node types now return `kind="unknown"`):

- **Wiki** (`KnowledgeVault` / `KnowledgeDoc`) — returns the document's own
  identity: sha256, filename, root-relative path, ingest time, plus the
  `MIRRORS` File twin id when the doc came from a repo walk. A `KnowledgeVault`
  gets an empty chain. This branch used to walk a `CITES` chain from a
  synthesized concept page back to the docs it restated; that went with the
  concept-page layer on **2026-08-04**, and with it the agent/model/session/
  confidence compile stamp (page-level, never doc-level). A document *is* its
  own provenance — nothing restates it, so there is no chain left to walk.
- **Code** (`Repository` / `Directory` / `File` / `Class` / `Function` /
  `Variable`) — returns commit_sha + indexer_version from the per-repo
  `IndexMetadata` node (`_meta:index:{repoId}`), plus file_path + line_range
  from the node itself.

Repo id is inferred from the node id prefix (first two `/`-separated
segments) — works for both `owner/repo/...` GitHub-style IDs and
`local/<name>/...` directory imports.

## Grep semantics

Scope-based: caller provides a `Repository` (must have `local_path`) or a
`KnowledgeVault`. ripgrep is shelled out with `--json --line-number
--max-filesize=10M` and a 10s wall-time cap. When on-disk content is
unavailable, returns a structured `mode="error"` response so the agent can
fall back to `search_graph` for FTS over indexed metadata.

**A vault grep sweeps the CORPUS, and only the corpus** — every member
KnowledgeDoc's normalized markdown body. This is the exhaustiveness primitive:
ranked search finds the best documents, grep establishes what's true of every
document (the folder arm won benchmark coverage questions with exactly this
capability; see the wiki CLAUDE.md's measured-value section). It is also what
replaced synthesis for "what does the corpus say about X" — verbatim lines from
every doc, pre-labelled, instead of a paraphrase layer. Three details are
load-bearing:

- **Membership via `CONTAINS`, not the directory.** The corpus dir is shared
  and sha-keyed across vaults; grepping it raw would leak other vaults' docs.
- **Resolution via each doc's `corpus_path`** (relative to the DB dir) —
  never by parsing corpus filenames. Docs whose body isn't on this machine
  (metadata-only mirrors) are skipped, not fatal.
- **Hits are joined back to the KnowledgeDoc**: `node_id` (`corpus::<sha>`),
  display `file_path` (the doc's folder/repo-relative path, never the sha
  name), `title`, `status`, with line numbers referring to the normalized
  body — exactly what `load_source` returns. `file_filter` matches the
  display path. A corpus sweep therefore returns *pre-labelled* matches,
  which is what makes it better than grepping the raw export (where PDFs and
  HTML grep badly and hits carry no labels).

The sweep used to have a second half, over the vault's `pages/` dir of
synthesized concept pages. That went with the concept-page layer — synthesis
dropped **2026-08-03**, everything else **2026-08-04** — because the pages
variant measured **88.4% against a 98.6% control (−10.2pp)**, the worst result
on record: a synthesized page restates its sources in the model's own voice and
strips their hedges, tense, and attribution, a failure mode a verbatim body
structurally cannot have. Full record in
[wiki CLAUDE.md](../wiki/CLAUDE.md) ("Closed"). **Don't re-add it** — the corpus
sweep plus `load_source` is the replacement.

No FTS-over-bodies fallback inside the graph: graph DBs are not blob stores
(LadybugDB caps STRING properties at ~4 KB), and bodies live in their natural
disk-blob layer. A production-grade blob backing store is future work.

## Pitfalls

- **MAP-literal unmarshalling.** The store sometimes returns property dicts
  as raw strings on read. Use `_parse_props` from `graph_store.py` consistently.
- **`store._conn.execute` is a private API.** It works because we own the
  GraphStore class, but new retrieval functions should prefer public methods
  (`get_node`, `list_nodes`, `traverse`, `search_nodes`) when they suffice.
- **Cypher dialect quirks.** `shortestPath()` and `WHERE NOT pattern` are
  unconfirmed in LadybugDB — `find_path` uses Python BFS, `find_orphans` uses
  two-query set difference. Don't reach for those Cypher forms without
  testing.
- **Ripgrep dependency.** `grep` requires `rg` on PATH. Document in install
  docs; gracefully error otherwise (don't crash the MCP process).
