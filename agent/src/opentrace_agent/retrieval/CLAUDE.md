# Retrieval

Agent-facing graph-retrieval primitives. Each module exposes one
read-only function that takes a `GraphStore` and returns a JSON-serialisable
dict. The MCP server, REST routes, and the UI chat tool all wrap these.

## Files

```
__init__.py    — Public API; re-exports the 8 functions
search.py      — Ranked FTS with snippets + vault/recency/confidence metadata
overview.py    — <500-token orientation: counts + top concepts + recently-updated
paths.py       — find_path (Python-composed BFS) + find_via_relationship_to_type
existence.py   — find_orphans (two-query set difference)
counts.py      — count_by (global or descendants-of-parent)
provenance.py  — Trust chain for code (commit_sha + line range) and wiki (CITES chain)
grep.py        — Regex match via ripgrep over a Repository or WikiVault scope
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
| Grep           | `grep.grep`                                    | ripgrep over Repository.local_path or WikiVault pages_dir |
| Query (typed)  | `paths.find_path`, `paths.find_via_relationship_to_type`, `existence.find_orphans`, `counts.count_by` | Replaces the spec's raw-Cypher escape hatch — convention-compliant typed templates |

## Search semantics

`search` runs FTS via `GraphStore._fts_search` then enriches each hit with:

- **`snippet`** — anchored on the first query token found in `name + summary`,
  windowed to ~200 chars
- **`vault`** — read from the node's `vault` property (set by Phase 4
  `graph_writer` on WikiVault/WikiPage/Source; null for code nodes)
- **`recency`** — `last_updated` property; null when not stamped
- **`confidence`** — `confidence` property; null when not stamped
  (currently a placeholder; real wiki-synthesis confidence is future work)

Falls back to `GraphStore.search_nodes` substring matching when FTS is
unavailable (e.g. before the index is built).

## Provenance semantics

Two branches keyed off node type:

- **Wiki** (`WikiVault` / `WikiPage` / `Source`) — returns the node's
  agent/model/session/confidence properties plus the `CITES` outgoing chain
  walked up to 3 hops. Concept page → source-summary page → Source.
- **Code** (`Repository` / `Directory` / `File` / `Class` / `Function` /
  `Variable`) — returns commit_sha + indexer_version from the per-repo
  `IndexMetadata` node (`_meta:index:{repoId}`), plus file_path + line_range
  from the node itself.

Repo id is inferred from the node id prefix (first two `/`-separated
segments) — works for both `owner/repo/...` GitHub-style IDs and
`local/<name>/...` directory imports.

## Grep semantics

Scope-based: caller provides a `Repository` (must have `local_path`) or
`WikiVault` (rooted at `OT_VAULT_ROOT/<name>/pages`). ripgrep is shelled out
with `--json --line-number --max-filesize=10M` and a 10s wall-time cap.
When on-disk content is unavailable, returns a structured `mode="error"`
response so the agent can fall back to `search_graph` for FTS over indexed
metadata.

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
