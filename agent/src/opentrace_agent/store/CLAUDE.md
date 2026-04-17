# Store

Graph persistence layer. Wraps LadybugDB (a Cypher-speaking embedded graph DB) and exposes a `GraphStore` interface used by the pipeline saving stage and by `serve.py` / `mcp_server.py`.

## Files

```
graph_store.py   — GraphStore class: Cypher query builder, node/edge CRUD, search
constants.py     — Schema: node types, relationship types, reserved property keys
_schema_gen.py   — Generates LadybugDB schema DDL from the constants above
__init__.py      — Re-exports
```

## Schema

The schema is **enumerated**, not free-form. Allowed node and relationship types live in `constants.py`. Adding a new type means:

1. Add it to the type enum in `constants.py`
2. Regenerate the LadybugDB schema (`_schema_gen.py` is the source for the DDL)
3. Update node-subclass `graph_type` ClassVars on the pipeline side
4. Update the corresponding TS types in `ui/src/store/types.ts` (UI is the second consumer)

## Property Marshalling

LadybugDB stores primitives natively. Dicts are JSON-serialized into a string column and unmarshalled on read. Nested structures (dict of lists of dicts) work but are brittle — the unmarshaller has thrown on edge cases historically. Keep stored properties shallow when you can.

## Cypher Conventions

Queries are parameterized (`$param`) — never string-format user input into Cypher. Node labels and relationship types **are** hardcoded in the query strings; this is intentional (it lets the query planner optimize) but it means schema changes are not transparent — every query touching the renamed type needs an update.

## Search

Full-text search runs across `name`, `summary`, and `path` properties. There's no semantic / vector search at this layer — that's handled in the UI's `src/store/search/` (BM25 + vector + RRF) for browser-mode indexing.

## Pitfalls

- **No transaction support.** Concurrent writers can corrupt the graph. Today the pipeline writes single-threaded; if you parallelize saving, add a write lock or batch externally.
- **MAP literal parsing is brittle.** When property unmarshalling fails the read returns the raw string — callers that assume `dict` will hit `AttributeError`. Add an explicit `isinstance` check at API boundaries.
- **Hardcoded labels = silent breakage.** Renaming a node type in `constants.py` without sweeping `graph_store.py` produces queries that return zero rows — no error, no warning. Grep all string occurrences when renaming.
- **Schema is not migrated.** There's no migration system; an existing `index.db` with an old schema will fail in subtle ways against newer code. Re-index from scratch when the schema changes.
