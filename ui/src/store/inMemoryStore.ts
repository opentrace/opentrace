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
 * In-memory GraphStore implementation.
 *
 * Drop-in replacement for LadybugGraphStore that keeps everything in Maps.
 * No WASM, no workers, no COOP/COEP headers required.
 */

import type { GraphData, GraphStats } from '@opentrace/components/utils';
import type {
  GraphStore,
  ImportBatchRequest,
  ImportBatchResponse,
  NodeResult,
  NodeSourceResponse,
  SourceFile,
  TraverseResult,
} from './types';

// ---- Debug performance logging ----

const DEBUG_KEY = 'ot:debug';
function isDebug(): boolean {
  try {
    return localStorage.getItem(DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}
function logPerf(
  method: string,
  params: Record<string, unknown>,
  count: number,
  ms: number,
): void {
  if (!isDebug()) return;
  console.debug(
    `[InMemoryStore] ${method}(${JSON.stringify(params)}) => ${count} results in ${ms.toFixed(1)}ms`,
  );
}

// ---- Types ----

interface StoredNode {
  id: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
}

interface StoredRel {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  properties: Record<string, unknown>;
}

export class InMemoryGraphStore implements GraphStore {
  private nodes = new Map<string, StoredNode>();
  private rels = new Map<string, StoredRel>();
  /** Adjacency index: nodeId → set of outgoing relationship IDs. */
  private outgoing = new Map<string, Set<string>>();
  /** Adjacency index: nodeId → set of incoming relationship IDs. */
  private incoming = new Map<string, Set<string>>();
  private sourceCache = new Map<
    string,
    { content: string; path: string; binary?: boolean }
  >();

  hasData(): boolean {
    return this.nodes.size > 0;
  }

  async importBatch(batch: ImportBatchRequest): Promise<ImportBatchResponse> {
    const t0 = performance.now();
    let nodesCreated = 0;
    let relsCreated = 0;

    for (const n of batch.nodes) {
      const existing = this.nodes.get(n.id);
      if (existing) {
        // Merge properties into existing node (e.g. summary update)
        existing.properties = {
          ...existing.properties,
          ...(n.properties ?? {}),
        };
      } else {
        nodesCreated++;
        this.nodes.set(n.id, {
          id: n.id,
          type: n.type,
          name: n.name,
          properties: n.properties ?? {},
        });
      }
    }

    for (const r of batch.relationships) {
      if (!this.rels.has(r.id)) relsCreated++;
      this.rels.set(r.id, {
        id: r.id,
        type: r.type,
        source_id: r.source_id,
        target_id: r.target_id,
        properties: r.properties ?? {},
      });

      // Maintain adjacency indexes
      let outSet = this.outgoing.get(r.source_id);
      if (!outSet) {
        outSet = new Set();
        this.outgoing.set(r.source_id, outSet);
      }
      outSet.add(r.id);

      let inSet = this.incoming.get(r.target_id);
      if (!inSet) {
        inSet = new Set();
        this.incoming.set(r.target_id, inSet);
      }
      inSet.add(r.id);
    }

    const result = {
      nodes_created: nodesCreated,
      relationships_created: relsCreated,
    };
    logPerf(
      'importBatch',
      { nodes: batch.nodes.length, rels: batch.relationships.length },
      nodesCreated + relsCreated,
      performance.now() - t0,
    );
    return result;
  }

  async flush(): Promise<void> {
    // No-op — writes are immediate.
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
    if (startLine != null && endLine != null) {
      const sliced = allLines.slice(startLine - 1, endLine);
      return {
        content: sliced.join('\n'),
        path: entry.path,
        start_line: startLine,
        end_line: endLine,
        line_count: allLines.length,
      };
    }

    return {
      content: entry.content,
      path: entry.path,
      line_count: allLines.length,
    };
  }

  async fetchGraph(query?: string): Promise<GraphData> {
    const t0 = performance.now();
    let matchingNodes;
    if (!query) {
      matchingNodes = [...this.nodes.values()];
    } else if (query.startsWith('type:')) {
      const typeName = query.slice(5);
      matchingNodes = [...this.nodes.values()].filter(
        (n) => n.type.toLowerCase() === typeName.toLowerCase(),
      );
    } else {
      matchingNodes = [...this.nodes.values()].filter(
        (n) =>
          n.name.toLowerCase().includes(query.toLowerCase()) ||
          n.id.toLowerCase().includes(query.toLowerCase()),
      );
    }

    // Use adjacency index to find links between matched nodes
    const nodeIds = new Set(matchingNodes.map((n) => n.id));
    const links = [];
    for (const nid of nodeIds) {
      for (const rid of this.outgoing.get(nid) ?? []) {
        const rel = this.rels.get(rid)!;
        if (nodeIds.has(rel.target_id)) {
          links.push({
            source: rel.source_id,
            target: rel.target_id,
            label: rel.type,
            properties: rel.properties,
          });
        }
      }
    }

    const data = {
      nodes: matchingNodes.map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        properties: n.properties,
      })),
      links,
    };
    logPerf('fetchGraph', { query }, data.nodes.length, performance.now() - t0);
    return data;
  }

  async fetchStats(): Promise<GraphStats> {
    const t0 = performance.now();
    const byType: Record<string, number> = {};
    for (const n of this.nodes.values()) {
      byType[n.type] = (byType[n.type] ?? 0) + 1;
    }
    const result = {
      total_nodes: this.nodes.size,
      total_edges: this.rels.size,
      nodes_by_type: byType,
    };
    logPerf('fetchStats', {}, this.nodes.size, performance.now() - t0);
    return result;
  }

  async fetchMetadata(): Promise<import('./types').IndexMetadata[]> {
    const entries: import('./types').IndexMetadata[] = [];
    for (const node of this.nodes.values()) {
      if (node.type === 'IndexMetadata' && node.properties) {
        entries.push(node.properties as import('./types').IndexMetadata);
      }
    }
    return entries;
  }

  async clearGraph(): Promise<void> {
    this.nodes.clear();
    this.rels.clear();
    this.outgoing.clear();
    this.incoming.clear();
    this.sourceCache.clear();
  }

  async searchNodes(
    query: string,
    limit = 50,
    nodeTypes?: string[],
  ): Promise<NodeResult[]> {
    const t0 = performance.now();
    const q = query.toLowerCase();
    const results: NodeResult[] = [];

    for (const n of this.nodes.values()) {
      if (nodeTypes && !nodeTypes.includes(n.type)) continue;
      if (n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) {
        results.push({
          id: n.id,
          type: n.type,
          name: n.name,
          properties: n.properties,
        });
        if (results.length >= limit) break;
      }
    }

    logPerf(
      'searchNodes',
      { query, limit, nodeTypes },
      results.length,
      performance.now() - t0,
    );
    return results;
  }

  async listNodes(
    type: string,
    limit = 100,
    filters?: Record<string, string>,
  ): Promise<NodeResult[]> {
    const t0 = performance.now();
    const results: NodeResult[] = [];

    for (const n of this.nodes.values()) {
      if (n.type !== type) continue;
      if (filters) {
        let match = true;
        for (const [k, v] of Object.entries(filters)) {
          if (String(n.properties[k] ?? '') !== v) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }
      results.push({
        id: n.id,
        type: n.type,
        name: n.name,
        properties: n.properties,
      });
      if (results.length >= limit) break;
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
    const n = this.nodes.get(nodeId);
    if (!n) {
      logPerf('getNode', { nodeId }, 0, performance.now() - t0);
      return null;
    }
    logPerf('getNode', { nodeId }, 1, performance.now() - t0);
    return { id: n.id, type: n.type, name: n.name, properties: n.properties };
  }

  async traverse(
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'outgoing',
    maxDepth = 1,
    relType?: string,
  ): Promise<TraverseResult[]> {
    const t0 = performance.now();
    const results: TraverseResult[] = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [
      { id: nodeId, depth: 0 },
    ];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;
      if (visited.has(id)) continue;
      visited.add(id);

      // Collect relevant relationship IDs from adjacency indexes
      const relIds: string[] = [];
      if (direction === 'outgoing' || direction === 'both') {
        for (const rid of this.outgoing.get(id) ?? []) relIds.push(rid);
      }
      if (direction === 'incoming' || direction === 'both') {
        for (const rid of this.incoming.get(id) ?? []) relIds.push(rid);
      }

      for (const rid of relIds) {
        const rel = this.rels.get(rid)!;
        if (relType && rel.type !== relType) continue;

        const neighborId = rel.source_id === id ? rel.target_id : rel.source_id;
        if (visited.has(neighborId)) continue;

        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;

        results.push({
          node: {
            id: neighbor.id,
            type: neighbor.type,
            name: neighbor.name,
            properties: neighbor.properties,
          },
          relationship: {
            id: rel.id,
            type: rel.type,
            source_id: rel.source_id,
            target_id: rel.target_id,
            properties: rel.properties,
          },
          depth: depth + 1,
        });

        queue.push({ id: neighborId, depth: depth + 1 });
      }
    }

    logPerf(
      'traverse',
      { nodeId, direction, maxDepth, relType },
      results.length,
      performance.now() - t0,
    );
    return results;
  }
}
