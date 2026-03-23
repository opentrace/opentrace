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

export interface GraphStore {
  /** True if any data has been imported (synchronous, no DB call). */
  hasData(): boolean;
  /** Start DB init if not already started. No-op if already ready. */
  ensureReady?(): Promise<void>;
  fetchGraph(query?: string, hops?: number): Promise<GraphData>;
  fetchStats(): Promise<GraphStats>;
  clearGraph(): Promise<void>;
  setLimits?(maxNodes: number, maxEdges: number): Promise<void>;
  importBatch(batch: ImportBatchRequest): Promise<ImportBatchResponse>;
  /** Flush any buffered writes to the backing store. No-op if unbuffered. */
  flush(): Promise<void>;
  /** Import a Parquet zip archive into the store. */
  importDatabase?(
    data: Uint8Array,
    onProgress?: (msg: string) => void,
  ): Promise<ImportBatchResponse>;
  /** Export the database as a Parquet zip archive. */
  exportDatabase?(): Promise<Uint8Array>;
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
  ): Promise<TraverseResult[]>;
}
