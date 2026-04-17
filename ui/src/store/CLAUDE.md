# Store

Data access layer — unified `GraphStore` interface with pluggable backends.

## Files

```
types.ts             — GraphStore interface, DTOs (NodeResult, TraverseResult, ImportBatchRequest, ...)
serverStore.ts       — REST client to `opentrace serve` (read-only; writes are no-ops)
ladybugStore.ts      — Browser-local LadybugDB (WASM, Parquet-backed; full read/write)
inMemoryStore.ts     — Legacy in-memory store (being replaced by ladybugStore)
createLadybugStore.ts — Factory for LadybugStore (WASM init, schema setup)
context.tsx          — React StoreContext provider
search/              — Search implementations: BM25, vector (transformers.js), RRF fusion
__tests__/           — Store integration tests
```

## GraphStore Contract

```typescript
interface GraphStore {
  hasData(): boolean;            // Sync, no DB call
  ensureReady?(): Promise<void>; // Lazy WASM init (LadybugStore only)
  fetchGraph(query?, hops?): Promise<GraphData>;
  fetchStats(): Promise<GraphStats>;
  fetchMetadata(): Promise<IndexMetadata[]>;
  importBatch(batch): Promise<ImportBatchResponse>;
  flush(): Promise<void>;        // No-op if unbuffered
  storeSource(files): void;
  fetchSource(nodeId, startLine?, endLine?): Promise<NodeSourceResponse | null>;
  searchNodes(query, limit?, nodeTypes?): Promise<NodeResult[]>;
  listNodes(type, limit?, offset?): Promise<NodeResult[]>;
  traverseNode(id, direction, maxDepth?, relTypes?): Promise<TraverseResult[]>;
  // ... optional: importVectors, importDatabase, exportDatabase, setEmbedder, setLimits
}
```

Optional methods (`?`) exist on LadybugStore only and are feature-detected at call sites. Add new methods as optional when server mode doesn't need them.

## REST Endpoints (ServerGraphStore)

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Readiness probe |
| `/api/stats` | GET | Node/relationship counts |
| `/api/graph` | GET | Fetch full graph (with optional `?query=` filter) |
| `/api/nodes/{id}` | GET | Single node details |
| `/api/traverse` | POST | Walk relationships (direction, depth, relTypes) |
| `/api/source/{id}` | GET | Source code for a file node |
| `/api/nodes/search` | GET | Full-text search |
| `/api/nodes/list` | GET | Paginated node listing by type |
| `/api/metadata` | GET | Index metadata (when indexed, by whom, counts) |

The server side of these lives in `agent/src/opentrace_agent/cli/serve.py`. Changes must be coordinated.

## Search Architecture

`search/` contains three strategies:

- **BM25** — classic term-frequency search over `name + summary + path`
- **Vector** — embedding-based similarity using HuggingFace transformers.js (in-browser inference)
- **RRF** — Reciprocal Rank Fusion to combine BM25 + vector scores

These only apply in browser (LadybugStore) mode. In server mode, search delegates to the REST endpoint (which runs full-text search server-side via the `graph_store.py` Cypher layer).

## Pitfalls

- **Server mode is read-only.** `importBatch`, `storeSource`, `clearGraph` are all no-ops in `ServerGraphStore`. Code calling these must not assume they had an effect.
- **LadybugStore requires WASM init.** Call `ensureReady()` before querying. The WASM init is async and can take >1s on first load.
- **Optional method detection.** Use `if (store.importVectors)` — TypeScript's optional interface members don't throw, but calling `undefined()` does.
- **Concurrent `flush()` calls conflict.** LadybugStore `flush()` issues bulk Parquet writes; overlapping flushes can produce duplicates. The pipeline serializes flushes; don't bypass that.
