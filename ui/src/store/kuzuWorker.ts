/**
 * Web Worker that runs an in-memory KuzuDB instance via kuzu-wasm.
 *
 * Receives KuzuRequest messages, executes Cypher queries, and posts
 * KuzuResponse messages back to the main thread.
 */

import kuzu_wasm, { type Connection, type KuzuModule } from "@kuzu/kuzu-wasm";
import type { KuzuRequest, KuzuResponse, NodeResult, TraverseResult } from "./kuzuProtocol";
import type { GraphData, GraphNode, GraphLink, GraphStats } from "../types/graph";
import type { ImportBatchResponse } from "./types";
import { BM25Index } from "./search/bm25";
import { VectorIndex } from "./search/vector";
import { rrfFuse } from "./search/rrf";

// ---- Module-level state ----

let conn: Connection | null = null;
let kuzu: KuzuModule | null = null;

/** In-memory BM25 index for text search (kuzu-wasm lacks FTS extension). */
const bm25Index = new BM25Index();

/** In-memory vector index for embedding search (kuzu-wasm lacks vector extension). */
let vectorIndex: VectorIndex | null = null;

// ---- Helpers ----

/** Escape a string for use inside a Cypher single-quoted literal. */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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

async function query(cypher: string): Promise<unknown[]> {
  if (!conn) throw new Error("KuzuDB not initialized");
  const res = await conn.execute(cypher);
  const raw = res.table.toString();
  if (!raw || raw === "[]") return [];
  return JSON.parse(raw) as unknown[];
}

// ---- Schema ----

const SCHEMA_STATEMENTS = [
  `CREATE NODE TABLE IF NOT EXISTS Node(id STRING PRIMARY KEY, type STRING, name STRING, properties STRING)`,
  `CREATE REL TABLE IF NOT EXISTS RELATES(FROM Node TO Node, id STRING, type STRING, properties STRING)`,
];

async function createSchema() {
  for (const stmt of SCHEMA_STATEMENTS) {
    await conn!.execute(stmt);
  }
}

// ---- Operations ----

async function handleInit(id: number): Promise<KuzuResponse> {
  kuzu = await kuzu_wasm();
  const db = await kuzu.Database();
  conn = await kuzu.Connection(db);
  await createSchema();
  return { kind: "ready", id };
}

async function handleImportBatch(id: number, batch: KuzuRequest & { kind: "importBatch" }): Promise<KuzuResponse> {
  let nodesCreated = 0;
  let relsCreated = 0;

  for (const node of batch.batch.nodes) {
    const props = node.properties ? esc(encodeProps(node.properties)) : "{}";
    await conn!.execute(
      `MERGE (n:Node {id: '${esc(node.id)}'}) SET n.type = '${esc(node.type)}', n.name = '${esc(node.name)}', n.properties = '${props}'`,
    );
    nodesCreated++;

    // Index into BM25 for text search.
    const searchParts = [node.name, node.type];
    if (node.properties) {
      if (typeof node.properties.summary === "string") searchParts.push(node.properties.summary);
      if (typeof node.properties.path === "string") searchParts.push(node.properties.path);
    }
    bm25Index.addDocument(node.id, searchParts.join(" "));

    // Index embedding if present.
    if (node.embedding && node.embedding.length > 0) {
      if (!vectorIndex) {
        vectorIndex = new VectorIndex(node.embedding.length);
      }
      vectorIndex.addVector(node.id, node.embedding);
    }
  }

  for (const rel of batch.batch.relationships) {
    const props = rel.properties ? esc(encodeProps(rel.properties)) : "{}";
    // Use MERGE for the relationship to avoid duplicates
    await conn!.execute(
      `MATCH (a:Node {id: '${esc(rel.source_id)}'}), (b:Node {id: '${esc(rel.target_id)}'}) ` +
      `CREATE (a)-[:RELATES {id: '${esc(rel.id)}', type: '${esc(rel.type)}', properties: '${props}'}]->(b)`,
    );
    relsCreated++;
  }

  const data: ImportBatchResponse = {
    nodes_created: nodesCreated,
    relationships_created: relsCreated,
  };
  return { kind: "importBatch", id, data };
}

async function handleFetchGraph(id: number, queryStr?: string, hops?: number, queryEmbedding?: number[]): Promise<KuzuResponse> {
  let data: GraphData;

  if (queryStr) {
    data = await searchGraph(queryStr, hops ?? 2, queryEmbedding);
  } else {
    data = await getAllGraph();
  }

  return { kind: "fetchGraph", id, data };
}

async function getAllGraph(): Promise<GraphData> {
  const nodeRows = await query(
    `MATCH (n:Node) RETURN n.id AS id, n.type AS type, n.name AS name, n.properties AS properties`,
  );
  const nodes: GraphNode[] = (nodeRows as Record<string, string>[]).map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    properties: parseProps(r.properties),
  }));

  const relRows = await query(
    `MATCH (a:Node)-[r:RELATES]->(b:Node) RETURN a.id AS source, b.id AS target, r.type AS type`,
  );
  const links: GraphLink[] = (relRows as Record<string, string>[]).map((r) => ({
    source: r.source,
    target: r.target,
    label: r.type,
  }));

  return { nodes, links };
}

async function searchGraph(search: string, hops: number, queryEmbedding?: number[]): Promise<GraphData> {
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

  let seedIds: Set<string>;

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
    seedIds = new Set((seedRows as Record<string, string>[]).map((r) => r.id));
  }

  if (seedIds.size === 0) {
    return { nodes: [], links: [] };
  }

  // BFS: expand hops
  const visitedNodes = new Set(seedIds);
  let frontier = new Set(seedIds);

  for (let d = 0; d < hops && frontier.size > 0; d++) {
    const nextFrontier = new Set<string>();

    for (const nodeId of frontier) {
      const neighbors = await query(
        `MATCH (a:Node {id: '${esc(nodeId)}'})-[r:RELATES]-(b:Node) RETURN b.id AS id`,
      );
      for (const row of neighbors as Record<string, string>[]) {
        if (!visitedNodes.has(row.id)) {
          visitedNodes.add(row.id);
          nextFrontier.add(row.id);
        }
      }
    }

    frontier = nextFrontier;
  }

  // Fetch full node data for visited nodes
  const nodeList = [...visitedNodes].map((id) => `'${esc(id)}'`).join(", ");
  const nodeRows = await query(
    `MATCH (n:Node) WHERE n.id IN [${nodeList}] RETURN n.id AS id, n.type AS type, n.name AS name, n.properties AS properties`,
  );
  const nodes: GraphNode[] = (nodeRows as Record<string, string>[]).map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    properties: parseProps(r.properties),
  }));

  // Fetch relationships between visited nodes
  const relRows = await query(
    `MATCH (a:Node)-[r:RELATES]->(b:Node) WHERE a.id IN [${nodeList}] AND b.id IN [${nodeList}] ` +
    `RETURN a.id AS source, b.id AS target, r.type AS type`,
  );
  const links: GraphLink[] = (relRows as Record<string, string>[]).map((r) => ({
    source: r.source,
    target: r.target,
    label: r.type,
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

  const edgeRows = await query(`MATCH ()-[r:RELATES]->() RETURN count(r) AS cnt`);
  const total_edges = Number((edgeRows as Record<string, number>[])[0]?.cnt ?? 0);

  const data: GraphStats = { total_nodes, total_edges, nodes_by_type };
  return { kind: "fetchStats", id, data };
}

async function handleClearGraph(id: number): Promise<KuzuResponse> {
  // Drop and recreate tables
  await conn!.execute(`DROP TABLE IF EXISTS RELATES`);
  await conn!.execute(`DROP TABLE IF EXISTS Node`);
  await createSchema();

  // Reset vector index. BM25 index entries will be overwritten on re-import
  // since addDocument handles updates. No explicit clear needed.
  vectorIndex = null;

  return { kind: "clearGraph", id };
}

function parseProps(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw || raw === "{}" || raw === "null") return undefined;
  try {
    // New format: URI-encoded JSON (contains %XX sequences, never starts with {)
    // Legacy format: raw JSON string (starts with {)
    const json = raw.includes("%") ? decodeURIComponent(raw) : raw;
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

  if (seedIds.length === 0) return { kind: "searchNodes", id, data: [] };

  // Fetch full node data
  const idList = seedIds.map((i) => `'${esc(i)}'`).join(", ");
  const nodeRows = await query(
    `MATCH (n:Node) WHERE n.id IN [${idList}] RETURN n.id AS id, n.type AS type, n.name AS name, n.properties AS properties`,
  );

  let results: NodeResult[] = (nodeRows as Record<string, string>[]).map((r) => {
    const props = parseProps(r.properties);
    return { id: r.id, type: r.type, name: r.name, ...(props && { properties: props }) };
  });

  // Filter by node types if specified
  if (nodeTypes && nodeTypes.length > 0) {
    const typeSet = new Set(nodeTypes.map((t) => t.trim()));
    results = results.filter((n) => typeSet.has(n.type));
  }

  // Preserve ranked order from seedIds
  const orderMap = new Map(seedIds.map((id, idx) => [id, idx]));
  results.sort((a, b) => (orderMap.get(a.id) ?? Infinity) - (orderMap.get(b.id) ?? Infinity));

  return { kind: "searchNodes", id, data: results.slice(0, limit) };
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
    return { id: r.id, type: r.type, name: r.name, ...(props && { properties: props }) };
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

  return { kind: "listNodes", id, data: results };
}

async function handleGetNode(id: number, nodeId: string): Promise<KuzuResponse> {
  const rows = await query(
    `MATCH (n:Node {id: '${esc(nodeId)}'}) RETURN n.id AS id, n.type AS type, n.name AS name, n.properties AS properties`,
  );

  if (rows.length === 0) return { kind: "getNode", id, data: null };

  const r = rows[0] as Record<string, string>;
  const props = parseProps(r.properties);
  const data: NodeResult = { id: r.id, type: r.type, name: r.name, ...(props && { properties: props }) };
  return { kind: "getNode", id, data };
}

async function handleTraverse(
  id: number,
  nodeId: string,
  direction: "outgoing" | "incoming" | "both",
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
        case "outgoing":
          pattern = `MATCH (a:Node {id: '${esc(currentId)}'})-[r:RELATES]->(b:Node)`;
          break;
        case "incoming":
          pattern = `MATCH (a:Node {id: '${esc(currentId)}'})<-[r:RELATES]-(b:Node)`;
          break;
        default: // both
          pattern = `MATCH (a:Node {id: '${esc(currentId)}'})-[r:RELATES]-(b:Node)`;
          break;
      }

      const relFilter = relType ? ` AND r.type = '${esc(relType)}'` : "";
      const rows = await query(
        `${pattern} WHERE true${relFilter} RETURN b.id AS id, b.type AS type, b.name AS name, b.properties AS properties, r.id AS rel_id, r.type AS rel_type, a.id AS source_id`,
      );

      for (const row of rows as Record<string, string>[]) {
        if (visited.has(row.id)) continue;
        visited.add(row.id);
        nextFrontier.add(row.id);

        const props = parseProps(row.properties);
        const node: NodeResult = { id: row.id, type: row.type, name: row.name, ...(props && { properties: props }) };

        // Determine correct source/target based on direction
        const isOutgoing = direction === "outgoing" || (direction === "both" && row.source_id === currentId);
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

  return { kind: "traverse", id, data: results };
}

// ---- Message handler ----

self.onmessage = async (e: MessageEvent<KuzuRequest>) => {
  const msg = e.data;
  let response: KuzuResponse;

  try {
    switch (msg.kind) {
      case "init":
        response = await handleInit(msg.id);
        break;
      case "fetchGraph":
        response = await handleFetchGraph(msg.id, msg.query, msg.hops, msg.queryEmbedding);
        break;
      case "fetchStats":
        response = await handleFetchStats(msg.id);
        break;
      case "clearGraph":
        response = await handleClearGraph(msg.id);
        break;
      case "importBatch":
        response = await handleImportBatch(msg.id, msg);
        break;
      case "searchNodes":
        response = await handleSearchNodes(msg.id, msg.query, msg.limit ?? 50, msg.nodeTypes, msg.queryEmbedding);
        break;
      case "listNodes":
        response = await handleListNodes(msg.id, msg.type, msg.limit ?? 50, msg.filters);
        break;
      case "getNode":
        response = await handleGetNode(msg.id, msg.nodeId);
        break;
      case "traverse":
        response = await handleTraverse(msg.id, msg.nodeId, msg.direction ?? "outgoing", msg.maxDepth ?? 3, msg.relType);
        break;
    }
  } catch (err) {
    response = {
      kind: "error",
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  self.postMessage(response);
};
