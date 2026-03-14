/**
 * KuzuDB graph store using kuzu-wasm 0.11.3 with typed node tables.
 *
 * Uses typed node tables (Repository, Directory, File, Package, Class,
 * Function) instead of a single Node table, enabling direct MATCH by type
 * without WHERE filters.  Relationships use a REL TABLE GROUP spanning all
 * observed FROM→TO pairs.  Bulk imports use CSV + COPY FROM via the virtual
 * filesystem.
 */

import kuzu from 'kuzu-wasm';
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
} from '../types/graph';
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
];

/** Set of valid "FromType_ToType" keys for fast lookup. */
const REL_PAIR_SET: ReadonlySet<string> = new Set(
  REL_PAIRS.map(([f, t]) => `${f}_${t}`),
);

// ---- CSV helpers ----

function csvEscape(value: string): string {
  // Always quote to avoid ambiguity — KuzuDB's CSV parser can misparse
  // fields containing JSON with nested commas + quotes.
  return '"' + value.replace(/"/g, '""') + '"';
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

/** Build a UNION ALL text search across all typed node tables. */
function unionAllTextSearch(escapedLower: string): string {
  return NODE_TYPES.map(
    (t) =>
      `MATCH (n:${t}) WHERE lower(n.name) CONTAINS '${escapedLower}' RETURN n.id AS id`,
  ).join(' UNION ALL ');
}

// ---- Store implementation ----

export class KuzuGraphStore implements GraphStore {
  private db: InstanceType<typeof kuzu.Database>;
  private conn: InstanceType<typeof kuzu.Connection>;
  private ready: Promise<void>;
  private embedder: Embedder | null = null;
  private sourceCache = new Map<
    string,
    { content: string; path: string; binary?: boolean }
  >();

  // --- Write buffer ---
  private pendingNodes: ImportBatchRequest['nodes'] = [];
  private pendingRels: ImportBatchRequest['relationships'] = [];
  private totalNodesBuffered = 0;
  private totalRelsBuffered = 0;

  // --- JS-side indexes ---
  private bm25Index = new BM25Index();
  private vectorIndex: VectorIndex | null = null;
  private nodePropsCache = new Map<string, Record<string, unknown>>();

  /** Maps node ID → typed table name. Populated eagerly during importBatch. */
  private nodeTypeMap = new Map<string, string>();

  /**
   * Tracks whether group-level COPY RELATES works (null = untested).
   * If false, falls back to per-subtable COPY FROM.
   */
  private relGroupCopyWorks: boolean | null = null;

  // --- Visualization limits ---
  private maxVisNodes = 2000;
  private maxVisEdges = 5000;

  // --- Serialization queue (kuzu-wasm wraps single-threaded C++ engine) ---
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    kuzu.setWorkerPath('/kuzu_wasm_worker.js');
    this.db = new kuzu.Database(':memory:', 512 * 1024 * 1024);
    this.conn = new kuzu.Connection(this.db);
    this.ready = this.initSchema().then(() => {
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
    });
  }

  private async initSchema(): Promise<void> {
    for (const stmt of SCHEMA_STATEMENTS) {
      const result = await this.conn.query(stmt);
      await result.close();
    }
  }

  /**
   * Execute a Cypher query and return all result rows as objects.
   * Serialized through a queue to prevent concurrent execute() calls.
   */
  private async query(cypher: string): Promise<Record<string, unknown>[]> {
    await this.ready;
    return new Promise<Record<string, unknown>[]>((resolve, reject) => {
      this.queue = this.queue
        .then(async () => {
          const result = await this.conn.query(cypher);
          if (!result.isSuccess()) {
            const err = await result.getErrorMessage();
            await result.close();
            throw new Error(err);
          }
          const rows = await result.getAllObjects();
          await result.close();
          resolve(rows);
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
    await this.ready;
    return new Promise<void>((resolve, reject) => {
      this.queue = this.queue
        .then(async () => {
          const result = await this.conn.query(cypher);
          if (!result.isSuccess()) {
            const err = await result.getErrorMessage();
            await result.close();
            throw new Error(err);
          }
          await result.close();
          resolve();
        })
        .catch((err) => {
          reject(err);
        });
    });
  }

  /** Set an embedder for generating query embeddings during search. */
  setEmbedder(embedder: Embedder): void {
    this.embedder = embedder;
  }

  /** Update visualization node/edge limits. */
  async setLimits(maxNodes: number, maxEdges: number): Promise<void> {
    await this.ready;
    this.maxVisNodes = maxNodes;
    this.maxVisEdges = maxEdges;
  }

  async fetchGraph(query?: string, hops?: number): Promise<GraphData> {
    const t0 = performance.now();
    let data: GraphData;

    if (query) {
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

    console.log(
      `[KuzuStore] fetchGraph: ${data.nodes.length} nodes, ${data.links.length} edges in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return data;
  }

  private async getAllGraph(): Promise<GraphData> {
    // Count nodes across all typed tables
    let totalNodes = 0;
    for (const type of NODE_TYPES) {
      const rows = await this.query(`MATCH (n:${type}) RETURN count(n) AS cnt`);
      totalNodes += Number((rows as Record<string, number>[])[0]?.cnt ?? 0);
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
        `[KuzuStore] Graph large: ${totalNodes} nodes, ${totalEdges} edges. Limiting to ${this.maxVisNodes}/${this.maxVisEdges}.`,
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

      // Fetch connected nodes via UNION ALL across typed tables
      const nodeList = [...connectedIds]
        .slice(0, this.maxVisNodes)
        .map((id) => `'${esc(id)}'`)
        .join(', ');

      const nodeRows = await this.query(unionAllNodes(`n.id IN [${nodeList}]`));
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

  private async searchGraph(
    search: string,
    hops: number,
    queryEmbedding?: number[],
  ): Promise<GraphData> {
    let seedIds: Set<string>;

    if (this.nodePropsCache.has(search)) {
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

    // BFS hop expansion using typed start nodes
    const visitedNodes = new Set(seedIds);
    let frontier = new Set(seedIds);

    for (let d = 0; d < hops && frontier.size > 0; d++) {
      const nextFrontier = new Set<string>();

      for (const nodeId of frontier) {
        if (visitedNodes.size >= this.maxVisNodes) break;
        const nodeType = this.nodeTypeMap.get(nodeId);
        if (!nodeType) continue; // unknown type — skip
        const neighbors = await this.query(
          `MATCH (a:${nodeType} {id: '${esc(nodeId)}'})-[r:RELATES]-(b) RETURN b.id AS id`,
        );
        for (const row of neighbors as Record<string, string>[]) {
          if (!visitedNodes.has(row.id)) {
            visitedNodes.add(row.id);
            nextFrontier.add(row.id);
            if (visitedNodes.size >= this.maxVisNodes) break;
          }
        }
      }

      frontier = nextFrontier;
      if (visitedNodes.size >= this.maxVisNodes) break;
    }

    // Fetch full node details via UNION ALL
    const nodeList = [...visitedNodes].map((id) => `'${esc(id)}'`).join(', ');
    const nodeRows = await this.query(unionAllNodes(`n.id IN [${nodeList}]`));
    const nodes: GraphNode[] = (nodeRows as Record<string, string>[]).map(
      (r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        properties: parseProps(r.properties),
      }),
    );

    // Fetch edges between visited nodes
    const relRows = await this.query(
      `MATCH (a)-[r:RELATES]->(b) WHERE a.id IN [${nodeList}] AND b.id IN [${nodeList}] ` +
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
    // One count per typed table
    const nodes_by_type: Record<string, number> = {};
    let total_nodes = 0;
    for (const type of NODE_TYPES) {
      const rows = await this.query(`MATCH (n:${type}) RETURN count(n) AS cnt`);
      const count = Number((rows as Record<string, number>[])[0]?.cnt ?? 0);
      if (count > 0) {
        nodes_by_type[type] = count;
        total_nodes += count;
      }
    }

    const edgeRows = await this.query(
      `MATCH ()-[r:RELATES]->() RETURN count(r) AS cnt`,
    );
    const total_edges = Number(
      (edgeRows as Record<string, number>[])[0]?.cnt ?? 0,
    );

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
    this.nodePropsCache.clear();
    this.nodeTypeMap.clear();
    this.relGroupCopyWorks = null;
    this.sourceCache.clear();
  }

  /**
   * Buffer nodes and relationships for a later flush().
   * Returns immediately with the buffered counts (no DB call).
   */
  async importBatch(batch: ImportBatchRequest): Promise<ImportBatchResponse> {
    this.pendingNodes.push(...batch.nodes);
    this.pendingRels.push(...batch.relationships);
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
   * Flush all buffered writes to KuzuDB via CSV + COPY FROM.
   * Nodes are bucketed by type and written to per-type CSVs.
   * Relationships are written via the RELATES REL TABLE GROUP.
   */
  async flush(): Promise<void> {
    if (this.pendingNodes.length === 0 && this.pendingRels.length === 0) return;
    await this.ready;

    const nodes = this.pendingNodes;
    const rels = this.pendingRels;
    this.pendingNodes = [];
    this.pendingRels = [];

    const t0 = performance.now();

    // Update JS-side indexes before writing to DB
    for (const node of nodes) {
      const props = node.properties ?? {};
      this.nodePropsCache.set(node.id, props);
      this.nodeTypeMap.set(node.id, node.type);

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
    }

    // Bucket nodes by type and write per-type CSVs
    if (nodes.length > 0) {
      const buckets = new Map<string, ImportBatchRequest['nodes']>();
      for (const node of nodes) {
        if (!NODE_TYPE_SET.has(node.type)) {
          console.warn(
            `[KuzuStore] Unknown node type '${node.type}' for node ${node.id}, skipping`,
          );
          continue;
        }
        let bucket = buckets.get(node.type);
        if (!bucket) {
          bucket = [];
          buckets.set(node.type, bucket);
        }
        bucket.push(node);
      }

      for (const [type, bucket] of buckets) {
        const csv = generateTypedNodeCSV(bucket);
        const path = `/nodes_${type}.csv`;
        await kuzu.FS.writeFile(path, csv);
        await this.exec(`COPY ${type} FROM '${path}' (HEADER=true)`);
        await kuzu.FS.unlink(path);
      }
    }

    // Write relationships — try group COPY, fall back to per-subtable COPY
    if (rels.length > 0) {
      // Filter to supported type pairs
      const validRels: ImportBatchRequest['relationships'] = [];
      for (const rel of rels) {
        const srcType = this.nodeTypeMap.get(rel.source_id);
        const tgtType = this.nodeTypeMap.get(rel.target_id);
        if (!srcType || !tgtType) {
          console.warn(
            `[KuzuStore] Skipping rel ${rel.id}: unknown node type (src=${srcType}, tgt=${tgtType})`,
          );
          continue;
        }
        if (!REL_PAIR_SET.has(`${srcType}_${tgtType}`)) {
          console.warn(
            `[KuzuStore] Skipping rel ${rel.id}: unsupported pair ${srcType} → ${tgtType}`,
          );
          continue;
        }
        validRels.push(rel);
      }

      if (validRels.length > 0) {
        if (this.relGroupCopyWorks !== false) {
          // Try group-level COPY first
          const csv = generateRelCSV(validRels);
          await kuzu.FS.writeFile('/rels.csv', csv);
          try {
            await this.exec("COPY RELATES FROM '/rels.csv' (HEADER=true)");
            this.relGroupCopyWorks = true;
            await kuzu.FS.unlink('/rels.csv');
          } catch (err) {
            console.warn(
              '[KuzuStore] Group COPY RELATES failed, falling back to per-subtable COPY:',
              err,
            );
            this.relGroupCopyWorks = false;
            await kuzu.FS.unlink('/rels.csv');
            // Fall through to per-subtable approach
          }
        }

        if (this.relGroupCopyWorks === false) {
          await this.copyRelsBySubtable(validRels);
        }
      }
    }

    const elapsed = performance.now() - t0;
    console.log(
      `[KuzuStore] flush: ${nodes.length} nodes, ${rels.length} rels in ${elapsed.toFixed(0)}ms`,
    );
  }

  /**
   * Fallback: bucket relationships by (srcType, tgtType) and COPY each
   * sub-table of the REL TABLE GROUP individually.
   */
  private async copyRelsBySubtable(
    rels: ImportBatchRequest['relationships'],
  ): Promise<void> {
    const buckets = new Map<string, ImportBatchRequest['relationships']>();
    for (const rel of rels) {
      const srcType = this.nodeTypeMap.get(rel.source_id)!;
      const tgtType = this.nodeTypeMap.get(rel.target_id)!;
      const key = `${srcType}_${tgtType}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(rel);
    }

    for (const [key, bucket] of buckets) {
      const csv = generateRelCSV(bucket);
      const path = `/rels_${key}.csv`;
      await kuzu.FS.writeFile(path, csv);
      try {
        await this.exec(`COPY RELATES_${key} FROM '${path}' (HEADER=true)`);
      } catch (err) {
        // Last resort: per-row INSERT
        console.warn(
          `[KuzuStore] COPY RELATES_${key} failed, inserting rows individually:`,
          err,
        );
        const [srcType, tgtType] = key.split('_');
        for (const rel of bucket) {
          const props = JSON.stringify(rel.properties ?? {});
          try {
            await this.exec(
              `MATCH (a:${srcType} {id: '${esc(rel.source_id)}'}), (b:${tgtType} {id: '${esc(rel.target_id)}'}) ` +
                `CREATE (a)-[:RELATES {id: '${esc(rel.id)}', type: '${esc(rel.type)}', properties: '${esc(props)}'}]->(b)`,
            );
          } catch (insertErr) {
            console.warn(`[KuzuStore] INSERT rel failed: ${rel.id}`, insertErr);
          }
        }
      }
      await kuzu.FS.unlink(path);
    }
  }

  storeSource(files: SourceFile[]): void {
    for (const f of files) {
      this.sourceCache.set(f.id, {
        content: f.content,
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

    if (entry.binary) {
      return {
        content: entry.content,
        path: entry.path,
        line_count: 0,
        binary: true,
      };
    }

    const allLines = entry.content.split('\n');
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
      content: entry.content,
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

    let seedIds: string[];

    if (rankedLists.length > 0) {
      const fused = rrfFuse(rankedLists, effectiveLimit * 2);
      seedIds = fused.map((r) => r.id);
    } else {
      const q = esc(queryStr.toLowerCase());
      const rows = await this.query(unionAllTextSearch(q));
      seedIds = (rows as Record<string, string>[]).map((r) => r.id);
    }

    if (seedIds.length === 0) return [];

    // Fetch full node details via UNION ALL
    const idList = seedIds.map((i) => `'${esc(i)}'`).join(', ');
    const nodeRows = await this.query(unionAllNodes(`n.id IN [${idList}]`));

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

    return results.slice(0, effectiveLimit);
  }

  async listNodes(
    type: string,
    limit?: number,
    filters?: Record<string, string>,
  ): Promise<NodeResult[]> {
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

    return results;
  }

  async getNode(nodeId: string): Promise<NodeResult | null> {
    const nodeType = this.nodeTypeMap.get(nodeId);

    if (nodeType) {
      // Fast path: known type → direct table lookup
      const rows = await this.query(
        `MATCH (n:${nodeType} {id: '${esc(nodeId)}'}) RETURN n.id AS id, '${nodeType}' AS type, n.name AS name, n.properties AS properties`,
      );
      if (rows.length === 0) return null;
      const r = rows[0] as Record<string, string>;
      const props = parseProps(r.properties);
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
    const dir = direction ?? 'outgoing';
    const depth = maxDepth ?? 3;
    const results: TraverseResult[] = [];
    const visited = new Set<string>([nodeId]);
    let frontier = new Set<string>([nodeId]);

    for (let d = 1; d <= depth && frontier.size > 0; d++) {
      const nextFrontier = new Set<string>();

      for (const currentId of frontier) {
        const aType = this.nodeTypeMap.get(currentId);
        if (!aType) continue; // unknown type — skip

        let pattern: string;
        switch (dir) {
          case 'outgoing':
            pattern = `MATCH (a:${aType} {id: '${esc(currentId)}'})-[r:RELATES]->(b)`;
            break;
          case 'incoming':
            pattern = `MATCH (a:${aType} {id: '${esc(currentId)}'})<-[r:RELATES]-(b)`;
            break;
          default:
            pattern = `MATCH (a:${aType} {id: '${esc(currentId)}'})-[r:RELATES]-(b)`;
            break;
        }

        const relFilter = relType ? ` AND r.type = '${esc(relType)}'` : '';
        const rows = await this.query(
          `${pattern} WHERE true${relFilter} RETURN b.id AS id, b.name AS name, b.properties AS properties, r.id AS rel_id, r.type AS rel_type, r.properties AS rel_properties, a.id AS source_id`,
        );

        for (const row of rows as Record<string, string>[]) {
          if (visited.has(row.id)) continue;
          visited.add(row.id);
          nextFrontier.add(row.id);

          // Resolve neighbor type from nodeTypeMap
          const bType = this.nodeTypeMap.get(row.id) ?? 'Unknown';
          const props = parseProps(row.properties);
          const node: NodeResult = {
            id: row.id,
            type: bType,
            name: row.name,
            ...(props && { properties: props }),
          };

          const isOutgoing =
            dir === 'outgoing' ||
            (dir === 'both' && row.source_id === currentId);
          const relProps = parseProps(row.rel_properties);
          const relationship = {
            id: row.rel_id || `${currentId}->${row.id}`,
            type: row.rel_type,
            source_id: isOutgoing ? currentId : row.id,
            target_id: isOutgoing ? row.id : currentId,
            ...(relProps && { properties: relProps }),
          };

          results.push({ node, relationship, depth: d });
        }
      }

      frontier = nextFrontier;
    }

    return results;
  }
}
