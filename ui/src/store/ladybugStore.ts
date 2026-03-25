/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * LadybugDB graph store using @ladybugdb/wasm-core with typed node tables.
 *
 * Uses an in-memory database with typed node tables (Repository, Directory,
 * File, Package, Class, Function) instead of a single Node table, enabling
 * direct MATCH by type without WHERE filters.  Relationships use a REL TABLE
 * GROUP spanning all observed FROM→TO pairs.  Bulk imports use CSV + COPY FROM
 * via the virtual filesystem.  Export/import uses Parquet files bundled in a
 * zip archive for cross-tool portability.
 */

import { deflateSync, inflateSync, zipSync, unzipSync } from 'fflate';
import {
  tableToIPC,
  tableFromIPC,
  vectorFromArray,
  makeData,
  RecordBatch,
  Table as ArrowTable,
  Schema,
  Field,
  Utf8,
  Struct,
} from 'apache-arrow';
/** Lazy-loaded parquet-wasm module. WASM must be instantiated before use;
 *  dynamic import ensures the binary is fetched and compiled on first call. */
let _parquetMod: typeof import('parquet-wasm/bundler') | null = null;
async function getParquetWasm(): Promise<
  typeof import('parquet-wasm/bundler')
> {
  if (!_parquetMod) {
    _parquetMod = await import('parquet-wasm/bundler');
  }
  return _parquetMod;
}

import lbug from '@ladybugdb/wasm-core';

type Database = InstanceType<typeof lbug.Database>;
type Connection = InstanceType<typeof lbug.Connection>;
import type {
  ImportBatchRequest,
  ImportBatchResponse,
  NodeResult,
  NodeSourceResponse,
  TraverseResult,
  GraphStore,
  SourceFile,
} from './types';
import type {
  GraphData,
  GraphNode,
  GraphLink,
  GraphStats,
} from '@opentrace/components/utils';
import type { Embedder } from '../runner/browser/enricher/embedder/types';
import { BM25Index } from './search/bm25';
import { VectorIndex } from './search/vector';
import { rrfFuse } from './search/rrf';

// ---- Typed schema constants ----

/** Node types emitted by the indexing pipeline. */
const NODE_TYPES = [
  'Repository',
  'Directory',
  'File',
  'Package',
  'Class',
  'Function',
  'PullRequest',
] as const;
type NodeType = (typeof NODE_TYPES)[number];

const NODE_TYPE_SET: ReadonlySet<string> = new Set<string>(NODE_TYPES);

/** Valid FROM→TO pairs for the RELATES REL TABLE GROUP. */
const REL_PAIRS: readonly [NodeType, NodeType][] = [
  ['Function', 'Function'],
  ['Function', 'File'],
  ['Function', 'Class'],
  ['Class', 'File'],
  ['Class', 'Class'],
  ['File', 'Directory'],
  ['File', 'File'],
  ['File', 'Package'],
  ['File', 'Repository'],
  ['Directory', 'Directory'],
  ['Directory', 'Repository'],
  ['Repository', 'Package'],
  ['PullRequest', 'Repository'],
  ['PullRequest', 'File'],
];

/** Set of valid "FromType_ToType" keys for fast lookup. */
const REL_PAIR_SET: ReadonlySet<string> = new Set(
  REL_PAIRS.map(([f, t]) => `${f}_${t}`),
);

// ---- CSV helpers ----

// eslint-disable-next-line no-control-regex -- intentional: strip non-printable control chars from CSV values
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

function csvEscape(value: string): string {
  const safe = (value ?? '')
    .replace(CONTROL_CHARS_RE, '') // strip control chars except \t \n \r
    .replace(/[\r\n]+/g, ' ') // flatten newlines
    .replace(/"/g, '""'); // escape quotes
  return '"' + safe + '"';
}

/** Generate CSV for a typed node table (no type column — table name IS the type). */
function generateTypedNodeCSV(nodes: ImportBatchRequest['nodes']): string {
  const lines = ['id,name,properties'];
  for (const node of nodes) {
    const props = JSON.stringify(node.properties ?? {});
    lines.push([node.id, node.name, props].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

function generateRelCSV(rels: ImportBatchRequest['relationships']): string {
  const lines = ['from,to,id,type,properties'];
  for (const rel of rels) {
    const props = JSON.stringify(rel.properties ?? {});
    lines.push(
      [rel.source_id, rel.target_id, rel.id, rel.type, props]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\n');
}

/** Maximum rows per COPY FROM call. Keeps peak CSV string + WASM allocation bounded. */
const FLUSH_CHUNK_SIZE = 500;

/** Encode a CSV string to UTF-8 bytes for FS.writeFile.
 *  Emscripten's string writeFile can produce misaligned WASM accesses
 *  with certain characters — explicit UTF-8 encoding avoids this. */
const CSV_ENCODER = new TextEncoder();

// ---- Debug performance logging ----

/**
 * Debug performance logging, controlled via localStorage:
 *   ot:debug = '1'  → method-level summaries (searchNodes, traverse, etc.)
 *   ot:debug = '2'  → method summaries + every individual Cypher query
 */
const DEBUG_KEY = 'ot:debug';
function debugLevel(): number {
  try {
    return Number(localStorage.getItem(DEBUG_KEY) || '0');
  } catch {
    return 0;
  }
}
function logPerf(
  method: string,
  params: Record<string, unknown>,
  count: number,
  ms: number,
): void {
  if (debugLevel() < 1) return;
  console.debug(
    `[LadybugStore] ${method}(${JSON.stringify(params)}) => ${count} results in ${ms.toFixed(1)}ms`,
  );
}
function logQuery(cypher: string, rowCount: number, ms: number): void {
  if (debugLevel() < 2) return;
  const short = cypher.length > 120 ? cypher.slice(0, 117) + '...' : cypher;
  console.debug(
    `[LadybugStore] query: ${short} => ${rowCount} rows in ${ms.toFixed(1)}ms`,
  );
}

// ---- Cypher helpers ----

/** Escape a string for use inside a Cypher single-quoted literal. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function parseProps(raw: unknown): Record<string, unknown> | undefined {
  if (raw == null) return undefined;
  // If getAllObjects() already returned a parsed object, use it directly
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return Object.keys(obj).length > 0 ? obj : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  if (raw === '{}' || raw === 'null' || raw === '') return undefined;
  try {
    // Support legacy URI-encoded JSON from old 0.7.0 data
    const json = raw.includes('%') ? decodeURIComponent(raw) : raw;
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ---- Schema ----

function buildSchemaStatements(): string[] {
  const stmts: string[] = [];
  for (const type of NODE_TYPES) {
    stmts.push(
      `CREATE NODE TABLE IF NOT EXISTS ${type}(id STRING PRIMARY KEY, name STRING, properties STRING)`,
    );
  }
  const pairs = REL_PAIRS.map(([f, t]) => `FROM ${f} TO ${t}`).join(', ');
  stmts.push(
    `CREATE REL TABLE GROUP IF NOT EXISTS RELATES(${pairs}, id STRING, type STRING, properties STRING)`,
  );
  return stmts;
}

const SCHEMA_STATEMENTS = buildSchemaStatements();

// ---- UNION ALL helpers ----

/** Build a UNION ALL query across all typed node tables. */
function unionAllNodes(where?: string, suffix?: string): string {
  return (
    NODE_TYPES.map((t) => {
      let q = `MATCH (n:${t})`;
      if (where) q += ` WHERE ${where}`;
      q += ` RETURN n.id AS id, '${t}' AS type, n.name AS name, n.properties AS properties`;
      return q;
    }).join(' UNION ALL ') + (suffix ?? '')
  );
}

/** Build a UNION ALL text search across all typed node tables (IDs only). */
function unionAllTextSearch(escapedLower: string): string {
  return NODE_TYPES.map(
    (t) =>
      `MATCH (n:${t}) WHERE lower(n.name) CONTAINS '${escapedLower}' RETURN n.id AS id`,
  ).join(' UNION ALL ');
}

/** Build a UNION ALL text search returning full node data (saves a round-trip). */
function unionAllTextSearchFull(escapedLower: string): string {
  return NODE_TYPES.map(
    (t) =>
      `MATCH (n:${t}) WHERE lower(n.name) CONTAINS '${escapedLower}' RETURN n.id AS id, '${t}' AS type, n.name AS name, n.properties AS properties`,
  ).join(' UNION ALL ');
}

// ---- Parquet export helpers ----

/** Safely parse a JSON string, returning fallback on error. */
function safeJsonParse(
  s: string,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}

/** Convert an array of row objects to Parquet bytes via Arrow IPC → parquet-wasm. */
async function rowsToParquet(
  rows: Record<string, unknown>[],
  columns: string[],
): Promise<Uint8Array> {
  const pw = await getParquetWasm();
  const fields = columns.map((c) => new Field(c, new Utf8()));
  const schema = new Schema(fields);
  const children = columns.map(
    (col) =>
      vectorFromArray(
        rows.map((r) => String(r[col] ?? '')),
        new Utf8(),
      ).data[0],
  );
  const structType = new Struct(fields);
  const batchData = makeData({
    type: structType,
    length: rows.length,
    children,
  });
  const batch = new RecordBatch(schema, batchData);
  const arrowTable = new ArrowTable(batch);
  const ipc = tableToIPC(arrowTable, 'stream');
  const wasmTable = pw.Table.fromIPCStream(ipc);
  return pw.writeParquet(wasmTable);
}

/** Read a Parquet file into an Arrow JS table via parquet-wasm. */
async function parquetToArrow(
  data: Uint8Array,
): Promise<import('apache-arrow').Table> {
  const pw = await getParquetWasm();
  const wasmTable = pw.readParquet(data);
  return tableFromIPC(wasmTable.intoIPCStream());
}

// ---- Store implementation ----

export class LadybugGraphStore implements GraphStore {
  private db!: Database;
  private conn!: Connection;
  private ready: Promise<void> | null = null;
  private embedder: Embedder | null = null;
  private sourceCache = new Map<
    string,
    { compressed: Uint8Array; path: string; binary?: boolean }
  >();

  // --- Write buffer ---
  private pendingNodes: ImportBatchRequest['nodes'] = [];
  private pendingRels: ImportBatchRequest['relationships'] = [];
  private totalNodesBuffered = 0;
  private totalRelsBuffered = 0;

  // --- JS-side indexes ---
  private bm25Index = new BM25Index();
  private vectorIndex: VectorIndex | null = null;

  /** Maps node ID → typed table name. Populated eagerly during importBatch. */
  private nodeTypeMap = new Map<string, string>();

  /** LRU node cache: id → {type, name, properties}. Serves getNode and
   *  fetchNodesByIds from JS memory without WASM round-trips. Capped at
   *  NODE_CACHE_MAX entries — Map insertion order acts as the eviction queue. */
  private nodeCache = new Map<
    string,
    { type: string; name: string; properties: string }
  >();
  private static readonly NODE_CACHE_MAX = 10_000;

  /** Package node IDs already written to LadybugDB. Packages are shared across
   *  repos so the same ID can arrive from multiple pipeline runs — skip
   *  duplicates to avoid LadybugDB COPY FROM primary-key violations. */
  private flushedPackageIds = new Set<string>();

  // --- Visualization limits ---
  private maxVisNodes = 20000;
  private maxVisEdges = 20000;

  // --- Serialization queue (lbug-wasm wraps single-threaded C++ engine) ---
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    // Don't init WASM here — the constructor runs at app startup.
    // WASM loads lazily on first DB operation via ensureReady().
  }

  /** True if any data has been imported (synchronous, no WASM). */
  hasData(): boolean {
    return this.nodeTypeMap.size > 0 || this.totalNodesBuffered > 0;
  }

  /** Start WASM init if not already started. Safe to call multiple times. */
  ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.initModule();
    }
    return this.ready;
  }

  private async initModule(): Promise<void> {
    const t0 = performance.now();
    lbug.setWorkerPath('/lbug_wasm_worker.js');
    await lbug.init();
    this.db = new lbug.Database(':memory:');
    await this.db.init();
    this.conn = new lbug.Connection(this.db);
    await this.conn.init();
    await this.initSchema();

    console.log(
      `[LadybugStore] ready in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    const savedNodes = localStorage.getItem('ot:maxVisNodes');
    const savedEdges = localStorage.getItem('ot:maxVisEdges');
    if (savedNodes || savedEdges) {
      const maxN = savedNodes ? Number(savedNodes) : 2000;
      const maxE = savedEdges ? Number(savedEdges) : 5000;
      if (Number.isFinite(maxN) && Number.isFinite(maxE)) {
        this.maxVisNodes = maxN;
        this.maxVisEdges = maxE;
      }
    }
  }

  private async initSchema(): Promise<void> {
    for (const stmt of SCHEMA_STATEMENTS) {
      const result = await this.conn.query(stmt);
      await result.close();
    }
  }

  /**
   * Execute a Cypher query and return all result rows as objects.
   * Uses conn.query() + getAllObjects() for row extraction.
   * Serialized through a queue to prevent concurrent calls.
   */
  private async query(cypher: string): Promise<Record<string, unknown>[]> {
    await this.ensureReady();
    return new Promise<Record<string, unknown>[]>((resolve, reject) => {
      this.queue = this.queue
        .then(async () => {
          const qt0 = performance.now();
          const result = await this.conn.query(cypher);
          try {
            const rows = await result.getAllObjects();
            logQuery(cypher, rows.length, performance.now() - qt0);
            resolve(rows);
          } finally {
            await result.close();
          }
        })
        .catch((err) => {
          reject(err);
        });
    });
  }

  /**
   * Execute a Cypher statement that doesn't return rows (DDL, COPY, etc.).
   */
  private async exec(cypher: string): Promise<void> {
    await this.ensureReady();
    return new Promise<void>((resolve, reject) => {
      this.queue = this.queue
        .then(async () => {
          const result = await this.conn.query(cypher);
          await result.close();
          resolve();
        })
        .catch((err) => {
          reject(err);
        });
    });
  }

  /** Set a node in the LRU cache, evicting oldest entries if over capacity. */
  private cacheNode(
    id: string,
    entry: { type: string; name: string; properties: string },
  ): void {
    // Delete first so re-insert moves to end (most recent)
    this.nodeCache.delete(id);
    this.nodeCache.set(id, entry);
    // Evict oldest entries if over capacity
    if (this.nodeCache.size > LadybugGraphStore.NODE_CACHE_MAX) {
      const it = this.nodeCache.keys();
      // Delete oldest 10% in one pass to avoid per-insert eviction churn
      const evictCount = Math.max(
        1,
        this.nodeCache.size - LadybugGraphStore.NODE_CACHE_MAX,
      );
      for (let i = 0; i < evictCount; i++) {
        const oldest = it.next();
        if (oldest.done) break;
        this.nodeCache.delete(oldest.value);
      }
    }
  }

  /** Close the database connection and release WASM resources. */
  async dispose(): Promise<void> {
    try {
      await this.conn?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.db?.close();
    } catch {
      /* ignore */
    }
    try {
      await lbug.close();
    } catch {
      /* ignore */
    }
  }

  /** Current WASM linear memory size in MB (for diagnostics). */
  getWasmMemoryMB(): number {
    try {
      const mem = (lbug as unknown as { wasmMemory?: WebAssembly.Memory })
        .wasmMemory;
      return mem ? mem.buffer.byteLength / (1024 * 1024) : -1;
    } catch {
      return -1;
    }
  }

  /** Set an embedder for generating query embeddings during search. */
  setEmbedder(embedder: Embedder): void {
    this.embedder = embedder;
  }

  /** Update visualization node/edge limits. */
  async setLimits(maxNodes: number, maxEdges: number): Promise<void> {
    await this.ensureReady();
    this.maxVisNodes = maxNodes;
    this.maxVisEdges = maxEdges;
  }

  async fetchGraph(query?: string, hops?: number): Promise<GraphData> {
    const t0 = performance.now();
    let data: GraphData;

    if (query && query.startsWith('type:')) {
      data = await this.searchByType(query.slice(5), hops ?? 2);
    } else if (query) {
      let queryEmbedding: number[] | undefined;
      if (this.embedder) {
        try {
          const embeddings = await this.embedder.embed([query]);
          if (embeddings.length > 0 && embeddings[0].length > 0) {
            queryEmbedding = embeddings[0];
          }
        } catch {
          // Embedding failure is non-fatal
        }
      }
      data = await this.searchGraph(query, hops ?? 2, queryEmbedding);
    } else {
      data = await this.getAllGraph();
    }

    const elapsed = performance.now() - t0;
    console.log(
      `[LadybugStore] fetchGraph: ${data.nodes.length} nodes, ${data.links.length} edges in ${elapsed.toFixed(0)}ms`,
    );
    logPerf('fetchGraph', { query, hops }, data.nodes.length, elapsed);
    return data;
  }

  private async getAllGraph(): Promise<GraphData> {
    // Count nodes + edges in 2 queries (not 8)
    const countQuery = NODE_TYPES.map(
      (t) => `MATCH (n:${t}) RETURN '${t}' AS type, count(n) AS cnt`,
    ).join(' UNION ALL ');
    const countRows = await this.query(countQuery);
    let totalNodes = 0;
    for (const row of countRows as Record<string, unknown>[]) {
      totalNodes += Number(row.cnt ?? 0);
    }

    const edgeCountRows = await this.query(
      `MATCH ()-[r:RELATES]->() RETURN count(r) AS cnt`,
    );
    const totalEdges = Number(
      (edgeCountRows as Record<string, number>[])[0]?.cnt ?? 0,
    );

    const isLarge =
      totalNodes > this.maxVisNodes || totalEdges > this.maxVisEdges;
    if (isLarge) {
      console.log(
        `[LadybugStore] Graph large: ${totalNodes} nodes, ${totalEdges} edges. Limiting to ${this.maxVisNodes}/${this.maxVisEdges}.`,
      );
    }

    // For large graphs, fetch edges first then their endpoint nodes.
    // This guarantees every edge has both endpoints in the result.
    if (isLarge) {
      // Fetch limited edges
      const relRows = await this.query(
        `MATCH (a)-[r:RELATES]->(b) ` +
          `RETURN a.id AS source, b.id AS target, r.type AS type, r.properties AS properties ` +
          `LIMIT ${this.maxVisEdges}`,
      );
      const links: GraphLink[] = (relRows as Record<string, string>[]).map(
        (r) => ({
          source: r.source,
          target: r.target,
          label: r.type,
          properties: parseProps(r.properties),
        }),
      );

      // Collect unique node IDs from edges
      const connectedIds = new Set<string>();
      for (const link of links) {
        connectedIds.add(link.source as string);
        connectedIds.add(link.target as string);
      }

      // Fetch connected nodes — routed by type instead of 7-way UNION ALL
      const cappedIds = [...connectedIds].slice(0, this.maxVisNodes);
      const nodeRows = await this.fetchNodesByIds(cappedIds);
      const nodes: GraphNode[] = (nodeRows as Record<string, string>[]).map(
        (r) => ({
          id: r.id,
          type: r.type,
          name: r.name,
          properties: parseProps(r.properties),
        }),
      );

      const nodeIdSet = new Set(nodes.map((n) => n.id));
      const filteredLinks = links.filter(
        (l) =>
          nodeIdSet.has(l.source as string) &&
          nodeIdSet.has(l.target as string),
      );

      return { nodes, links: filteredLinks };
    }

    // Small graph — fetch everything via UNION ALL
    const nodeRows = await this.query(unionAllNodes());
    const nodes: GraphNode[] = (nodeRows as Record<string, string>[]).map(
      (r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        properties: parseProps(r.properties),
      }),
    );

    const relRows = await this.query(
      `MATCH (a)-[r:RELATES]->(b) RETURN a.id AS source, b.id AS target, r.type AS type, r.properties AS properties`,
    );
    const links: GraphLink[] = (relRows as Record<string, string>[]).map(
      (r) => ({
        source: r.source,
        target: r.target,
        label: r.type,
        properties: parseProps(r.properties),
      }),
    );

    return { nodes, links };
  }

  /**
   * Batched BFS neighbor expansion: groups frontier IDs by type from
   * nodeTypeMap and issues ONE query per type instead of per-node.
   *
   * Returns the set of newly-discovered neighbor IDs (not yet in visited).
   */
  private async batchedNeighborIds(
    frontier: Set<string>,
    visited: Set<string>,
    direction: 'outgoing' | 'incoming' | 'both',
    maxNodes: number,
  ): Promise<Set<string>> {
    // Group frontier by typed table
    const byType = new Map<string, string[]>();
    for (const id of frontier) {
      const t = this.nodeTypeMap.get(id);
      if (!t) continue;
      let arr = byType.get(t);
      if (!arr) {
        arr = [];
        byType.set(t, arr);
      }
      arr.push(id);
    }

    const nextFrontier = new Set<string>();

    for (const [type, ids] of byType) {
      if (visited.size >= maxNodes) break;

      // Chunk large ID lists to avoid oversized Cypher strings
      for (let off = 0; off < ids.length; off += 500) {
        if (visited.size >= maxNodes) break;
        const chunk = ids.slice(off, off + 500);
        const idList = chunk.map((i) => `'${esc(i)}'`).join(', ');

        let pattern: string;
        switch (direction) {
          case 'outgoing':
            pattern = `MATCH (a:${type})-[r:RELATES]->(b)`;
            break;
          case 'incoming':
            pattern = `MATCH (a:${type})<-[r:RELATES]-(b)`;
            break;
          default:
            pattern = `MATCH (a:${type})-[r:RELATES]-(b)`;
            break;
        }

        const rows = await this.query(
          `${pattern} WHERE a.id IN [${idList}] RETURN b.id AS id`,
        );
        for (const row of rows as Record<string, string>[]) {
          if (visited.size >= maxNodes) break;
          if (!visited.has(row.id)) {
            visited.add(row.id);
            nextFrontier.add(row.id);
          }
        }
      }
    }

    return nextFrontier;
  }

  /**
   * Batched BFS neighbor expansion with full relationship details.
   * Used by traverse() which needs node + relationship data, not just IDs.
   */
  private async batchedNeighborsFull(
    frontier: Set<string>,
    visited: Set<string>,
    direction: 'outgoing' | 'incoming' | 'both',
    relType?: string,
  ): Promise<
    Array<{
      fromId: string;
      neighborId: string;
      neighborName: string;
      neighborProps: string;
      relId: string;
      relType: string;
      relProps: string;
      sourceId: string;
    }>
  > {
    const byType = new Map<string, string[]>();
    for (const id of frontier) {
      const t = this.nodeTypeMap.get(id);
      if (!t) continue;
      let arr = byType.get(t);
      if (!arr) {
        arr = [];
        byType.set(t, arr);
      }
      arr.push(id);
    }

    const results: Array<{
      fromId: string;
      neighborId: string;
      neighborName: string;
      neighborProps: string;
      relId: string;
      relType: string;
      relProps: string;
      sourceId: string;
    }> = [];

    for (const [type, ids] of byType) {
      for (let off = 0; off < ids.length; off += 500) {
        const chunk = ids.slice(off, off + 500);
        const idList = chunk.map((i) => `'${esc(i)}'`).join(', ');

        let pattern: string;
        switch (direction) {
          case 'outgoing':
            pattern = `MATCH (a:${type})-[r:RELATES]->(b)`;
            break;
          case 'incoming':
            pattern = `MATCH (a:${type})<-[r:RELATES]-(b)`;
            break;
          default:
            pattern = `MATCH (a:${type})-[r:RELATES]-(b)`;
            break;
        }

        const relFilter = relType ? ` AND r.type = '${esc(relType)}'` : '';
        const rows = await this.query(
          `${pattern} WHERE a.id IN [${idList}]${relFilter} RETURN a.id AS fromId, b.id AS id, b.name AS name, b.properties AS properties, r.id AS rel_id, r.type AS rel_type, r.properties AS rel_properties`,
        );

        for (const row of rows as Record<string, string>[]) {
          results.push({
            fromId: row.fromId,
            neighborId: row.id,
            neighborName: row.name,
            neighborProps: row.properties,
            relId: row.rel_id,
            relType: row.rel_type,
            relProps: row.rel_properties,
            sourceId: row.fromId,
          });
        }
      }
    }

    return results;
  }

  /**
   * Fetch node details by IDs, routing each ID to its typed table via
   * nodeTypeMap. Combines all types into a single UNION ALL query to
   * avoid multiple round-trips through the serialized WASM queue.
   */
  private async fetchNodesByIds(
    ids: Iterable<string>,
  ): Promise<Record<string, string>[]> {
    // Serve from JS-side node cache where possible
    const allRows: Record<string, string>[] = [];
    const missIds: string[] = [];

    for (const id of ids) {
      const cached = this.nodeCache.get(id);
      if (cached) {
        allRows.push({
          id,
          type: cached.type,
          name: cached.name,
          properties: cached.properties,
        });
      } else {
        missIds.push(id);
      }
    }

    // All hits — no DB round-trip needed
    if (missIds.length === 0) return allRows;

    // Fetch misses from DB
    const byType = new Map<string, string[]>();
    const unknownIds: string[] = [];

    for (const id of missIds) {
      const t = this.nodeTypeMap.get(id);
      if (t) {
        let arr = byType.get(t);
        if (!arr) {
          arr = [];
          byType.set(t, arr);
        }
        arr.push(id);
      } else {
        unknownIds.push(id);
      }
    }

    // Build a single UNION ALL across only the types that have misses
    const parts: string[] = [];

    for (const [type, typeIds] of byType) {
      const idList = typeIds.map((i) => `'${esc(i)}'`).join(', ');
      parts.push(
        `MATCH (n:${type}) WHERE n.id IN [${idList}] RETURN n.id AS id, '${type}' AS type, n.name AS name, n.properties AS properties`,
      );
    }

    // Fallback for IDs with unknown type — scan all tables
    if (unknownIds.length > 0) {
      const idList = unknownIds.map((i) => `'${esc(i)}'`).join(', ');
      parts.push(unionAllNodes(`n.id IN [${idList}]`));
    }

    if (parts.length > 0) {
      const rows = await this.query(parts.join(' UNION ALL '));
      allRows.push(...(rows as Record<string, string>[]));
    }

    return allRows;
  }

  private async searchGraph(
    search: string,
    hops: number,
    queryEmbedding?: number[],
  ): Promise<GraphData> {
    let seedIds: Set<string>;

    if (this.nodeTypeMap.has(search)) {
      seedIds = new Set([search]);
    } else {
      const rankedLists: { id: string; score: number }[][] = [];

      const bm25Results = this.bm25Index.search(search, 50);
      if (bm25Results.length > 0) rankedLists.push(bm25Results);

      if (queryEmbedding && this.vectorIndex && this.vectorIndex.size > 0) {
        const vecResults = this.vectorIndex.search(queryEmbedding, 50);
        if (vecResults.length > 0) rankedLists.push(vecResults);
      }

      if (rankedLists.length > 0) {
        const fused = rrfFuse(rankedLists, 50);
        seedIds = new Set(fused.map((r) => r.id));
      } else {
        const q = esc(search.toLowerCase());
        const seedRows = await this.query(unionAllTextSearch(q));
        seedIds = new Set(
          (seedRows as Record<string, string>[]).map((r) => r.id),
        );
      }
    }

    if (seedIds.size === 0) return { nodes: [], links: [] };

    // BFS hop expansion — batched by type instead of per-node
    const visitedNodes = new Set(seedIds);
    let frontier = new Set(seedIds);

    for (let d = 0; d < hops && frontier.size > 0; d++) {
      frontier = await this.batchedNeighborIds(
        frontier,
        visitedNodes,
        'both',
        this.maxVisNodes,
      );
      if (visitedNodes.size >= this.maxVisNodes) break;
    }

    // Fetch full node details — routed by type instead of 7-way UNION ALL
    const nodeRows = await this.fetchNodesByIds(visitedNodes);
    const nodes: GraphNode[] = (nodeRows as Record<string, string>[]).map(
      (r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        properties: parseProps(r.properties),
      }),
    );

    // Fetch edges between visited nodes
    const idList = [...visitedNodes].map((id) => `'${esc(id)}'`).join(', ');
    const relRows = await this.query(
      `MATCH (a)-[r:RELATES]->(b) WHERE a.id IN [${idList}] AND b.id IN [${idList}] ` +
        `RETURN a.id AS source, b.id AS target, r.type AS type, r.properties AS properties`,
    );
    const links: GraphLink[] = (relRows as Record<string, string>[]).map(
      (r) => ({
        source: r.source,
        target: r.target,
        label: r.type,
        properties: parseProps(r.properties),
      }),
    );

    return { nodes, links };
  }

  /** Search by node type — return all nodes of a given type plus hop neighbours. */
  private async searchByType(
    typeName: string,
    hops: number,
  ): Promise<GraphData> {
    // Find the matching KuzuDB table type (case-insensitive)
    const matchedType = NODE_TYPES.find(
      (t) => t.toLowerCase() === typeName.toLowerCase(),
    );
    if (!matchedType) return { nodes: [], links: [] };

    // Seed: all nodes of this type (capped)
    const seedRows = await this.query(
      `MATCH (n:${matchedType}) RETURN n.id AS id LIMIT ${this.maxVisNodes}`,
    );
    const seedIds = new Set(
      (seedRows as Record<string, string>[]).map((r) => r.id),
    );
    if (seedIds.size === 0) return { nodes: [], links: [] };

    // BFS hop expansion — batched by type instead of per-node
    const visitedNodes = new Set(seedIds);
    let frontier = new Set(seedIds);
    for (let d = 0; d < hops && frontier.size > 0; d++) {
      frontier = await this.batchedNeighborIds(
        frontier,
        visitedNodes,
        'both',
        this.maxVisNodes,
      );
      if (visitedNodes.size >= this.maxVisNodes) break;
    }

    // Fetch full node details — routed by type instead of 7-way UNION ALL
    const nodeRows = await this.fetchNodesByIds(visitedNodes);
    const nodes: GraphNode[] = (nodeRows as Record<string, string>[]).map(
      (r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        properties: parseProps(r.properties),
      }),
    );

    const idList = [...visitedNodes].map((id) => `'${esc(id)}'`).join(', ');
    const relRows = await this.query(
      `MATCH (a)-[r:RELATES]->(b) WHERE a.id IN [${idList}] AND b.id IN [${idList}] ` +
        `RETURN a.id AS source, b.id AS target, r.type AS type, r.properties AS properties`,
    );
    const links: GraphLink[] = (relRows as Record<string, string>[]).map(
      (r) => ({
        source: r.source,
        target: r.target,
        label: r.type,
        properties: parseProps(r.properties),
      }),
    );

    return { nodes, links };
  }

  async fetchStats(): Promise<GraphStats> {
    const t0 = performance.now();
    // Single UNION ALL for all type counts (2 queries instead of 8)
    const countQuery = NODE_TYPES.map(
      (t) => `MATCH (n:${t}) RETURN '${t}' AS type, count(n) AS cnt`,
    ).join(' UNION ALL ');
    const countRows = await this.query(countQuery);

    const nodes_by_type: Record<string, number> = {};
    let total_nodes = 0;
    for (const row of countRows as Record<string, unknown>[]) {
      const count = Number(row.cnt ?? 0);
      if (count > 0) {
        nodes_by_type[row.type as string] = count;
        total_nodes += count;
      }
    }

    const edgeRows = await this.query(
      `MATCH ()-[r:RELATES]->() RETURN count(r) AS cnt`,
    );
    const total_edges = Number(
      (edgeRows as Record<string, number>[])[0]?.cnt ?? 0,
    );

    logPerf('fetchStats', {}, total_nodes, performance.now() - t0);
    return { total_nodes, total_edges, nodes_by_type };
  }

  async clearGraph(): Promise<void> {
    // Drop REL TABLE GROUP first (references node tables)
    try {
      await this.exec(`DROP TABLE IF EXISTS RELATES`);
    } catch {
      // If group drop fails, try dropping individual sub-tables
      for (const [from, to] of REL_PAIRS) {
        try {
          await this.exec(`DROP TABLE IF EXISTS RELATES_${from}_${to}`);
        } catch {
          /* ignore */
        }
      }
    }
    // Drop all typed node tables
    for (const type of NODE_TYPES) {
      await this.exec(`DROP TABLE IF EXISTS ${type}`);
    }
    // Recreate schema
    for (const stmt of SCHEMA_STATEMENTS) {
      await this.exec(stmt);
    }
    this.vectorIndex = null;
    this.bm25Index = new BM25Index();
    this.nodeTypeMap.clear();
    this.nodeCache.clear();
    this.flushedPackageIds.clear();
    this.sourceCache.clear();
  }

  async importDatabase(
    data: Uint8Array,
    onProgress?: (msg: string) => void,
  ): Promise<ImportBatchResponse> {
    await this.ensureReady();

    // Unzip the Parquet archive and COPY FROM each file into the in-memory DB.
    onProgress?.('Unpacking Parquet archive');
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(data);
    } catch (err) {
      throw new Error(
        `Failed to unzip archive. Make sure the file is a .parquet.zip exported from OpenTrace. (${err})`,
      );
    }

    const fileNames = Object.keys(entries);
    console.log(
      `[LadybugStore] importDatabase: archive contains ${fileNames.length} files:`,
      fileNames,
    );

    if (fileNames.length === 0) {
      throw new Error(
        'Archive contains no files. Make sure you are importing a .parquet.zip exported from OpenTrace.',
      );
    }

    // Drain any pending buffered writes so they don't leak into the import
    this.pendingNodes = [];
    this.pendingRels = [];
    this.totalNodesBuffered = 0;
    this.totalRelsBuffered = 0;

    // Clear current data and reset caches
    await this.clearGraph();

    let totalNodes = 0;
    let totalRels = 0;

    // Import node tables from Parquet files → CSV → COPY FROM
    for (const type of NODE_TYPES) {
      const fileName = `nodes_${type}.parquet`;
      const fileData = entries[fileName];
      if (!fileData) continue;

      onProgress?.(`Importing ${type} nodes`);
      // Read Parquet → Arrow IPC → JS Arrow table → CSV for COPY FROM
      const arrowTable = await parquetToArrow(fileData);
      const csv = generateTypedNodeCSV(
        Array.from({ length: arrowTable.numRows }, (_, i) => ({
          id: String(arrowTable.getChild('id')?.get(i) ?? ''),
          type,
          name: String(arrowTable.getChild('name')?.get(i) ?? ''),
          properties: safeJsonParse(
            String(arrowTable.getChild('properties')?.get(i) ?? '{}'),
          ),
        })),
      );
      const csvPath = `/import_nodes_${type}.csv`;
      await lbug.FS.writeFile(csvPath, CSV_ENCODER.encode(csv));
      try {
        await this.exec(`COPY ${type} FROM '${csvPath}' (HEADER=true)`);
      } finally {
        await lbug.FS.unlink(csvPath);
      }

      // Rebuild nodeTypeMap, BM25 index, and node cache for this type
      const rows = await this.query(
        `MATCH (n:${type}) RETURN n.id AS id, n.name AS name, n.properties AS properties`,
      );
      for (const r of rows as Record<string, string>[]) {
        this.nodeTypeMap.set(r.id, type);
        this.bm25Index.addDocument(r.id, `${r.name ?? ''} ${type}`);
        this.cacheNode(r.id, {
          type,
          name: r.name ?? '',
          properties:
            typeof r.properties === 'string'
              ? r.properties
              : JSON.stringify(r.properties ?? {}),
        });
        totalNodes++;
      }
      console.log(
        `[LadybugStore] imported ${type}: ${totalNodes} nodes so far`,
      );
    }

    // Import relationships from Parquet
    const relData = entries['relationships.parquet'];
    if (relData) {
      onProgress?.('Importing relationships');

      // Read Parquet → Arrow → row objects
      const arrowTable = await parquetToArrow(relData);
      const allRows: Record<string, string>[] = Array.from(
        { length: arrowTable.numRows },
        (_, i) => ({
          from: String(arrowTable.getChild('from')?.get(i) ?? ''),
          to: String(arrowTable.getChild('to')?.get(i) ?? ''),
          id: String(arrowTable.getChild('id')?.get(i) ?? ''),
          type: String(arrowTable.getChild('type')?.get(i) ?? ''),
          properties: String(arrowTable.getChild('properties')?.get(i) ?? '{}'),
        }),
      );

      console.log(
        `[LadybugStore] relationship parquet has ${allRows.length} rows`,
      );

      try {
        const buckets = new Map<string, ImportBatchRequest['relationships']>();

        for (const row of allRows as Record<string, string>[]) {
          const srcType = this.nodeTypeMap.get(row.from);
          const tgtType = this.nodeTypeMap.get(row.to);
          if (!srcType || !tgtType) continue;
          const key = `${srcType}_${tgtType}`;
          if (!REL_PAIR_SET.has(key)) continue;

          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = [];
            buckets.set(key, bucket);
          }
          bucket.push({
            id: row.id,
            type: row.type,
            source_id: row.from,
            target_id: row.to,
            properties: parseProps(row.properties) ?? {},
          });
          totalRels++;
        }

        // Write per-subtable CSVs and COPY FROM (chunked to bound memory)
        for (const [key, bucket] of buckets) {
          for (
            let offset = 0;
            offset < bucket.length;
            offset += FLUSH_CHUNK_SIZE
          ) {
            const chunk = bucket.slice(offset, offset + FLUSH_CHUNK_SIZE);
            const csv = generateRelCSV(chunk);
            const csvPath = `/rels_${key}.csv`;
            await lbug.FS.writeFile(csvPath, CSV_ENCODER.encode(csv));
            try {
              await this.exec(
                `COPY RELATES_${key} FROM '${csvPath}' (HEADER=true)`,
              );
            } catch (err) {
              console.warn(
                `[LadybugStore] COPY RELATES_${key} failed (chunk at ${offset}):`,
                err,
              );
            }
            await lbug.FS.unlink(csvPath);
          }
        }
      } catch (err) {
        console.error('[LadybugStore] relationship import failed:', err);
      }
    }

    console.log(
      `[LadybugStore] importDatabase complete: ${totalNodes} nodes, ${totalRels} rels`,
    );
    onProgress?.('Rebuilding search indexes');
    return {
      nodes_created: totalNodes,
      relationships_created: totalRels,
    };
  }

  async exportDatabase(): Promise<Uint8Array> {
    await this.ensureReady();
    await this.flush();

    const files: Record<string, Uint8Array> = {};

    // Export each typed node table as a Parquet file via JS Arrow → parquet-wasm
    for (const type of NODE_TYPES) {
      const rows = await this.query(
        `MATCH (n:${type}) RETURN n.id AS id, n.name AS name, n.properties AS properties`,
      );
      if (rows.length === 0) continue;

      const data = await rowsToParquet(rows as Record<string, string>[], [
        'id',
        'name',
        'properties',
      ]);
      files[`nodes_${type}.parquet`] = data;
      console.log(
        `[LadybugStore] exported ${type}: ${rows.length} nodes, ${data.byteLength} bytes`,
      );
    }

    // Export all relationships as a single Parquet file
    const relRows = await this.query(
      'MATCH (a)-[r:RELATES]->(b) RETURN a.id AS `from`, b.id AS `to`, r.id AS id, r.type AS type, r.properties AS properties',
    );
    if (relRows.length > 0) {
      const data = await rowsToParquet(relRows as Record<string, string>[], [
        'from',
        'to',
        'id',
        'type',
        'properties',
      ]);
      files['relationships.parquet'] = data;
      console.log(
        `[LadybugStore] exported ${relRows.length} rels, ${data.byteLength} bytes`,
      );
    }

    console.log(
      `[LadybugStore] exportDatabase: ${Object.keys(files).length} parquet files`,
    );

    if (Object.keys(files).length === 0) {
      throw new Error('Nothing to export — the graph is empty.');
    }

    return zipSync(files);
  }

  /**
   * Buffer nodes and relationships for a later flush().
   * Returns immediately with the buffered counts (no DB call).
   */
  async importBatch(batch: ImportBatchRequest): Promise<ImportBatchResponse> {
    for (let i = 0; i < batch.nodes.length; i++) {
      this.pendingNodes.push(batch.nodes[i]);
    }
    for (let i = 0; i < batch.relationships.length; i++) {
      this.pendingRels.push(batch.relationships[i]);
    }
    this.totalNodesBuffered += batch.nodes.length;
    this.totalRelsBuffered += batch.relationships.length;

    // Populate nodeTypeMap eagerly so it's available for queries between flushes
    for (const node of batch.nodes) {
      this.nodeTypeMap.set(node.id, node.type);
    }

    return {
      nodes_created: batch.nodes.length,
      relationships_created: batch.relationships.length,
    };
  }

  /**
   * Flush all buffered writes to LadybugDB via CSV + COPY FROM.
   *
   * Nodes are deduplicated, bucketed by type, then written in chunks
   * of {@link FLUSH_CHUNK_SIZE} rows per COPY call to keep peak CSV
   * string size and WASM memory bounded.
   *
   * Relationships are flushed after all nodes (endpoints must exist)
   * using the same chunked approach.
   */
  async flush(): Promise<void> {
    if (this.pendingNodes.length === 0 && this.pendingRels.length === 0) return;
    await this.ensureReady();

    const rawNodes = this.pendingNodes;
    const rels = this.pendingRels;
    this.pendingNodes = [];
    this.pendingRels = [];

    const t0 = performance.now();

    // --- Deduplicate nodes by ID, merging properties ---
    const nodeDedup = new Map<string, (typeof rawNodes)[0]>();
    for (const node of rawNodes) {
      const existing = nodeDedup.get(node.id);
      if (existing) {
        existing.properties = {
          ...existing.properties,
          ...(node.properties ?? {}),
        };
        if (node.embedding) existing.embedding = node.embedding;
      } else {
        nodeDedup.set(node.id, { ...node, properties: { ...node.properties } });
      }
    }

    // --- Update JS-side indexes + bucket by type ---
    const buckets = new Map<string, ImportBatchRequest['nodes']>();
    let nodeCount = 0;

    for (const node of nodeDedup.values()) {
      const props = node.properties ?? {};
      this.nodeTypeMap.set(node.id, node.type);

      // Node cache — serves getNode/fetchNodesByIds from JS memory
      this.cacheNode(node.id, {
        type: node.type,
        name: node.name,
        properties: JSON.stringify(props),
      });

      // BM25 index
      const searchParts = [node.name, node.type];
      if (typeof props.summary === 'string') searchParts.push(props.summary);
      if (typeof props.path === 'string') searchParts.push(props.path);
      this.bm25Index.addDocument(node.id, searchParts.join(' '));

      // Vector index
      if (node.embedding && node.embedding.length > 0) {
        if (!this.vectorIndex)
          this.vectorIndex = new VectorIndex(node.embedding.length);
        this.vectorIndex.addVector(node.id, node.embedding);
      }

      // Bucket by type, skipping unknown types and duplicate packages
      if (!NODE_TYPE_SET.has(node.type)) {
        console.warn(
          `[LadybugStore] Unknown node type '${node.type}' for node ${node.id}, skipping`,
        );
        continue;
      }
      if (node.type === 'Package' && this.flushedPackageIds.has(node.id)) {
        continue;
      }
      if (node.type === 'Package') {
        this.flushedPackageIds.add(node.id);
      }

      let bucket = buckets.get(node.type);
      if (!bucket) {
        bucket = [];
        buckets.set(node.type, bucket);
      }
      bucket.push(node);
      nodeCount++;
    }

    // --- Flush nodes: chunked COPY FROM per type ---
    for (const [type, bucket] of buckets) {
      for (let offset = 0; offset < bucket.length; offset += FLUSH_CHUNK_SIZE) {
        const chunk = bucket.slice(offset, offset + FLUSH_CHUNK_SIZE);
        const csv = generateTypedNodeCSV(chunk);
        const path = `/nodes_${type}.csv`;
        await lbug.FS.writeFile(path, CSV_ENCODER.encode(csv));
        await this.exec(`COPY ${type} FROM '${path}' (HEADER=true)`);
        await lbug.FS.unlink(path);
      }
    }

    // --- Flush relationships: filter, bucket by subtable, chunked COPY ---
    let relCount = 0;
    if (rels.length > 0) {
      const relBuckets = new Map<string, ImportBatchRequest['relationships']>();
      for (const rel of rels) {
        const srcType = this.nodeTypeMap.get(rel.source_id);
        const tgtType = this.nodeTypeMap.get(rel.target_id);
        if (!srcType || !tgtType) continue;
        const key = `${srcType}_${tgtType}`;
        if (!REL_PAIR_SET.has(key)) continue;
        let bucket = relBuckets.get(key);
        if (!bucket) {
          bucket = [];
          relBuckets.set(key, bucket);
        }
        bucket.push(rel);
        relCount++;
      }

      for (const [key, bucket] of relBuckets) {
        for (
          let offset = 0;
          offset < bucket.length;
          offset += FLUSH_CHUNK_SIZE
        ) {
          const chunk = bucket.slice(offset, offset + FLUSH_CHUNK_SIZE);
          const csv = generateRelCSV(chunk);
          const path = `/rels_${key}.csv`;
          await lbug.FS.writeFile(path, CSV_ENCODER.encode(csv));
          try {
            await this.exec(`COPY RELATES_${key} FROM '${path}' (HEADER=true)`);
          } catch (err) {
            console.warn(
              `[LadybugStore] COPY RELATES_${key} failed (chunk at ${offset}), inserting rows individually:`,
              err,
            );
            const [srcType, tgtType] = key.split('_');
            for (const rel of chunk) {
              const props = JSON.stringify(rel.properties ?? {});
              try {
                await this.exec(
                  `MATCH (a:${srcType} {id: '${esc(rel.source_id)}'}), (b:${tgtType} {id: '${esc(rel.target_id)}'}) ` +
                    `CREATE (a)-[:RELATES {id: '${esc(rel.id)}', type: '${esc(rel.type)}', properties: '${esc(props)}'}]->(b)`,
                );
              } catch (insertErr) {
                console.warn(
                  `[LadybugStore] INSERT rel failed: ${rel.id}`,
                  insertErr,
                );
              }
            }
          }
          await lbug.FS.unlink(path);
        }
      }
    }

    const elapsed = performance.now() - t0;
    console.log(
      `[LadybugStore] flush: ${nodeCount} nodes, ${relCount} rels in ${elapsed.toFixed(0)}ms`,
    );
    logPerf(
      'flush',
      { nodes: nodeCount, rels: relCount },
      nodeCount + relCount,
      elapsed,
    );
  }

  storeSource(files: SourceFile[]): void {
    const encoder = new TextEncoder();
    for (const f of files) {
      this.sourceCache.set(f.id, {
        compressed: deflateSync(encoder.encode(f.content)),
        path: f.path,
        binary: f.binary,
      });
    }
  }

  async fetchSource(
    nodeId: string,
    startLine?: number,
    endLine?: number,
  ): Promise<NodeSourceResponse | null> {
    const fileId = nodeId.includes('::')
      ? nodeId.slice(0, nodeId.indexOf('::'))
      : nodeId;
    const entry = this.sourceCache.get(fileId);
    if (!entry) return null;

    // Decompress on demand
    const content = new TextDecoder().decode(inflateSync(entry.compressed));

    if (entry.binary) {
      return {
        content,
        path: entry.path,
        line_count: 0,
        binary: true,
      };
    }

    const allLines = content.split('\n');
    const totalLines = allLines.length;

    if (startLine != null && endLine != null) {
      const sliced = allLines.slice(startLine - 1, endLine);
      return {
        content: sliced.join('\n'),
        path: entry.path,
        start_line: startLine,
        end_line: endLine,
        line_count: totalLines,
      };
    }

    return {
      content,
      path: entry.path,
      line_count: totalLines,
    };
  }

  // ---- Chat tool methods ----

  async searchNodes(
    queryStr: string,
    limit?: number,
    nodeTypes?: string[],
  ): Promise<NodeResult[]> {
    const t0 = performance.now();

    // Phase 1: Embedding
    let queryEmbedding: number[] | undefined;
    if (this.embedder) {
      try {
        const embeddings = await this.embedder.embed([queryStr]);
        if (embeddings.length > 0 && embeddings[0].length > 0) {
          queryEmbedding = embeddings[0];
        }
      } catch {
        // Embedding failure is non-fatal
      }
    }
    const tEmbed = performance.now();

    // Phase 2: BM25 + vector ranking
    const effectiveLimit = limit ?? 50;
    const rankedLists: { id: string; score: number }[][] = [];

    const bm25Results = this.bm25Index.search(queryStr, effectiveLimit * 2);
    if (bm25Results.length > 0) rankedLists.push(bm25Results);

    if (queryEmbedding && this.vectorIndex && this.vectorIndex.size > 0) {
      const vecResults = this.vectorIndex.search(
        queryEmbedding,
        effectiveLimit * 2,
      );
      if (vecResults.length > 0) rankedLists.push(vecResults);
    }
    const tRank = performance.now();

    // Phase 3: Fusion / fallback text search
    let seedIds: string[];
    let searchPath: string;
    // If the fallback returns full node data, we can skip the fetch phase
    let prefetchedRows: Record<string, string>[] | null = null;

    if (rankedLists.length > 0) {
      const fused = rrfFuse(rankedLists, effectiveLimit * 2);
      seedIds = fused.map((r) => r.id);
      searchPath = `rrf(bm25=${bm25Results.length},vec=${queryEmbedding ? (rankedLists.length > 1 ? (rankedLists[1]?.length ?? 0) : 0) : 'off'})`;
    } else {
      // Cypher CONTAINS fallback — return full node data in one round-trip
      const q = esc(queryStr.toLowerCase());
      const rows = await this.query(unionAllTextSearchFull(q));
      prefetchedRows = rows as Record<string, string>[];
      seedIds = prefetchedRows.map((r) => r.id);
      searchPath = 'cypher-contains';
    }
    const tFuse = performance.now();

    if (seedIds.length === 0) {
      logPerf(
        'searchNodes',
        {
          queryStr,
          limit,
          nodeTypes,
          results: 0,
          seedIds: 0,
          searchPath,
          embed_ms: +(tEmbed - t0).toFixed(1),
          rank_ms: +(tRank - tEmbed).toFixed(1),
          fuse_ms: +(tFuse - tRank).toFixed(1),
          fetch_ms: 0,
        },
        0,
        performance.now() - t0,
      );
      return [];
    }

    // Phase 4: Fetch full node details (skip if already fetched in phase 3)
    const nodeRows = prefetchedRows ?? (await this.fetchNodesByIds(seedIds));
    const tFetch = performance.now();

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

    if (nodeTypes && nodeTypes.length > 0) {
      const typeSet = new Set(nodeTypes.map((t) => t.trim()));
      results = results.filter((n) => typeSet.has(n.type));
    }

    // Preserve ranked order
    const orderMap = new Map(seedIds.map((id, idx) => [id, idx]));
    results.sort(
      (a, b) =>
        (orderMap.get(a.id) ?? Infinity) - (orderMap.get(b.id) ?? Infinity),
    );

    const final = results.slice(0, effectiveLimit);
    logPerf(
      'searchNodes',
      {
        queryStr,
        limit,
        nodeTypes,
        searchPath,
        seedIds: seedIds.length,
        results: final.length,
        embed_ms: +(tEmbed - t0).toFixed(1),
        rank_ms: +(tRank - tEmbed).toFixed(1),
        fuse_ms: +(tFuse - tRank).toFixed(1),
        fetch_ms: +(tFetch - tFuse).toFixed(1),
      },
      final.length,
      performance.now() - t0,
    );
    return final;
  }

  async listNodes(
    type: string,
    limit?: number,
    filters?: Record<string, string>,
  ): Promise<NodeResult[]> {
    const t0 = performance.now();
    const effectiveLimit = limit ?? 50;

    // Validate type to prevent Cypher injection and route to typed table
    if (!NODE_TYPE_SET.has(type)) {
      return [];
    }

    const rows = await this.query(
      `MATCH (n:${type}) RETURN n.id AS id, '${type}' AS type, n.name AS name, n.properties AS properties LIMIT ${effectiveLimit}`,
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

    if (filters && Object.keys(filters).length > 0) {
      results = results.filter((n) => {
        if (!n.properties) return false;
        return Object.entries(filters).every(
          ([k, v]) => String(n.properties![k]) === v,
        );
      });
    }

    logPerf(
      'listNodes',
      { type, limit, filters },
      results.length,
      performance.now() - t0,
    );
    return results;
  }

  async getNode(nodeId: string): Promise<NodeResult | null> {
    const t0 = performance.now();

    // Cache path: serve from JS memory (0ms, no WASM round-trip)
    const cached = this.nodeCache.get(nodeId);
    if (cached) {
      // Promote to most-recent (LRU)
      this.nodeCache.delete(nodeId);
      this.nodeCache.set(nodeId, cached);
      const props = parseProps(cached.properties);
      logPerf('getNode', { nodeId, path: 'cache' }, 1, performance.now() - t0);
      return {
        id: nodeId,
        type: cached.type,
        name: cached.name,
        ...(props && { properties: props }),
      };
    }

    const nodeType = this.nodeTypeMap.get(nodeId);

    if (nodeType) {
      // Fast path: known type → direct table lookup
      const rows = await this.query(
        `MATCH (n:${nodeType} {id: '${esc(nodeId)}'}) RETURN n.id AS id, '${nodeType}' AS type, n.name AS name, n.properties AS properties`,
      );
      if (rows.length === 0) {
        logPerf(
          'getNode',
          { nodeId, path: 'typed' },
          0,
          performance.now() - t0,
        );
        return null;
      }
      const r = rows[0] as Record<string, string>;
      const props = parseProps(r.properties);
      logPerf('getNode', { nodeId, path: 'typed' }, 1, performance.now() - t0);
      return {
        id: r.id,
        type: r.type,
        name: r.name,
        ...(props && { properties: props }),
      };
    }

    // Slow path: unknown type → UNION ALL across all tables
    const rows = await this.query(unionAllNodes(`n.id = '${esc(nodeId)}'`));
    if (rows.length === 0) return null;

    const r = rows[0] as Record<string, string>;
    const props = parseProps(r.properties);
    // Cache the discovered type for future lookups
    this.nodeTypeMap.set(r.id, r.type);
    logPerf('getNode', { nodeId, path: 'union' }, 1, performance.now() - t0);
    return {
      id: r.id,
      type: r.type,
      name: r.name,
      ...(props && { properties: props }),
    };
  }

  async traverse(
    nodeId: string,
    direction?: 'outgoing' | 'incoming' | 'both',
    maxDepth?: number,
    relType?: string,
  ): Promise<TraverseResult[]> {
    const t0 = performance.now();
    const dir = direction ?? 'outgoing';
    const depth = maxDepth ?? 3;
    const results: TraverseResult[] = [];
    const visited = new Set<string>([nodeId]);
    let frontier = new Set<string>([nodeId]);
    const depthTimings: string[] = [];

    for (let d = 1; d <= depth && frontier.size > 0; d++) {
      const td0 = performance.now();
      const neighbors = await this.batchedNeighborsFull(
        frontier,
        visited,
        dir,
        relType,
      );

      const nextFrontier = new Set<string>();

      for (const nb of neighbors) {
        if (visited.has(nb.neighborId)) continue;
        visited.add(nb.neighborId);
        nextFrontier.add(nb.neighborId);

        const bType = this.nodeTypeMap.get(nb.neighborId) ?? 'Unknown';
        const props = parseProps(nb.neighborProps);
        const node: NodeResult = {
          id: nb.neighborId,
          type: bType,
          name: nb.neighborName,
          ...(props && { properties: props }),
        };

        const isOutgoing =
          dir === 'outgoing' || (dir === 'both' && nb.sourceId === nb.fromId);
        const relProps = parseProps(nb.relProps);
        const relationship = {
          id: nb.relId || `${nb.fromId}->${nb.neighborId}`,
          type: nb.relType,
          source_id: isOutgoing ? nb.fromId : nb.neighborId,
          target_id: isOutgoing ? nb.neighborId : nb.fromId,
          ...(relProps && { properties: relProps }),
        };

        results.push({ node, relationship, depth: d });
      }

      depthTimings.push(
        `d${d}:${frontier.size}→${nextFrontier.size} in ${(performance.now() - td0).toFixed(0)}ms`,
      );
      frontier = nextFrontier;
    }

    logPerf(
      'traverse',
      {
        nodeId,
        direction: dir,
        maxDepth: depth,
        relType,
        results: results.length,
        visited: visited.size,
        depths: depthTimings.join(', '),
      },
      results.length,
      performance.now() - t0,
    );
    return results;
  }
}
