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

import type { GraphData, GraphStats } from '@opentrace/components/utils';

// ---- Shared result types ----

export interface NodeResult {
  id: string;
  type: string;
  name: string;
  properties?: Record<string, unknown>;
}

export interface TraverseRelationship {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  properties?: Record<string, unknown>;
}

export interface TraverseResult {
  node: NodeResult;
  relationship: TraverseRelationship;
  depth: number;
}

export interface ImportBatchRequest {
  nodes: {
    id: string;
    type: string;
    name: string;
    properties?: Record<string, unknown>;
    embedding?: number[];
  }[];
  relationships: {
    id: string;
    type: string;
    source_id: string;
    target_id: string;
    properties?: Record<string, unknown>;
  }[];
}

export interface ImportBatchResponse {
  nodes_created: number;
  relationships_created: number;
  errors?: string[];
}

export interface NodeSourceResponse {
  content: string;
  path: string;
  language?: string;
  start_line?: number;
  end_line?: number;
  line_count: number;
  binary?: boolean;
}

export interface SourceFile {
  id: string;
  path: string;
  content: string;
  binary?: boolean;
}

export interface IndexMetadata {
  indexedAt?: string;
  durationSeconds?: number;
  repoId?: string;
  repoPath?: string;
  sourceUri?: string;
  commitSha?: string;
  commitMessage?: string;
  branch?: string;
  opentraceaiVersion?: string;
  nodesCreated?: number;
  relationshipsCreated?: number;
  filesProcessed?: number;
  classesExtracted?: number;
  functionsExtracted?: number;
}

export interface GraphStore {
  /** True if any data has been imported (synchronous, no DB call). */
  hasData(): boolean;
  /** Start DB init if not already started. No-op if already ready. */
  ensureReady?(): Promise<void>;
  fetchGraph(query?: string, hops?: number): Promise<GraphData>;
  /** Progressive loading (LadybugStore only): the structural skeleton —
   *  nodes of the given types + edges among them. Small + fast to lay out;
   *  loaded first, before streaming the bulk via fetchGraphPage. */
  fetchGraphSkeleton?(types: string[]): Promise<GraphData>;
  /** Progressive loading (LadybugStore only): one page of a single node type
   *  plus edges connecting it to the accumulated session set (seeded by
   *  fetchGraphSkeleton, extended internally per page). `exhausted` is true
   *  once the type has no more rows past this page. */
  fetchGraphPage?(opts: {
    type: string;
    offset: number;
    limit: number;
  }): Promise<{
    nodes: GraphData['nodes'];
    links: GraphData['links'];
    exhausted: boolean;
  }>;
  fetchStats(): Promise<GraphStats>;
  fetchMetadata(): Promise<IndexMetadata[]>;
  clearGraph(): Promise<void>;
  /** Remove all data scoped to a single repo (nodes whose IDs start with the
   *  repoId, plus their relationships). Global nodes like Dependency survive.
   *  Optional: ServerGraphStore is read-only and omits this. */
  deleteRepo?(repoId: string): Promise<void>;
  setLimits?(maxNodes: number, maxEdges: number): Promise<void>;
  importBatch(batch: ImportBatchRequest): Promise<ImportBatchResponse>;
  /** Flush any buffered writes to the backing store. No-op if unbuffered. */
  flush(): Promise<void>;
  /** Import embedding vectors without re-inserting the node into typed tables. */
  importVectors?(vectors: { id: string; vec: number[] }[]): Promise<void>;
  /** Import a Parquet zip archive into the store. */
  importDatabase?(
    data: Uint8Array,
    onProgress?: (msg: string) => void,
  ): Promise<ImportBatchResponse>;
  /** Export the database as a Parquet zip archive.
   *  When repoId is provided, only nodes belonging to that repo are exported. */
  exportDatabase?(options?: {
    includeSource?: boolean;
    repoId?: string;
  }): Promise<Uint8Array>;
  /** Set an embedder instance for query-time vector search. */
  setEmbedder?(embedder: unknown): void;
  storeSource(files: SourceFile[]): void;
  fetchSource(
    nodeId: string,
    startLine?: number,
    endLine?: number,
  ): Promise<NodeSourceResponse | null>;

  // Query methods (used by chat tools)
  searchNodes(
    query: string,
    limit?: number,
    nodeTypes?: string[],
  ): Promise<NodeResult[]>;
  listNodes(
    type: string,
    limit?: number,
    filters?: Record<string, string>,
  ): Promise<NodeResult[]>;
  getNode(nodeId: string): Promise<NodeResult | null>;
  traverse(
    nodeId: string,
    direction?: 'outgoing' | 'incoming' | 'both',
    maxDepth?: number,
    relType?: string,
    options?: TraverseOptions,
  ): Promise<TraverseResult[]>;


  /** Search stored source files for exact text patterns (regex). */
  grepSource?(
    pattern: string,
    options?: {
      caseSensitive?: boolean;
      maxResults?: number;
      fileFilter?: string;
    },
  ): Promise<
    { nodeId: string; filePath: string; line: number; text: string }[]
  >;

  // --- OT-1732 retrieval primitives ---

  /** Find the shortest path between two nodes via outgoing edges. */
  findPath(
    startId: string,
    endId: string,
    maxHops?: number,
    edgeTypes?: string[],
  ): Promise<FindPathResult>;

  /** Find nodes of a type with no edges of edgeType in the given direction. */
  findOrphans(
    nodeType: string,
    edgeType: string,
    direction?: 'incoming' | 'outgoing' | 'both',
    limit?: number,
  ): Promise<FindOrphansResult>;

  /** Find all (A, B) pairs where A→[edgeType]→B. */
  findViaRelationshipToType(
    startType: string,
    edgeType: string,
    targetType: string,
    limit?: number,
  ): Promise<FindViaResult>;

  /** Count nodes of a type, optionally scoped to descendants of a parent. */
  countBy(
    nodeType: string,
    options?: {
      parentId?: string;
      parentEdge?: string;
      maxHops?: number;
    },
  ): Promise<CountByResult>;

  /** Compact orientation of the indexed graph for agent session start. */
  overview(options?: {
    topN?: number;
    vaultScope?: string;
  }): Promise<OverviewResult>;

  /** Ranked FTS search returning {id, type, name, snippet, score, vault?, recency?, confidence?}. */
  search(
    query: string,
    options?: { limit?: number; nodeTypes?: string[]; vaultScope?: string },
  ): Promise<SearchResult>;

  /** Return the provenance chain for a node (code metadata or wiki citation chain). */
  provenance(nodeId: string): Promise<ProvenanceResult>;

  /** Regex grep over the on-disk content reachable from a Repository or Vault scope. */
  grep(
    pattern: string,
    scopeId: string,
    options?: {
      fileFilter?: string;
      caseSensitive?: boolean;
      maxResults?: number;
    },
  ): Promise<GrepResult>;
}

/** OT-1732 Phase 3 traversal extensions. All optional; when set, override the
 *  legacy single-`relType` behaviour. */
export interface TraverseOptions {
  /** Allowlist of relationship types — supersedes single relType when set. */
  relTypes?: string[];
  /** Reserved for Phase 4: restrict to nodes whose vault ancestor matches. */
  vaultScope?: string;
  /** Reserved for Phase 5: skip rels with confidence below this threshold. */
  confidenceThreshold?: number;
}

export interface FindPathStep {
  node: NodeResult;
  relationship: TraverseRelationship | null;
  depth: number;
}

export interface FindPathResult {
  path: FindPathStep[] | null;
  length: number | null;
  error?: string;
}

export interface FindOrphansResult {
  orphans: { id: string; type: string; name: string }[];
  count: number;
}

export interface FindViaResult {
  pairs: { start: NodeResult; target: NodeResult }[];
  count: number;
}

export interface CountByResult {
  count: number;
  node_type: string;
  scope: string;
  error?: string;
}

export interface OverviewConcept {
  id: string;
  type: string;
  name: string;
  degree: number;
  summary: string;
}

export interface OverviewRecent {
  id: string;
  type: string;
  name: string;
  last_updated: string;
  one_line_summary: string;
}

export interface OverviewResult {
  counts_by_type: Record<string, number>;
  top_concepts: OverviewConcept[];
  recently_updated: OverviewRecent[];
  vault_scope: string | null;
}

export interface SearchHit {
  id: string;
  type: string;
  name: string;
  snippet: string;
  score: number | null;
  vault: string | null;
  recency: string | null;
  confidence: number | null;
}

export interface SearchResult {
  hits: SearchHit[];
  count: number;
  query: string;
}

export interface ProvenanceCode {
  commit_sha: string | null;
  indexer_version: string | null;
  indexed_at: string | null;
  repo_id: string | null;
  file_path: string | null;
  line_range: [number, number] | null;
}

export interface ProvenanceChainDoc {
  kind: 'knowledge_doc';
  id: string;
  sha256: string | null;
  filename: string | null;
  acquired_at: string | null;
}

/** A wiki chain is a single ``knowledge_doc`` entry: the document IS its own
 *  provenance. It was a union with a ``knowledge_concept`` variant while the
 *  concept-page layer existed and the chain was a multi-hop ``CITES`` walk;
 *  that layer was removed 2026-08-04 and nothing restates a document now. */
export type ProvenanceChainEntry = ProvenanceChainDoc;

export interface ProvenanceWiki {
  agent: string | null;
  model: string | null;
  session: string | null;
  confidence: number | null;
  vault: string | null;
  chain: ProvenanceChainEntry[];
}

export interface ProvenanceResult {
  node_id: string;
  node_type: string | null;
  kind: 'code' | 'wiki' | 'unknown';
  code: ProvenanceCode | null;
  wiki: ProvenanceWiki | null;
  error?: string;
}

export interface GrepMatch {
  node_id: string | null;
  file_path: string;
  line_number: number;
  line_text: string;
  structural_context: Record<string, unknown>;
}

export interface GrepResult {
  matches: GrepMatch[];
  count: number;
  scope: string;
  mode: 'ripgrep' | 'error';
  error?: string;
}
