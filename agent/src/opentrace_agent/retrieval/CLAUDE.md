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
clusters.py    — list_clusters, god_nodes, cross_cluster_bridges
cross_domain.py — cross_domain_bridges, find_clusters_spanning_domains
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
  everything the wiki layer writes. Resolver-stamped `CALLS` edges are its only
  user.
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

The root cause of the inversion is worth knowing — BM25 normalises by length, so
the `File`'s short `search_text` outscores the `KnowledgeDoc`'s *identical tokens
plus a gloss*. **Enriching a node demotes it.** A field-weighted ranking would fix
the class of problem; this collapse fixes the worst instance.

**Doc-hit triage fields.** `KnowledgeDoc` hits carry `title` / `status` /
`one_line_summary` (≤120 chars, matching `list_nodes`'s compact projection) /
`path` inline, so an agent picks which docs to open from the results alone
instead of paying a `load_source` round-trip per hit. Other node types stay
lean.

`search` applies no node-type filtering of its own — every indexed node is
eligible for a hit and is returned like any other.

Falls back to `GraphStore.search_nodes` substring matching when FTS is
unavailable (e.g. before the index is built).

## Provenance semantics

Two branches keyed off node type; anything else returns `kind="unknown"`:

- **Wiki** (`KnowledgeVault` / `KnowledgeDoc`) — returns the document's own
  identity: sha256, filename, root-relative path, ingest time, plus the
  `MIRRORS` File twin id when the doc came from a repo walk. A `KnowledgeVault`
  gets an empty chain. A document *is* its own provenance — nothing restates it,
  so the chain is one entry.
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
document. It is also how "what does the corpus say about X" is answered —
verbatim lines from every doc, pre-labelled. Three details are load-bearing:

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
- **Ripgrep is an accelerator, not a dependency.** `grep` prefers `rg` and
  falls back to an equivalent Python scan when `shutil.which("rg")` comes up
  empty; the response's `mode` says which ran. **Don't make `rg` a hard
  requirement** — the failure mode is invisible: on a machine where `rg`
  exists only as a shell function, every vault sweep returns "ripgrep not on
  PATH" and the exhaustiveness primitive silently never runs. For the same
  reason, don't let `test_grep.py` skip when `rg` is absent, and don't have
  it hunt for a vendored binary and prepend that to PATH — both validate a
  path production cannot take.
