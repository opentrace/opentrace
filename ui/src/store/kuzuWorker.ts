/**
 * Web Worker that runs an in-memory KuzuDB instance via kuzu-wasm.
 *
 * Receives KuzuRequest messages, executes Cypher queries, and posts
 * KuzuResponse messages back to the main thread.
 */

import kuzu_wasm, { type Connection, type KuzuModule } from '@kuzu/kuzu-wasm';
import type {
  KuzuRequest,
  KuzuResponse,
  NodeResult,
  TraverseResult,
} from './kuzuProtocol';
import type {
  GraphData,
  GraphNode,
  GraphLink,
  GraphStats,
} from '../types/graph';
import type { ImportBatchResponse } from './types';
import { BM25Index } from './search/bm25';
import { VectorIndex } from './search/vector';
import { rrfFuse } from './search/rrf';

// ---- Module-level state ----

let conn: Connection | null = null;
let kuzu: KuzuModule | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null;

/**
 * Track execute() calls so we can recycle the connection before the
 * kuzu-wasm WASM heap is exhausted (~5000-6000 calls).
 */
let executeCount = 0;
const RECYCLE_THRESHOLD = 800;

/**
 * JS-side property cache for nodes.  Avoids querying the DB to merge
 * properties on update batches (summary-only etc.).  kuzu-wasm's WASM heap
 * exhausts after ~5000 conn.execute() calls, so we must minimise queries.
 */
const nodePropsCache = new Map<string, Record<string, unknown>>();

/** In-memory BM25 index for text search (kuzu-wasm lacks FTS extension). */
let bm25Index = new BM25Index();

/** In-memory vector index for embedding search (kuzu-wasm lacks vector extension). */
let vectorIndex: VectorIndex | null = null;

// ---- Helpers ----

/** Escape a string for use inside a Cypher single-quoted literal. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * URI-encode a properties object for safe storage in KuzuDB.
 *
 * kuzu-wasm's table.toString() doesn't properly escape double quotes
 * inside STRING values when producing its JSON output.  By URI-encoding
 * the JSON, we avoid embedded quotes (they become %22) so the
 * toString() → JSON.parse() round-trip stays intact.
 */
function encodeProps(props: Record<string, unknown>): string {
  return encodeURIComponent(JSON.stringify(props));
}

/**
 * Wrapper around conn.execute() that recycles the connection periodically
 * to prevent kuzu-wasm WASM heap exhaustion.  The Database object holds
 * the data; the Connection is just a session handle that can be recreated.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function execute(cypher: string): Promise<any> {
  if (!conn) throw new Error('KuzuDB not initialized');
  if (executeCount >= RECYCLE_THRESHOLD && kuzu && db) {
    console.log(
      `[KuzuWorker] recycling connection after ${executeCount} executions`,
    );
    conn = await kuzu.Connection(db);
    executeCount = 0;
  }
  executeCount++;
  return conn.execute(cypher);
}

async function query(cypher: string): Promise<unknown[]> {
  const t0 = performance.now();
  const res = await execute(cypher);
  const elapsed = performance.now() - t0;
  if (!res?.table) {
    const keys = res ? Object.keys(res) : 'null/undefined';
    console.warn(
      `[KuzuWorker] query returned no table (keys: ${JSON.stringify(keys)}, ${elapsed.toFixed(0)}ms): ${cypher.slice(0, 120)}`,
    );
    return [];
  }
  const raw = res.table.toString();
  if (!raw || raw === '[]') return [];
  return JSON.parse(raw) as unknown[];
}

// ---- Limits for graph visualization (force-directed layout chokes on large graphs) ----

let MAX_VIS_NODES = 2000;
let MAX_VIS_EDGES = 5000;

// ---- Schema ----

const SCHEMA_STATEMENTS = [
  `CREATE NODE TABLE IF NOT EXISTS Node(id STRING PRIMARY KEY, type STRING, name STRING, properties STRING)`,
  `CREATE REL TABLE IF NOT EXISTS RELATES(FROM Node TO Node, id STRING, type STRING, properties STRING)`,
];

async function createSchema() {
  for (const stmt of SCHEMA_STATEMENTS) {
    await execute(stmt);
  }
}

// ---- Operations ----

async function handleInit(id: number): Promise<KuzuResponse> {
  kuzu = await kuzu_wasm();
  db = await kuzu.Database();
  conn = await kuzu.Connection(db);
  executeCount = 0;
  await createSchema();
  return { kind: 'ready', id };
}

/**
 * Maximum items per UNWIND batch.  Each UNWIND is a single conn.execute()
 * call, so this controls the trade-off between Cypher string size and
 * total number of execute() calls (which exhaust the kuzu-wasm WASM heap).
 */
const IMPORT_BATCH_SIZE = 100;

async function handleImportBatch(
  id: number,
  batch: KuzuRequest & { kind: 'importBatch' },
): Promise<KuzuResponse> {
  let nodesCreated = 0;
  let relsCreated = 0;

  // ---- Phase 1: update JS-side caches and build Cypher map entries ----
  const nodeEntries: string[] = [];
  for (const node of batch.batch.nodes) {
    // Merge properties with cache so partial updates (e.g. summary-only)
    // don't overwrite previously-set fields.
    const cached = nodePropsCache.get(node.id);
    const mergedProps = cached
      ? { ...cached, ...(node.properties ?? {}) }
      : (node.properties ?? {});
    nodePropsCache.set(node.id, mergedProps);

    const props = esc(encodeProps(mergedProps));
    nodeEntries.push(
      `{id: '${esc(node.id)}', type: '${esc(node.type)}', name: '${esc(node.name)}', props: '${props}'}`,
    );

    // BM25 index (JS-only, no DB call)
    const searchParts = [node.name, node.type];
    if (node.properties) {
      if (typeof node.properties.summary === 'string')
        searchParts.push(node.properties.summary);
      if (typeof node.properties.path === 'string')
        searchParts.push(node.properties.path);
    }
    bm25Index.addDocument(node.id, searchParts.join(' '));

    // Vector index (JS-only)
    if (node.embedding && node.embedding.length > 0) {
      if (!vectorIndex) vectorIndex = new VectorIndex(node.embedding.length);
      vectorIndex.addVector(node.id, node.embedding);
    }
  }

  // ---- Phase 2: batch-write nodes via UNWIND ----
  for (let i = 0; i < nodeEntries.length; i += IMPORT_BATCH_SIZE) {
    const chunk = nodeEntries.slice(i, i + IMPORT_BATCH_SIZE);
    try {
      await execute(
        `UNWIND [${chunk.join(', ')}] AS row ` +
          `MERGE (n:Node {id: row.id}) SET n.type = row.type, n.name = row.name, n.properties = row.props`,
      );
      nodesCreated += chunk.length;
    } catch (err) {
      console.error(
        `[KuzuWorker] UNWIND node batch failed (offset ${i}, size ${chunk.length}):`,
        err,
      );
      throw err;
    }
  }

  // ---- Phase 3: batch-write relationships via UNWIND ----
  const relEntries: string[] = [];
  for (const rel of batch.batch.relationships) {
    const props = rel.properties ? esc(encodeProps(rel.properties)) : '{}';
    relEntries.push(
      `{id: '${esc(rel.id)}', type: '${esc(rel.type)}', src: '${esc(rel.source_id)}', tgt: '${esc(rel.target_id)}', props: '${props}'}`,
    );
  }

  for (let i = 0; i < relEntries.length; i += IMPORT_BATCH_SIZE) {
    const chunk = relEntries.slice(i, i + IMPORT_BATCH_SIZE);
    try {
      await execute(
        `UNWIND [${chunk.join(', ')}] AS row ` +
          `MATCH (a:Node {id: row.src}), (b:Node {id: row.tgt}) ` +
          `MERGE (a)-[r:RELATES {id: row.id}]->(b) SET r.type = row.type, r.properties = row.props`,
      );
      relsCreated += chunk.length;
    } catch (err) {
      console.error(
        `[KuzuWorker] UNWIND rel batch failed (offset ${i}, size ${chunk.length}):`,
        err,
      );
      throw err;
    }
  }

  // Use cache size for verification — avoids spending an execute() call
  console.log(
    `[KuzuWorker] importBatch done: wrote ${nodesCreated} nodes, ${relsCreated} rels — cache has ${nodePropsCache.size} nodes (${executeCount} execs)`,
  );

  const data: ImportBatchResponse = {
    nodes_created: nodesCreated,
    relationships_created: relsCreated,
  };
  return { kind: 'importBatch', id, data };
}

async function handleFetchGraph(
  id: number,
  queryStr?: string,
  hops?: number,
  queryEmbedding?: number[],
): Promise<KuzuResponse> {
  let data: GraphData;

  const t0 = performance.now();
  if (queryStr) {
    data = await searchGraph(queryStr, hops ?? 2, queryEmbedding);
  } else {
    data = await getAllGraph();
  }
  console.log(
    `[KuzuWorker] fetchGraph: ${data.nodes.length} nodes, ${data.links.length} edges in ${(performance.now() - t0).toFixed(0)}ms`,
  );

  return { kind: 'fetchGraph', id, data };
}

async function getAllGraph(): Promise<GraphData> {
  console.log('[KuzuWorker] getAllGraph: starting count queries...');
  // Count totals first to detect truncation
  const countRows = await query(`MATCH (n:Node) RETURN count(n) AS cnt`);
  const totalNodes = Number(
    (countRows as Record<string, number>[])[0]?.cnt ?? 0,
  );
  const edgeCountRows = await query(
    `MATCH ()-[r:RELATES]->() RETURN count(r) AS cnt`,
  );
  const totalEdges = Number(
    (edgeCountRows as Record<string, number>[])[0]?.cnt ?? 0,
  );
  console.log(
    `[KuzuWorker] getAllGraph: ${totalNodes} total nodes, ${totalEdges} total edges`,
  );

  if (totalNodes > MAX_VIS_NODES || totalEdges > MAX_VIS_EDGES) {
    console.warn(
      `[KuzuWorker] Graph too large for full visualization: ${totalNodes} nodes, ${totalEdges} edges. ` +
        `Limiting to ${MAX_VIS_NODES} nodes / ${MAX_VIS_EDGES} edges. Use search to explore.`,
    );
  }

  const nodeRows = await query(
    `MATCH (n:Node) RETURN n.id AS id, n.type AS type, n.name AS name, n.properties AS properties LIMIT ${MAX_VIS_NODES}`,
  );
  const nodes: GraphNode[] = (nodeRows as Record<string, string>[]).map(
    (r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      properties: parseProps(r.properties),
    }),
  );

  // Only fetch edges between the returned nodes
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const relRows = await query(
    `MATCH (a:Node)-[r:RELATES]->(b:Node) RETURN a.id AS source, b.id AS target, r.type AS type, r.properties AS properties LIMIT ${MAX_VIS_EDGES}`,
  );
  const links: GraphLink[] = (relRows as Record<string, string>[])
    .filter((r) => nodeIdSet.has(r.source) && nodeIdSet.has(r.target))
    .map((r) => ({
      source: r.source,
      target: r.target,
      label: r.type,
      properties: parseProps(r.properties),
    }));

  return { nodes, links };
}

async function searchGraph(
  search: string,
  hops: number,
  queryEmbedding?: number[],
): Promise<GraphData> {
  let seedIds: Set<string>;

  // Fast path: if the search string matches an exact node ID, use it directly.
  // This lets callers like the PR indexer reload by ID without relying on text search.
  if (nodePropsCache.has(search)) {
    seedIds = new Set([search]);
  } else {
    // --- Hybrid search: BM25 + optional vector, fused with RRF ---
    const rankedLists: { id: string; score: number }[][] = [];

    // BM25 text search
    const bm25Results = bm25Index.search(search, 50);
    if (bm25Results.length > 0) {
      rankedLists.push(bm25Results);
    }

    // Vector search (if embedding provided and vector index populated)
    if (queryEmbedding && vectorIndex && vectorIndex.size > 0) {
      const vecResults = vectorIndex.search(queryEmbedding, 50);
      if (vecResults.length > 0) {
        rankedLists.push(vecResults);
      }
    }

    if (rankedLists.length > 0) {
      // Fuse results via RRF
      const fused = rrfFuse(rankedLists, 50);
      seedIds = new Set(fused.map((r) => r.id));
    } else {
      // Fallback to old substring search if no BM25/vector results
      const q = esc(search.toLowerCase());
      const seedRows = await query(
        `MATCH (n:Node) WHERE lower(n.name) CONTAINS '${q}' RETURN n.id AS id`,
      );
      seedIds = new Set(
        (seedRows as Record<string, string>[]).map((r) => r.id),
      );
    }
  }

  if (seedIds.size === 0) {
    return { nodes: [], links: [] };
  }

  // BFS: expand hops (capped to prevent explosion on hub nodes)
  const visitedNodes = new Set(seedIds);
  let frontier = new Set(seedIds);

  for (let d = 0; d < hops && frontier.size > 0; d++) {
    const nextFrontier = new Set<string>();

    for (const nodeId of frontier) {
      if (visitedNodes.size >= MAX_VIS_NODES) break;
      const neighbors = await query(
        `MATCH (a:Node {id: '${esc(nodeId)}'})-[r:RELATES]-(b:Node) RETURN b.id AS id`,
      );
      for (const row of neighbors as Record<string, string>[]) {
        if (!visitedNodes.has(row.id)) {
          visitedNodes.add(row.id);
          nextFrontier.add(row.id);
          if (visitedNodes.size >= MAX_VIS_NODES) break;
        }
      }
    }

    frontier = nextFrontier;
    if (visitedNodes.size >= MAX_VIS_NODES) {
      console.warn(
        `[KuzuWorker] searchGraph: BFS capped at ${MAX_VIS_NODES} nodes (hop ${d + 1}/${hops})`,
      );
      break;
    }
  }

  // Fetch full node data for visited nodes
  const nodeList = [...visitedNodes].map((id) => `'${esc(id)}'`).join(', ');
  const nodeRows = await query(
    `MATCH (n:Node) WHERE n.id IN [${nodeList}] RETURN n.id AS id, n.type AS type, n.name AS name, n.properties AS properties`,
  );
  const nodes: GraphNode[] = (nodeRows as Record<string, string>[]).map(
    (r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      properties: parseProps(r.properties),
    }),
  );

  // Fetch relationships between visited nodes
  const relRows = await query(
    `MATCH (a:Node)-[r:RELATES]->(b:Node) WHERE a.id IN [${nodeList}] AND b.id IN [${nodeList}] ` +
      `RETURN a.id AS source, b.id AS target, r.type AS type, r.properties AS properties`,
  );
  const links: GraphLink[] = (relRows as Record<string, string>[]).map((r) => ({
    source: r.source,
    target: r.target,
    label: r.type,
    properties: parseProps(r.properties),
  }));

  return { nodes, links };
}

async function handleFetchStats(id: number): Promise<KuzuResponse> {
  const typeRows = await query(
    `MATCH (n:Node) RETURN n.type AS type, count(n) AS cnt`,
  );
  const nodes_by_type: Record<string, number> = {};
  let total_nodes = 0;
  for (const row of typeRows as Record<string, string | number>[]) {
    const count = Number(row.cnt);
    nodes_by_type[String(row.type)] = count;
    total_nodes += count;
  }

  const edgeRows = await query(
    `MATCH ()-[r:RELATES]->() RETURN count(r) AS cnt`,
  );
  const total_edges = Number(
    (edgeRows as Record<string, number>[])[0]?.cnt ?? 0,
  );

  const data: GraphStats = { total_nodes, total_edges, nodes_by_type };
  return { kind: 'fetchStats', id, data };
}

async function handleClearGraph(id: number): Promise<KuzuResponse> {
  // Drop and recreate tables
  await execute(`DROP TABLE IF EXISTS RELATES`);
  await execute(`DROP TABLE IF EXISTS Node`);
  await createSchema();

  // Reset indexes and caches
  vectorIndex = null;
  bm25Index = new BM25Index();
  nodePropsCache.clear();

  return { kind: 'clearGraph', id };
}

function parseProps(
  raw: string | null | undefined,
): Record<string, unknown> | undefined {
  if (!raw || raw === '{}' || raw === 'null') return undefined;
  try {
    // New format: URI-encoded JSON (contains %XX sequences, never starts with {)
    // Legacy format: raw JSON string (starts with {)
    const json = raw.includes('%') ? decodeURIComponent(raw) : raw;
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ---- Chat tool handlers ----

async function handleSearchNodes(
  id: number,
  search: string,
  limit: number,
  nodeTypes?: string[],
  queryEmbedding?: number[],
): Promise<KuzuResponse> {
  // Hybrid search: BM25 + optional vector, fused with RRF (same as searchGraph but no hop expansion)
  const rankedLists: { id: string; score: number }[][] = [];

  const bm25Results = bm25Index.search(search, limit * 2);
  if (bm25Results.length > 0) rankedLists.push(bm25Results);

  if (queryEmbedding && vectorIndex && vectorIndex.size > 0) {
    const vecResults = vectorIndex.search(queryEmbedding, limit * 2);
    if (vecResults.length > 0) rankedLists.push(vecResults);
  }

  let seedIds: string[];

  if (rankedLists.length > 0) {
    const fused = rrfFuse(rankedLists, limit * 2);
    seedIds = fused.map((r) => r.id);
  } else {
    // Fallback to substring match
    const q = esc(search.toLowerCase());
    const rows = await query(
      `MATCH (n:Node) WHERE lower(n.name) CONTAINS '${q}' RETURN n.id AS id`,
    );
    seedIds = (rows as Record<string, string>[]).map((r) => r.id);
  }

  if (seedIds.length === 0) return { kind: 'searchNodes', id, data: [] };

  // Fetch full node data
  const idList = seedIds.map((i) => `'${esc(i)}'`).join(', ');
  const nodeRows = await query(
    `MATCH (n:Node) WHERE n.id IN [${idList}] RETURN n.id AS id, n.type AS type, n.name AS name, n.properties AS properties`,
  );

  let results: NodeResult[] = (nodeRows as Record<string, string>[]).map(
    (r) => {
      const props = parseProps(r.properties);
      return {
        id: r.id,
        type: r.type,
        name: r.name,
        ...(props && { properties: props }),
      };
    },
  );

  // Filter by node types if specified
  if (nodeTypes && nodeTypes.length > 0) {
    const typeSet = new Set(nodeTypes.map((t) => t.trim()));
    results = results.filter((n) => typeSet.has(n.type));
  }

  // Preserve ranked order from seedIds
  const orderMap = new Map(seedIds.map((id, idx) => [id, idx]));
  results.sort(
    (a, b) =>
      (orderMap.get(a.id) ?? Infinity) - (orderMap.get(b.id) ?? Infinity),
  );

  return { kind: 'searchNodes', id, data: results.slice(0, limit) };
}

async function handleListNodes(
  id: number,
  type: string,
  limit: number,
  filters?: Record<string, string>,
): Promise<KuzuResponse> {
  const rows = await query(
    `MATCH (n:Node) WHERE n.type = '${esc(type)}' RETURN n.id AS id, n.type AS type, n.name AS name, n.properties AS properties LIMIT ${limit}`,
  );

  let results: NodeResult[] = (rows as Record<string, string>[]).map((r) => {
    const props = parseProps(r.properties);
    return {
      id: r.id,
      type: r.type,
      name: r.name,
      ...(props && { properties: props }),
    };
  });

  // Apply property filters in JS (KuzuDB stores props as encoded JSON string)
  if (filters && Object.keys(filters).length > 0) {
    results = results.filter((n) => {
      if (!n.properties) return false;
      return Object.entries(filters).every(
        ([k, v]) => String(n.properties![k]) === v,
      );
    });
  }

  return { kind: 'listNodes', id, data: results };
}

async function handleGetNode(
  id: number,
  nodeId: string,
): Promise<KuzuResponse> {
  const rows = await query(
    `MATCH (n:Node {id: '${esc(nodeId)}'}) RETURN n.id AS id, n.type AS type, n.name AS name, n.properties AS properties`,
  );

  if (rows.length === 0) return { kind: 'getNode', id, data: null };

  const r = rows[0] as Record<string, string>;
  const props = parseProps(r.properties);
  const data: NodeResult = {
    id: r.id,
    type: r.type,
    name: r.name,
    ...(props && { properties: props }),
  };
  return { kind: 'getNode', id, data };
}

async function handleTraverse(
  id: number,
  nodeId: string,
  direction: 'outgoing' | 'incoming' | 'both',
  maxDepth: number,
  relType?: string,
): Promise<KuzuResponse> {
  const results: TraverseResult[] = [];
  const visited = new Set<string>([nodeId]);
  let frontier = new Set<string>([nodeId]);

  for (let depth = 1; depth <= maxDepth && frontier.size > 0; depth++) {
    const nextFrontier = new Set<string>();

    for (const currentId of frontier) {
      // Build direction-aware Cypher pattern
      let pattern: string;
      switch (direction) {
        case 'outgoing':
          pattern = `MATCH (a:Node {id: '${esc(currentId)}'})-[r:RELATES]->(b:Node)`;
          break;
        case 'incoming':
          pattern = `MATCH (a:Node {id: '${esc(currentId)}'})<-[r:RELATES]-(b:Node)`;
          break;
        default: // both
          pattern = `MATCH (a:Node {id: '${esc(currentId)}'})-[r:RELATES]-(b:Node)`;
          break;
      }

      const relFilter = relType ? ` AND r.type = '${esc(relType)}'` : '';
      const rows = await query(
        `${pattern} WHERE true${relFilter} RETURN b.id AS id, b.type AS type, b.name AS name, b.properties AS properties, r.id AS rel_id, r.type AS rel_type, a.id AS source_id`,
      );

      for (const row of rows as Record<string, string>[]) {
        if (visited.has(row.id)) continue;
        visited.add(row.id);
        nextFrontier.add(row.id);

        const props = parseProps(row.properties);
        const node: NodeResult = {
          id: row.id,
          type: row.type,
          name: row.name,
          ...(props && { properties: props }),
        };

        // Determine correct source/target based on direction
        const isOutgoing =
          direction === 'outgoing' ||
          (direction === 'both' && row.source_id === currentId);
        const relationship = {
          id: row.rel_id || `${currentId}->${row.id}`,
          type: row.rel_type,
          source_id: isOutgoing ? currentId : row.id,
          target_id: isOutgoing ? row.id : currentId,
        };

        results.push({ node, relationship, depth });
      }
    }

    frontier = nextFrontier;
  }

  return { kind: 'traverse', id, data: results };
}

// ---- Message handler (serialized to prevent concurrent conn.execute) ----

// kuzu-wasm wraps a single-threaded C++ engine — concurrent execute() calls
// corrupt internal state and return null.  We queue incoming messages so only
// one handler runs at a time.
let processingQueue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<KuzuRequest>) => {
  const msg = e.data;

  // .catch() prevents a rejected promise from stalling the entire queue —
  // without it, one failed handler would silently drop all subsequent messages.
  processingQueue = processingQueue
    .then(async () => {
      let response: KuzuResponse | undefined;

      try {
        switch (msg.kind) {
          case 'init':
            response = await handleInit(msg.id);
            break;
          case 'fetchGraph':
            response = await handleFetchGraph(
              msg.id,
              msg.query,
              msg.hops,
              msg.queryEmbedding,
            );
            break;
          case 'fetchStats':
            response = await handleFetchStats(msg.id);
            break;
          case 'clearGraph':
            response = await handleClearGraph(msg.id);
            break;
          case 'importBatch':
            response = await handleImportBatch(msg.id, msg);
            break;
          case 'searchNodes':
            response = await handleSearchNodes(
              msg.id,
              msg.query,
              msg.limit ?? 50,
              msg.nodeTypes,
              msg.queryEmbedding,
            );
            break;
          case 'listNodes':
            response = await handleListNodes(
              msg.id,
              msg.type,
              msg.limit ?? 50,
              msg.filters,
            );
            break;
          case 'getNode':
            response = await handleGetNode(msg.id, msg.nodeId);
            break;
          case 'setLimits':
            MAX_VIS_NODES = msg.maxNodes;
            MAX_VIS_EDGES = msg.maxEdges;
            response = { kind: 'setLimits', id: msg.id };
            break;
          case 'traverse':
            response = await handleTraverse(
              msg.id,
              msg.nodeId,
              msg.direction ?? 'outgoing',
              msg.maxDepth ?? 3,
              msg.relType,
            );
            break;
          default: {
            const unhandled = msg as { kind: string; id: number };
            console.warn(
              `[KuzuWorker] unknown message kind: ${unhandled.kind}`,
            );
            response = {
              kind: 'error',
              id: unhandled.id,
              message: `Unknown kind: ${unhandled.kind}`,
            };
          }
        }
      } catch (err) {
        console.error(`[KuzuWorker] handler error for ${msg.kind}:`, err);
        response = {
          kind: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        };
      }

      if (response) self.postMessage(response);
    })
    .catch((err) => {
      // Safety net: never let the queue stall
      console.error('[KuzuWorker] queue error (should not happen):', err);
      self.postMessage({ kind: 'error', id: msg.id, message: String(err) });
    });
};
